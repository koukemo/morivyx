import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, revisionId } from "../src/canonical.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(testDirectory, "fixtures", "revision-id-vector.json");
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "revision-id-reference.mjs",
);

function contentWithoutRevision(element) {
  return Object.fromEntries(
    Object.entries(element).filter(([key]) => key !== "revision"),
  );
}

test("matches the fixed Revision ID vector and normalization boundaries", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));

  for (const { element } of vector.cases) {
    const canonical = canonicalJson(contentWithoutRevision(element));
    assert.equal(canonical, vector.expected.canonicalJson);
    assert.equal(
      Buffer.byteLength(canonical),
      vector.expected.canonicalByteLength,
    );
    assert.equal(revisionId(element), vector.expected.digest);
  }

  const revisionChange = structuredClone(vector.cases[0].element);
  revisionChange.revision = `sha256:${"f".repeat(64)}`;
  assert.equal(revisionId(revisionChange), vector.expected.digest);

  const attributeChange = structuredClone(vector.cases[0].element);
  attributeChange.attributes.stringValues[2] = "changed";
  assert.notEqual(revisionId(attributeChange), vector.expected.digest);

  const extensionChange = structuredClone(vector.cases[0].element);
  extensionChange.extensions["example.test/unknown"].ordered.reverse();
  assert.notEqual(revisionId(extensionChange), vector.expected.digest);
});

test("matches an independent Revision ID implementation", async () => {
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
  assert.deepEqual(
    actual,
    vector.cases.map(({ name }) => ({ name, ...vector.expected })),
  );
  for (const { element } of vector.cases) {
    assert.equal(revisionId(element), vector.expected.digest);
  }
});
