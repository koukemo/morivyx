import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";
import { yamlKeyStyleCases } from "../test-support/yaml-key-style-cases.mjs";

for (const accepted of [false, true]) test(accepted ? "quoted scalar keys retain their logical values" : "block scalar keys are forbidden in every container", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-key-style-"));
  try {
    for (const row of yamlKeyStyleCases().filter(row => row.accepted === accepted)) {
      const path = join(directory, "record.yaml");
      await writeFile(path, row.source);
      if (accepted) assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      else await assert.rejects(readYamlRecord(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" }, row.name);
      assert.equal(await readFile(path, "utf8"), row.source);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
