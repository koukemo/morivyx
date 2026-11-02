import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYamlRecord } from "../src/yaml-reader.js";

test("explicit scalar keys preserve quoted values, containers and Unicode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-explicit-valid-"));
  try {
    const examples = [
      ['? "key"\n: "value"\n', { key: "value" }],
      ['?\n  "key"\n: "value"\n', { key: "value" }],
      ['? "first\n  second"\n: "value"\n', { "first second": "value" }],
      ["? 'first\n  second'\n: \"value\"\n", { "first second": "value" }],
      ['? first\n\n  second\n: "value"\n', { "first\nsecond": "value" }],
      ['items:\n  - ? "😀"\n    : "? text : text"\n', { items: [{ "😀": "? text : text" }] }],
      ['ordinary: "? key\\n: value"\n', { ordinary: "? key\n: value" }],
    ];
    for (const [source, expected] of examples) {
      const path = join(directory, "record.yaml");
      await writeFile(path, source);
      assert.deepEqual(await readYamlRecord(path), expected);
      assert.equal(await readFile(path, "utf8"), source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("misaligned explicit key and value indicators are rejected without changing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-explicit-invalid-"));
  try {
    for (const rootIndent of [0, 2, 5]) {
      for (const extra of [1, 2, 4]) {
        for (const source of [
          '? "😀"\n' + " ".repeat(extra) + ': "value"\n',
          'outer:\n  ? "key"\n' + " ".repeat(extra + 2) + ': "value"\n',
          'outer:\n  - ? "key"\n' + " ".repeat(extra + 4) + ': "value"\n',
        ]) {
          const indented = source.split("\n").slice(0, -1).map(line => " ".repeat(rootIndent) + line).join("\n") + "\n";
          const path = join(directory, "record.yaml");
          await writeFile(path, indented);
          await assert.rejects(readYamlRecord(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" });
          assert.equal(await readFile(path, "utf8"), indented);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
