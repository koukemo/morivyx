import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical.js";
import { migrationDigest, validateMigration } from "../src/migration.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(testDirectory, "fixtures", "migration-digest-vector.json");
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "migration-digest-reference.mjs",
);

function migrationCanonicalJson(migration) {
  const { id: _id, ...content } = migration;
  return canonicalJson(content);
}

test("matches the fixed Migration digest vector", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  for (const { migration } of vector.cases) {
    validateMigration(migration);
    const canonical = migrationCanonicalJson(migration);
    assert.equal(canonical, vector.expected.canonicalJson);
    assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
    assert.equal(migrationDigest(migration), vector.expected.digest);
  }
});

test("matches an independent Migration digest implementation", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  const source = await readFile(referenceImplementationPath, "utf8");
  assert.doesNotMatch(source, /(?:\.\.\/)+src\//);

  const result = spawnSync(
    process.execPath,
    [referenceImplementationPath, vectorPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    vector.cases.map(({ name }) => ({ name, ...vector.expected })),
  );
});
