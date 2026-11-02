import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";

test("implicit key lengths count source Unicode characters rather than UTF-16 units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-key-limit-valid-"));
  try {
    for (const [token, key, spaces] of [
      ["😀".repeat(1024), "😀".repeat(1024), 0],
      ['"' + "😀".repeat(1022) + '"', "😀".repeat(1022), 0],
      ["'" + "😀".repeat(1022) + "'", "😀".repeat(1022), 0],
      ["a".repeat(1024), "a".repeat(1024), 0],
      ["日".repeat(1024), "日".repeat(1024), 0],
      ["👩‍💻".repeat(341), "👩‍💻".repeat(341), 1],
      ["key", "key", 1021],
    ]) {
      const source = `outer:\n  - ${token}${" ".repeat(spaces)}: "value"\n`;
      const path = join(directory, "record.yaml");
      await writeFile(path, source);
      assert.deepEqual(await readYamlRecord(path), { outer: [{ [key]: "value" }] });
      assert.equal(await readFile(path, "utf8"), source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("genuinely oversized source spellings still fail before normalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-key-limit-invalid-"));
  try {
    for (const [token, spaces] of [
      ["a".repeat(1025), 0], ["😀".repeat(1025), 0],
      ['"' + "a".repeat(1023) + '"', 0],
      ['"' + "😀".repeat(1023) + '"', 0],
      ['"' + "\\uD83D\\uDE00".repeat(86) + '"', 0],
      ["é" + "a".repeat(1023), 0], ["key", 1022],
    ]) {
      const source = token + " ".repeat(spaces) + ': "value"\n';
      const path = join(directory, "record.yaml");
      await writeFile(path, source);
      await assert.rejects(readYamlRecord(path), { code: "PACKAGE_YAML_INVALID" });
      assert.equal(await readFile(path, "utf8"), source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("correcting one Unicode key length never suppresses other YAML or profile failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-key-limit-errors-"));
  const token = "😀".repeat(600);
  try {
    for (const [source, code] of [
      [`${token}: "one"\n${token}: "two"\n`, "PACKAGE_YAML_INVALID"],
      [`${token}: "one"\n${"a".repeat(1025)}: "two"\n`, "PACKAGE_YAML_INVALID"],
      [`${token}: plain\n`, "PACKAGE_AUTHORING_PROFILE_INVALID"],
      [`${token}: "value"\n? "other"\n  : "bad indent"\n`, "PACKAGE_AUTHORING_PROFILE_INVALID"],
      [`"${token}\n  end": "value"\n`, "PACKAGE_YAML_INVALID"],
      [`value: [ ${token}: "value" ]\n`, "PACKAGE_YAML_INVALID"],
      [`!tag ${token}: "value"\n`, "PACKAGE_YAML_INVALID"],
    ]) {
      const path = join(directory, "record.yaml");
      await writeFile(path, source);
      await assert.rejects(readYamlRecord(path), { code });
      assert.equal(await readFile(path, "utf8"), source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
