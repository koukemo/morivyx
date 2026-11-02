import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateChangeSet } from "../src/changeset.js";
import { readGraphPackage } from "../src/package-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const fixtures = new URL("./fixtures/", import.meta.url);
const vector = JSON.parse(await readFile(new URL("graph-package-roundtrip-vector.json", fixtures), "utf8"));
const change = vector.inputLogicalValue.changeSets[0];
const targetId = change.operations[0].targetId, digest = "sha256:" + "a".repeat(64);
function operation(op) {
  return { op, targetId,
    ...(["create", "revise", "replace"].includes(op) ? { afterRevision: digest } : {}),
    ...(["revise", "retire", "replace"].includes(op) ? { beforeRevision: digest } : {}),
    ...(op === "replace" ? { replacementId: targetId.slice(0,-1) + (targetId.endsWith("1") ? "2" : "1") } : {}),
  };
}
test("rejects non-string operation names before property-key coercion", async t => {
  for (const op of ["create", "revise", "retire", "replace", "revoke"]) {
    for (const value of [[op], [[op]]]) {
      await t.test(JSON.stringify(value), () => {
        const valueToCheck = { ...change, operations: [{ ...operation(op), op: value }] };
        const before = structuredClone(valueToCheck);
        assert.throws(() => validateChangeSet(valueToCheck), error => error.code === "CHANGESET_INVALID" && error.path === "/operations/0/op");
        assert.deepEqual(valueToCheck, before);
      });
    }
  }
  for (const value of [[], {}, false, true, 0, 1, null, undefined]) {
    await t.test(`invalid ${JSON.stringify(value)}`, () => {
      const item = { ...operation("create"), op: value };
      if (value === undefined) delete item.op;
      assert.throws(() => validateChangeSet({ ...change, operations: [item] }), error => error.code === "CHANGESET_INVALID" && error.path === "/operations/0/op");
    });
  }
});
test("preserves all valid operations, required and forbidden fields, and revoke isolation", () => {
  for (const op of ["create", "revise", "retire", "replace", "revoke"]) {
    const value = { ...change, operations: [operation(op)] };
    assert.equal(validateChangeSet(value), value);
  }
  assert.throws(() => validateChangeSet({ ...change, operations: [{ op: "create", targetId }] }), error => error.path === "/operations/0/afterRevision");
  assert.throws(() => validateChangeSet({ ...change, operations: [{ ...operation("create"), beforeRevision: digest }] }), error => error.path === "/operations/0/beforeRevision");
  assert.throws(() => validateChangeSet({ ...change, operations: [operation("create"), operation("revoke")] }), error => error.path === "/operations");
});
test("package reader and CLI reject an authoring-valid array operation without mutation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-operation-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sources = {};
  for (const path of vector.inputFiles) {
    let source = await readFile(new URL(`${vector.inputRoot}/${path}`, fixtures), "utf8");
    if (path === `ledger/${change.id.slice(9)}.yaml`) {
      const malformed = structuredClone(change);
      malformed.operations[0].op = [malformed.operations[0].op];
      source = serializeYamlRecord(malformed);
    }
    const target = join(directory, ".morivyx", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    sources[target] = source;
  }
  await assert.rejects(readGraphPackage(directory), error => error.code === "CHANGESET_INVALID" && error.path.endsWith("#/operations/0/op"));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "validate", directory], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.issues[0].code, "CHANGESET_INVALID");
  for (const [path, source] of Object.entries(sources)) assert.equal(await readFile(path, "utf8"), source);
});
