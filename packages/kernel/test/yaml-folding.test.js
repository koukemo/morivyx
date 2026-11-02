import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";
import { yamlFoldingCases } from "../test-support/yaml-folding-cases.mjs";

for (const accepted of [true, false]) test(accepted ? "quoted line folding preserves explicit expected logical values" : "invalid folded spellings remain refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-folding-"));
  try {
    for (const row of yamlFoldingCases().filter(row => row.accepted === accepted)) {
      const path = join(directory, "record.yaml");
      await writeFile(path, row.source);
      if (accepted) assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      else if (/surrogate|unit-escape/.test(row.name) && !row.name.includes("-implicit-key-")) await assert.rejects(readYamlRecord(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" }, row.name);
      else await assert.rejects(readYamlRecord(path), error => typeof error.code === "string" && error.code.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source, row.name);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
