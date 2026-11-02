import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, schemaLockDigest } from "../src/canonical.js";
import { validateSchemaLock } from "../src/schema-lock.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(
  testDirectory,
  "fixtures",
  "schema-lock-digest-vector.json",
);
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "schema-lock-digest-reference.mjs",
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

test("matches the fixed Schema lock digest vector and order boundary", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  validateSchemaLock(vector.schemaLock);

  const canonical = canonicalJson(vector.schemaLock);
  assert.equal(canonical, vector.expected.canonicalJson);
  assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
  assert.equal(schemaLockDigest(vector.schemaLock), vector.expected.digest);

  const reordered = reverseMappingOrder(vector.schemaLock);
  validateSchemaLock(reordered);
  assert.equal(canonicalJson(reordered), vector.expected.canonicalJson);
  assert.equal(schemaLockDigest(reordered), vector.expected.digest);

  const unsorted = structuredClone(vector.schemaLock);
  unsorted.schemas.unshift({
    schemaId: "morivyx.extra",
    version: "0.1",
    digest: `sha256:${"1".repeat(64)}`,
  });
  assert.throws(
    () => validateSchemaLock(unsorted),
    (error) => error?.code === "SCHEMA_LOCK_ORDER_INVALID",
  );
});

test("matches an independent Schema lock digest implementation", async () => {
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
  assert.equal(actual.canonicalJson, canonicalJson(vector.schemaLock));
  assert.equal(actual.digest, schemaLockDigest(vector.schemaLock));
});
