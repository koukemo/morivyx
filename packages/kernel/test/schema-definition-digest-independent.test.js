import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  schemaDefinitionDigest,
} from "../src/canonical.js";
import { validateSchemaDefinition } from "../src/schema-definition.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(
  testDirectory,
  "fixtures",
  "schema-definition-digest-vector.json",
);
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "schema-definition-digest-reference.mjs",
);

function reverseMappingOrder(value) {
  if (Array.isArray(value)) {
    return value.map(reverseMappingOrder);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseMappingOrder(child)]),
  );
}

test("matches the fixed Schema definition digest vector and order boundary", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  validateSchemaDefinition(vector.schemaDefinition);

  const canonical = canonicalJson(vector.schemaDefinition);
  assert.equal(canonical, vector.expected.canonicalJson);
  assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
  assert.equal(schemaDefinitionDigest(vector.schemaDefinition), vector.expected.digest);

  const reordered = reverseMappingOrder(vector.schemaDefinition);
  validateSchemaDefinition(reordered);
  assert.equal(canonicalJson(reordered), vector.expected.canonicalJson);
  assert.equal(schemaDefinitionDigest(reordered), vector.expected.digest);

  const unsorted = structuredClone(vector.schemaDefinition);
  unsorted.entityTypes[0].requiredAttributes.reverse();
  assert.throws(
    () => validateSchemaDefinition(unsorted),
    /Unicode昇順かつ重複なし/,
  );
});

test("matches an independent Schema definition digest implementation", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const source = await readFile(referenceImplementationPath, "utf8");
  assert.doesNotMatch(source, /(?:\.\.\/)+src\//);

  const result = spawnSync(
    process.execPath,
    [referenceImplementationPath, vectorPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual, vector.expected);
  assert.equal(actual.canonicalJson, canonicalJson(vector.schemaDefinition));
  assert.equal(actual.digest, schemaDefinitionDigest(vector.schemaDefinition));
});
