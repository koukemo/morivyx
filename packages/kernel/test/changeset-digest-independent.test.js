import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical.js";
import { changeSetDigest, validateChangeSet } from "../src/changeset.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(testDirectory, "fixtures", "changeset-digest-vector.json");
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "changeset-digest-reference.mjs",
);

function changeSetCanonicalJson(changeSet) {
  const { id: _id, ...content } = changeSet;
  return canonicalJson(content);
}

test("matches the fixed ChangeSet digest vector", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));
  for (const { changeSet, equivalent } of vector.cases) {
    validateChangeSet(changeSet);
    const canonical = changeSetCanonicalJson(changeSet);
    if (equivalent) {
      assert.equal(canonical, vector.expected.canonicalJson);
      assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
      assert.equal(changeSetDigest(changeSet), vector.expected.digest);
    } else {
      assert.notEqual(canonical, vector.expected.canonicalJson);
      assert.notEqual(changeSetDigest(changeSet), vector.expected.digest);
    }
  }
});

test("matches an independent ChangeSet digest implementation", async () => {
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
  assert.equal(actual.length, vector.cases.length);
  for (let index = 0; index < vector.cases.length; index += 1) {
    const { name, changeSet, equivalent } = vector.cases[index];
    const expected = {
      name,
      canonicalByteLength: Buffer.byteLength(changeSetCanonicalJson(changeSet)),
      canonicalJson: changeSetCanonicalJson(changeSet),
      digest: changeSetDigest(changeSet),
    };
    assert.deepEqual(actual[index], expected);
    if (equivalent) {
      assert.deepEqual(actual[index], { name, ...vector.expected });
    } else {
      assert.notEqual(actual[index].digest, vector.expected.digest);
    }
  }
});
