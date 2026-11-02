import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const kernelDirectory = join(testDirectory, "..");
const fixtureDirectory = join(testDirectory, "fixtures");
const referenceDirectory = join(kernelDirectory, "test-support");

const DIGEST_COVERAGE = {
  changeSetDigest: {
    fixture: "changeset-digest-vector.json",
    reference: "changeset-digest-reference.mjs",
    test: "changeset-digest-independent.test.js",
  },
  externalArtifactReportDigest: {
    fixture: "external-artifact-comparison-vectors.json",
    reference: "external-artifact-reference.mjs",
    test: "external-artifact.test.js",
  },
  graphRootDigest: {
    fixture: "graph-root-digest-vector.json",
    reference: "graph-root-digest-reference.mjs",
    test: "graph-root-digest-independent.test.js",
  },
  migrationDigest: {
    fixture: "migration-digest-vector.json",
    reference: "migration-digest-reference.mjs",
    test: "migration-digest-independent.test.js",
  },
  migrationSemanticDiffDigest: {
    fixture: "migration-semantic-diff-digest-vector.json",
    reference: "migration-semantic-diff-digest-reference.mjs",
    test: "migration-semantic-diff-digest.test.js",
  },
  revisionId: {
    fixture: "revision-id-vector.json",
    reference: "revision-id-reference.mjs",
    test: "revision-id-independent.test.js",
  },
  schemaDefinitionDigest: {
    fixture: "schema-definition-digest-vector.json",
    reference: "schema-definition-digest-reference.mjs",
    test: "schema-definition-digest-independent.test.js",
  },
  schemaLockDigest: {
    fixture: "schema-lock-digest-vector.json",
    reference: "schema-lock-digest-reference.mjs",
    test: "schema-lock-digest-independent.test.js",
  },
  semanticDiffDigest: {
    fixture: "semantic-diff-digest-vector.json",
    reference: "report-digest-reference.mjs",
    test: "report-digest-independent.test.js",
  },
  traceReportDigest: {
    fixture: "trace-report-digest-vector.json",
    reference: "report-digest-reference.mjs",
    test: "report-digest-independent.test.js",
  },
};

const READ_WRITE_COVERAGE = {
  graphPackageRoundTrip: {
    fixtures: ["graph-package-roundtrip-vector.json"],
    reference: "graph-package-roundtrip-reference.mjs",
    test: "graph-package-roundtrip-independent.test.js",
    symbols: [
      "readGraphPackageReference",
      "writeGraphPackageReference",
    ],
  },
  yamlAuthoringProfileRoundTrip: {
    fixtures: [
      "package-v1/.morivyx/graph/entities/550e8400-e29b-41d4-a716-446655440000.yaml",
      "yaml-authoring-roundtrip-expected.yaml",
      "yaml-authoring-roundtrip-vector.json",
    ],
    reference: "yaml-authoring-roundtrip-reference.mjs",
    test: "yaml-authoring-roundtrip-independent.test.js",
    symbols: ["readYamlReference", "writeYamlReference"],
  },
};

function exportedNames(source) {
  const names = [];
  for (const match of source.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.push(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/gs)) {
    for (const item of match[1].split(",")) {
      const [original, alias] = item.trim().split(/\s+as\s+/);
      if (original) {
        names.push(alias ?? original);
      }
    }
  }
  return names;
}

function fixedDigests(vector) {
  const values = [];
  if (typeof vector.expected?.digest === "string") {
    values.push(vector.expected.digest);
  }
  for (const entry of vector.cases ?? []) {
    if (typeof entry.expectedDigest === "string") {
      values.push(entry.expectedDigest);
    }
  }
  return values;
}

test("tracks every exported digest calculator", async () => {
  const packageJson = JSON.parse(
    await readFile(join(kernelDirectory, "package.json"), "utf8"),
  );
  const sourcePaths = [...new Set(Object.values(packageJson.exports))];
  const discovered = new Set();

  for (const sourcePath of sourcePaths) {
    const source = await readFile(
      join(kernelDirectory, sourcePath.replace(/^\.\//, "")),
      "utf8",
    );
    for (const name of exportedNames(source)) {
      if (name === "revisionId" || name.endsWith("Digest")) {
        discovered.add(name);
      }
    }
  }

  assert.deepEqual(
    [...discovered].sort(),
    Object.keys(DIGEST_COVERAGE).sort(),
  );
});

test("keeps a fixed vector and independent implementation for each digest", async () => {
  for (const [calculator, paths] of Object.entries(DIGEST_COVERAGE)) {
    const [fixtureSource, referenceSource, testSource] = await Promise.all([
      readFile(join(fixtureDirectory, paths.fixture), "utf8"),
      readFile(join(referenceDirectory, paths.reference), "utf8"),
      readFile(join(testDirectory, paths.test), "utf8"),
    ]);
    const digests = fixedDigests(JSON.parse(fixtureSource));

    assert.ok(digests.length > 0, `${calculator}: fixed digest is missing`);
    assert.ok(
      digests.every((value) => /^sha256:[0-9a-f]{64}$/.test(value)),
      `${calculator}: fixed digest is invalid`,
    );
    assert.doesNotMatch(
      referenceSource,
      /(?:\.\.\/)+src\/|@morivyx\/kernel/,
    );
    assert.match(testSource, new RegExp(`\\b${calculator}\\b`));
    assert.ok(testSource.includes(basename(paths.fixture)));
    assert.ok(testSource.includes(basename(paths.reference)));
  }
});

test("keeps fixed vectors and an independent implementation for read-write contracts", async () => {
  for (const [contract, paths] of Object.entries(READ_WRITE_COVERAGE)) {
    const [fixtures, referenceSource, testSource] = await Promise.all([
      Promise.all(
        paths.fixtures.map((fixture) =>
          readFile(join(fixtureDirectory, fixture), "utf8"),
        ),
      ),
      readFile(join(referenceDirectory, paths.reference), "utf8"),
      readFile(join(testDirectory, paths.test), "utf8"),
    ]);

    assert.ok(
      fixtures.every((source) => source.length > 0),
      `${contract}: fixed fixture is empty`,
    );
    assert.doesNotMatch(
      referenceSource,
      /(?:\.\.\/)+src\/|@morivyx\/kernel/,
    );
    for (const symbol of paths.symbols) {
      assert.match(referenceSource, new RegExp(`\\bexport function ${symbol}\\b`));
      assert.match(testSource, new RegExp(`\\b${symbol}\\b`));
    }
    for (const fixture of paths.fixtures) {
      assert.ok(testSource.includes(basename(fixture)));
    }
    assert.ok(testSource.includes(basename(paths.reference)));
  }
});
