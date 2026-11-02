import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";
import { yamlSequenceSpacingCases } from "../test-support/yaml-sequence-spacing-cases.mjs";

test("sequence separator widths preserve explicit values and compact indentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-sequence-spacing-"));
  try {
    const rows = yamlSequenceSpacingCases();
    assert.equal(new Set(rows.map(row => row.source)).size, rows.length);
    for (const row of rows) {
      const path = join(root, "record.yaml"); await writeFile(path, row.source);
      if (row.accepted) assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      else await assert.rejects(readYamlRecord(path), error => error.code?.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source, row.name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
