import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  semanticDiffCanonicalJson,
  semanticDiffDigest,
} from "../src/semantic-diff.js";
import { validateReport } from "../src/report.js";
import {
  traceReportCanonicalJson,
  traceReportDigest,
} from "../src/trace-query.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "report-digest-reference.mjs",
);

const vectorPath = (name) => join(testDirectory, "fixtures", name);

async function loadVector(name) {
  return JSON.parse(await readFile(vectorPath(name), "utf8"));
}

function assertFixedVector(vector, canonicalJson, reportDigest) {
  for (const { report } of vector.cases) {
    const canonical = canonicalJson(report);
    assert.equal(canonical, vector.expected.canonicalJson);
    assert.equal(Buffer.byteLength(canonical), vector.expected.canonicalByteLength);
    assert.equal(reportDigest(report), vector.expected.digest);
  }
}

function assertIndependent(kind, name, vector, source) {
  assert.doesNotMatch(source, /(?:\.\.\/)+src\//);
  const result = spawnSync(
    process.execPath,
    [referenceImplementationPath, kind, vectorPath(name)],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    vector.cases.map(({ name: caseName }) => ({
      name: caseName,
      ...vector.expected,
    })),
  );
}

test("matches the fixed semantic diff digest vector and boundaries", async () => {
  const vector = await loadVector("semantic-diff-digest-vector.json");
  assertFixedVector(vector, semanticDiffCanonicalJson, semanticDiffDigest);
  assert.equal(validateReport(vector.cases[1].report).type, "semantic-diff");

  const changed = structuredClone(vector.cases[0].report);
  changed.targetRevision = "graph:stage-1-package-v3";
  assert.notEqual(semanticDiffDigest(changed), vector.expected.digest);
});

test("matches an independent semantic diff digest implementation", async () => {
  const name = "semantic-diff-digest-vector.json";
  const [vector, source] = await Promise.all([
    loadVector(name),
    readFile(referenceImplementationPath, "utf8"),
  ]);
  assertIndependent("semantic-diff", name, vector, source);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "morivyx-semantic-diff-reference-"),
  );
  try {
    const report = {
      format: "morivyx.semantic-diff/0.1",
      baseRevision: "graph:base",
      targetRevision: "graph:target",
      schemaLockDigest: `sha256:${"1".repeat(64)}`,
      evaluatedAt: "2026-09-01T00:00:00Z",
      entries: [
        { kind: "unknown_extension_changed", targetId: "e\u0301z" },
        { kind: "unknown_extension_changed", targetId: "f" },
      ],
    };
    const comparisonPath = join(temporaryDirectory, "vector.json");
    await writeFile(
      comparisonPath,
      JSON.stringify({ cases: [{ name: "NFC order", report }] }),
    );

    const result = spawnSync(
      process.execPath,
      [referenceImplementationPath, "semantic-diff", comparisonPath],
      { encoding: "utf8" },
    );
    const canonical = semanticDiffCanonicalJson(report);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        name: "NFC order",
        canonicalByteLength: Buffer.byteLength(canonical),
        canonicalJson: canonical,
        digest: semanticDiffDigest(report),
      },
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("matches the fixed Trace Report digest vector and boundaries", async () => {
  const vector = await loadVector("trace-report-digest-vector.json");
  assertFixedVector(vector, traceReportCanonicalJson, traceReportDigest);
  assert.equal(validateReport(vector.cases[1].report).type, "trace-report");

  const changed = structuredClone(vector.cases[0].report);
  changed.graphRevision = "graph:stage-1-package-v2";
  assert.notEqual(traceReportDigest(changed), vector.expected.digest);
});

test("matches an independent Trace Report digest implementation", async () => {
  const name = "trace-report-digest-vector.json";
  const [vector, source] = await Promise.all([
    loadVector(name),
    readFile(referenceImplementationPath, "utf8"),
  ]);
  assertIndependent("trace-report", name, vector, source);
});
