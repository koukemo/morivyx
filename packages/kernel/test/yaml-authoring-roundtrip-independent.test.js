import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";
import {
  readYamlReference,
  writeYamlReference,
} from "../test-support/yaml-authoring-roundtrip-reference.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const inputPath = join(
  testDirectory,
  "fixtures/package-v1/.morivyx/graph/entities/550e8400-e29b-41d4-a716-446655440000.yaml",
);
const expectedPath = join(
  testDirectory,
  "fixtures/yaml-authoring-roundtrip-expected.yaml",
);
const vectorPath = join(
  testDirectory,
  "fixtures/yaml-authoring-roundtrip-vector.json",
);

async function fixedInputs() {
  const [inputYaml, expectedYaml, vectorSource] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(expectedPath, "utf8"),
    readFile(vectorPath, "utf8"),
  ]);
  return { inputYaml, expectedYaml, vector: JSON.parse(vectorSource) };
}

async function readWithProduct(source) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-reference-"));
  const path = join(directory, "record.yaml");
  try {
    await writeFile(path, source, "utf8");
    return await readYamlRecord(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads the fixed YAML as the same logical value independently", async () => {
  const { inputYaml, vector } = await fixedInputs();

  assert.deepEqual(await readWithProduct(inputYaml), vector.inputLogicalValue);
  assert.deepEqual(readYamlReference(inputYaml), vector.inputLogicalValue);
});

test("writes the fixed logical value as identical YAML bytes independently", async () => {
  const { expectedYaml, vector } = await fixedInputs();

  assert.equal(serializeYamlRecord(vector.inputLogicalValue), expectedYaml);
  assert.equal(writeYamlReference(vector.inputLogicalValue), expectedYaml);
});

test("keeps the independent read-write result stable and lossless", async () => {
  const { expectedYaml, vector } = await fixedInputs();
  const reparsed = readYamlReference(expectedYaml);

  assert.deepEqual(reparsed, vector.outputLogicalValue);
  assert.equal(writeYamlReference(reparsed), expectedYaml);
  assert.deepEqual(
    reparsed.extensions["example.test/unknown"],
    vector.outputLogicalValue.extensions["example.test/unknown"],
  );
  assert.deepEqual(await readWithProduct(expectedYaml), vector.outputLogicalValue);
});
