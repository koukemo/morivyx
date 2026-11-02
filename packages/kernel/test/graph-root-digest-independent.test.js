import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, graphRootDigest } from "../src/canonical.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(
  testDirectory,
  "fixtures",
  "graph-root-digest-vector.json",
);
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "graph-root-digest-reference.mjs",
);

test("matches the fixed Graph root digest vector and projection boundary", async () => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));

  const canonical = canonicalJson(vector.rootPairs);
  assert.equal(canonical, vector.expected.canonicalJson);
  assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
  assert.equal(graphRootDigest(vector.elements), vector.expected.digest);
  assert.equal(
    graphRootDigest(vector.elements.toReversed()),
    vector.expected.digest,
  );

  const nonRootChange = structuredClone(vector.elements);
  nonRootChange[0].nonRootValue = "changed-but-ignored";
  assert.equal(graphRootDigest(nonRootChange), vector.expected.digest);

  const idChange = structuredClone(vector.elements);
  idChange[0].id = "urn:uuid:550e8400-e29b-41d4-a716-446655440003";
  assert.notEqual(graphRootDigest(idChange), vector.expected.digest);

  const revisionChange = structuredClone(vector.elements);
  revisionChange[0].revision = `sha256:${"3".repeat(64)}`;
  assert.notEqual(graphRootDigest(revisionChange), vector.expected.digest);
});

test("matches an independent Graph root digest implementation", async () => {
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
  assert.equal(actual.canonicalJson, canonicalJson(vector.rootPairs));
  assert.equal(actual.digest, graphRootDigest(vector.elements));
});
