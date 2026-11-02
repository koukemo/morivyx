import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, revisionId } from "../src/canonical.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/graph-package-roundtrip-vector.json", import.meta.url))).inputLogicalValue.elements[0];
const controls = [...Array.from({ length: 32 }, (_, index) => index), ...Array.from({ length: 33 }, (_, index) => index + 0x7f), 0xfffe, 0xffff];
const forbiddenPlain = controls.filter((point) => point >= 0x7f && point !== 0x85);

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-characters-"));
  const path = join(directory, "record.yaml");
  try { await run(async (source) => { await writeFile(path, source); return readYamlRecord(path); }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("raw C0 controls are rejected in quoted values, quoted keys and plain keys", async () => temporary(async (read) => {
  for (let point = 0; point < 32; point += 1) {
    if (point === 10) continue;
    const c = String.fromCodePoint(point);
    for (const source of [`field: "a${c}b"\n`, `"a${c}b": "value"\n`, `a${c}b: "value"\n`, `field${c}: "value"\n`]) {
      await assert.rejects(read(source), (error) => error.code === "PACKAGE_AUTHORING_PROFILE_INVALID");
    }
  }
}));

test("quoted non-C0 characters remain readable while plain keys follow printable ranges", async () => temporary(async (read) => {
  for (const point of forbiddenPlain) {
    const c = String.fromCodePoint(point);
    assert.deepEqual(await read(`field: "a${c}b"\n`), { field: `a${c}b` });
    assert.deepEqual(await read(`"a${c}b": "value"\n`), { [`a${c}b`]: "value" });
    await assert.rejects(read(`a${c}b: "value"\n`), (error) => error.code === "PACKAGE_AUTHORING_PROFILE_INVALID");
  }
  for (const point of [0x85, 0xa0, 0x2028, 0x2029, 0x1fffe, 0x10ffff]) {
    const c = String.fromCodePoint(point);
    assert.deepEqual(await read(`a${c}b: "a${c}b"\n`), { [`a${c}b`]: `a${c}b` });
  }
}));

test("writers escape nonprintable logical keys and values without changing canonical bytes or revisions", async () => temporary(async (read) => {
  for (const point of controls) {
    const c = String.fromCodePoint(point);
    const record = { ...sample, attributes: { [`a${c}b`]: `\\a${c}b\\` } };
    const source = serializeYamlRecord(record);
    assert.doesNotMatch(source, /[\x00-\x09\x0b-\x1f\x7f-\x9f\ufffe\uffff]/u);
    const decoded = await read(source);
    assert.equal(canonicalJson(decoded), canonicalJson(record));
    assert.equal(revisionId(decoded), revisionId(record));
  }
}));
