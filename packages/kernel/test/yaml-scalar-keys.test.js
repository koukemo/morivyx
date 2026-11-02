import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";
import { yamlScalarKeyCases } from "../test-support/yaml-scalar-key-cases.mjs";

test("plain scalar keys follow exact Core spellings without widening value syntax", async () => {
  const rows = yamlScalarKeyCases();
  assert.equal(new Set(rows.map(row => row.source)).size, rows.length);
  const directory = await mkdtemp(join(tmpdir(), "morivyx-scalar-keys-"));
  try {
    const path = join(directory, "record.yaml");
    for (const row of rows) {
      await writeFile(path, row.source);
      if (row.accepted) assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      else await assert.rejects(readYamlRecord(path), error => error.code?.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
