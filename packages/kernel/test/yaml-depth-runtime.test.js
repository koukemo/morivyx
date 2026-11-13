import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeYamlLogicalValue } from "../src/yaml-authoring-profile.js";
import { readYamlRecord } from "../src/yaml-reader.js";

const { cases } = JSON.parse(await readFile(new URL("./fixtures/yaml-depth-runtime-vectors.json", import.meta.url)));
const runner = fileURLToPath(new URL("./fixtures/yaml-depth-runtime-runner.mjs", import.meta.url));
for (const vector of cases) {
  for (const operation of ["read", "write"]) {
    test(`${vector.id}: ${operation} in a fresh default-stack process`, () => {
      const result = spawnSync(process.execPath, [runner, vector.id, operation], {
        encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const observation = JSON.parse(result.stdout.trim());
      assert.equal(observation.accepted, true);
      assert.equal(observation.depth, vector.depth);
      assert.equal(observation.freshProcess, true);
      assert.deepEqual(observation.execArgv, []);
    });
  }
}

test("the exported normalizer preserves sparse array behavior and literal mapping keys", () => {
  const array = new Array(4);
  array[1] = "e\u0301";
  array.extra = "ignored";
  const normalized = normalizeYamlLogicalValue(array);
  assert.equal(normalized.length, 4);
  assert.deepEqual(Object.keys(normalized), ["1"]);
  assert.equal(normalized[1], "é");
  const value = normalizeYamlLogicalValue(JSON.parse('{"__proto__":{"e\\u0301":"e\\u0301"}}'));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.equal(value.__proto__.é, "é");
});

test("deep authoring errors keep their code and exact logical path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-depth-invalid-"));
  const path = join(directory, "record.yaml");
  const depth = 256;
  const chain = Array.from({ length: depth }, (_, i) => " ".repeat(4 + i * 2) + "probe:\n").join("");
  const prefix = 'format: "morivyx.git-graph/0.1"\nextensions:\n  deep:\n' + chain;
  const indent = " ".repeat(4 + depth * 2);
  const pointer = "/extensions/deep" + "/probe".repeat(depth);
  const cases = [
    { tail: `${indent}leaf: plain\n`, code: "PACKAGE_AUTHORING_PROFILE_INVALID", pointer: pointer + "/leaf" },
    { tail: `${indent}leaf: *missing\n`, code: "PACKAGE_AUTHORING_PROFILE_INVALID", pointer: pointer + "/leaf" },
    { tail: `${indent}leaf: !unknown "value"\n`, code: "PACKAGE_AUTHORING_PROFILE_INVALID", pointer: pointer + "/leaf" },
    { tail: `${indent}leaf: [1, 2]\n`, code: "PACKAGE_AUTHORING_PROFILE_INVALID", pointer: pointer + "/leaf" },
    { tail: `${indent}é: 1\n${indent}é: 2\n`, code: "PACKAGE_AUTHORING_PROFILE_INVALID", pointer },
    { tail: `${indent}b: 1\n${indent}a: 2\n`, code: "PACKAGE_AUTHORING_ORDER_INVALID", pointer: pointer + "/a" },
  ];
  try {
    for (const vector of cases) {
      await writeFile(path, prefix + vector.tail);
      await assert.rejects(readYamlRecord(path), (error) => {
        assert.equal(error.code, vector.code);
        assert.equal(error.path, path + "#" + vector.pointer);
        return true;
      });
    }
    const key = "😀".repeat(513);
    await writeFile(path, prefix + `${indent}${key}: "é"\n`);
    let value = (await readYamlRecord(path)).extensions.deep;
    for (let i = 0; i < depth; i++) value = value.probe;
    assert.deepEqual(Object.keys(value), [key]);
    assert.equal(value[key], "é");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
