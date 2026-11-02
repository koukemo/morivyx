import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { revisionId } from "../src/canonical.js";
import {
  compareExternalArtifactReference,
  externalArtifactReportCanonicalJson,
  externalArtifactReportDigest,
} from "../src/external-artifact.js";
import { validateReport } from "../src/report.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(
  testDirectory,
  "fixtures",
  "external-artifact-comparison-vectors.json",
);
const referenceImplementationPath = join(
  testDirectory,
  "..",
  "test-support",
  "external-artifact-reference.mjs",
);
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;
const digest = (value) => `sha256:${value.repeat(64)}`;

function graphElement({ suffix, type, attributes, provenance, kind = "entity" }) {
  return {
    format: "morivyx.git-graph/0.1",
    kind,
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    revision: digest(String(suffix % 10)),
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes,
    provenance: provenance ?? {
      method: "asserted",
      actor: stableId(1),
      recordedAt: "2026-09-01T00:00:00Z",
    },
  };
}

function comparison(overrides = {}) {
  const artifact = graphElement({
    suffix: 2,
    type: "core.artifact",
    attributes: {
      artifactKind: "document",
      uri: "https://example.test/document",
      digest: digest("a"),
      externalVersion: "v1",
    },
    provenance: {
      method: "imported",
      actor: stableId(1),
      retrievedAt: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:01:00Z",
      digestRule: "raw-bytes@1",
    },
  });
  const externalSource = graphElement({
    suffix: 3,
    type: "core.external-source",
    attributes: {
      system: "example",
      externalId: "document-1",
    },
  });
  const relation = graphElement({
    suffix: 4,
    kind: "relation",
    type: "core.derived_from",
    attributes: {
      source: artifact.id,
      predicate: "derived_from",
      target: externalSource.id,
    },
  });
  return {
    graphRevision: "graph:external-comparison-v1",
    artifact,
    externalSource,
    relations: [relation],
    retrieval: {
      status: "resolved",
      comparedAt: "2026-09-01T01:00:00Z",
      digest: artifact.attributes.digest,
      digestRule: artifact.provenance.digestRule,
      externalVersion: artifact.attributes.externalVersion,
    },
    supportedDigestRules: [artifact.provenance.digestRule],
    ...overrides,
  };
}

function issueCodes(report) {
  return report.issues.map(({ code }) => code);
}

function invalidGraphRevisionCases() {
  const valid = comparison();
  const cases = [];
  const values = [
    [valid.graphRevision],
    [[valid.graphRevision]],
    [valid.graphRevision, valid.graphRevision],
    [],
    {},
    null,
    true,
    123,
  ];
  for (const status of ["resolved", "missing", "unavailable"]) {
    for (const [index, graphRevision] of values.entries()) {
      const input = comparison({ graphRevision });
      if (status !== "resolved") {
        input.retrieval = {
          status,
          comparedAt: valid.retrieval.comparedAt,
          ...(status === "missing"
            ? { method: "provider-not-found" }
            : { reason: "temporary-network-failure" }),
        };
      }
      cases.push({ name: `${status}: graph revision type ${index}`, input });
    }
  }
  return cases;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

test("matches the fixed JSON comparison vectors", async (t) => {
  const vector = JSON.parse(await readFile(vectorPath, "utf8"));

  for (const {
    name,
    input,
    expected,
    expectedDigest,
    reportId,
  } of vector.cases) {
    await t.test(name, () => {
      for (const element of [
        input.artifact,
        input.externalSource,
        ...input.relations,
      ]) {
        assert.equal(element.revision, revisionId(element));
      }
      const actual = compareExternalArtifactReference(input);
      const digestReport =
        typeof reportId === "string" ? { ...actual, id: reportId } : actual;
      assert.deepEqual(actual, expected);
      assert.equal(validateReport(actual).type, "external-artifact-report");
      assert.equal(externalArtifactReportDigest(digestReport), expectedDigest);
    });
  }
});

test("matches the vectors with an independent JSON implementation", async (t) => {
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
    vector.cases.map(({ name, expected, expectedDigest, reportId }) => {
      const digestReport =
        typeof reportId === "string"
          ? { ...expected, id: reportId }
          : expected;
      const canonical = externalArtifactReportCanonicalJson(digestReport);
      return {
        name,
        report: expected,
        canonicalByteLength: Buffer.byteLength(canonical),
        canonicalJson: canonical,
        digest: expectedDigest,
      };
    }),
  );

  const cases = invalidGraphRevisionCases();
  const directory = await mkdtemp(join(tmpdir(), "morivyx-external-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalidVectorPath = join(directory, "invalid-types.json");
  await writeFile(invalidVectorPath, JSON.stringify({ cases }), "utf8");
  const invalidResult = spawnSync(
    process.execPath,
    [referenceImplementationPath, invalidVectorPath],
    { encoding: "utf8" },
  );
  assert.equal(invalidResult.status, 0, invalidResult.stderr);
  const independentResults = JSON.parse(invalidResult.stdout);
  assert.equal(independentResults.length, cases.length);
  for (const [index, item] of independentResults.entries()) {
    const { name, report, digest: reportDigest } = item;
    assert.equal(name, cases[index].name);
    assert.equal(report.status, "invalid", name);
    assert.equal(report.graphRevision, null, name);
    assert.deepEqual(issueCodes(report), ["EXTERNAL_REFERENCE_INCOMPLETE"], name);
    assert.deepEqual(report, compareExternalArtifactReference(cases[index].input));
    assert.equal(reportDigest, externalArtifactReportDigest(report), name);
    assert.equal(validateReport(report).type, "external-artifact-report", name);
  }
});

test("returns a deterministic current report without changing fixed inputs", () => {
  const input = deepFreeze(comparison());
  const first = compareExternalArtifactReference(input);
  const second = compareExternalArtifactReference(input);

  assert.deepEqual(first, second);
  assert.equal(first.format, "morivyx.external-artifact-report/0.1");
  assert.equal(first.status, "current");
  assert.deepEqual(first.issues, []);
  assert.equal(first.graphRevision, input.graphRevision);
  assert.deepEqual(first.artifact, {
    id: input.artifact.id,
    revision: input.artifact.revision,
    lifecycle: "active",
  });
  assert.deepEqual(first.externalSource, {
    id: input.externalSource.id,
    revision: input.externalSource.revision,
  });
  assert.equal(first.relation.revision, input.relations[0].revision);
  assert.equal(first.comparedAt, input.retrieval.comparedAt);
});

test("rejects non-logical inputs without executing accessors", () => {
  const input = comparison();
  let accessorReads = 0;
  Object.defineProperty(input, "graphRevision", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("accessor must not execute");
    },
  });

  const report = compareExternalArtifactReference(input);

  assert.equal(accessorReads, 0);
  assert.equal(report.status, "invalid");
  assert.deepEqual(issueCodes(report), ["EXTERNAL_REFERENCE_INCOMPLETE"]);
});

test("compares only digest when no external version was recorded", () => {
  const input = comparison();
  delete input.artifact.attributes.externalVersion;
  delete input.retrieval.externalVersion;
  assert.equal(compareExternalArtifactReference(input).status, "current");
});

test("reports a changed digest as stale", () => {
  const input = comparison();
  input.retrieval.digest = digest("b");
  const report = compareExternalArtifactReference(input);
  assert.equal(report.status, "stale");
  assert.deepEqual(issueCodes(report), ["EXTERNAL_DIGEST_CHANGED"]);
});

test("reports a changed external version before a changed digest", () => {
  const input = comparison();
  input.retrieval.externalVersion = "v2";
  input.retrieval.digest = digest("b");
  const report = compareExternalArtifactReference(input);
  assert.equal(report.status, "stale");
  assert.deepEqual(issueCodes(report), [
    "EXTERNAL_VERSION_CHANGED",
    "EXTERNAL_DIGEST_CHANGED",
  ]);
});

test("distinguishes a missing target from an unavailable source", async (t) => {
  await t.test("missing", () => {
    const input = comparison({
      retrieval: {
        status: "missing",
        comparedAt: "2026-09-01T01:00:00Z",
        method: "provider-not-found",
      },
    });
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "missing");
    assert.deepEqual(issueCodes(report), ["EXTERNAL_TARGET_MISSING"]);
  });

  await t.test("unavailable", () => {
    const input = comparison({
      retrieval: {
        status: "unavailable",
        comparedAt: "2026-09-01T01:00:00Z",
        reason: "temporary-network-failure",
      },
    });
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "unavailable");
    assert.deepEqual(issueCodes(report), ["EXTERNAL_SOURCE_UNAVAILABLE"]);
  });
});

test("rejects incomplete references and retrieval inputs", async (t) => {
  const cases = [
    ["root", null],
    ["graph revision", { ...comparison(), graphRevision: "invalid" }],
    ["artifact digest", (() => {
      const input = comparison();
      delete input.artifact.attributes.digest;
      return input;
    })()],
    ["artifact provenance", (() => {
      const input = comparison();
      input.artifact.provenance.method = "asserted";
      return input;
    })()],
    ["artifact version", (() => {
      const input = comparison();
      input.artifact.attributes.externalVersion = "";
      return input;
    })()],
    ["external identity", (() => {
      const input = comparison();
      delete input.externalSource.attributes.externalId;
      return input;
    })()],
    ["external snapshot", (() => {
      const input = comparison();
      input.externalSource.attributes.snapshotAt = "invalid";
      return input;
    })()],
    ["derived relation", { ...comparison(), relations: [] }],
    ["relation collection", { ...comparison(), relations: null }],
    ["multiple derived relations", (() => {
      const input = comparison();
      input.relations.push(structuredClone(input.relations[0]));
      return input;
    })()],
    ["derived target", (() => {
      const input = comparison();
      input.relations[0].attributes.target = stableId(99);
      return input;
    })()],
    ["retrieval status", { ...comparison(), retrieval: { status: "unknown" } }],
    ["comparison time syntax", (() => {
      const input = comparison();
      input.retrieval.comparedAt = "invalid";
      return input;
    })()],
    ["comparison time", (() => {
      const input = comparison();
      input.retrieval.comparedAt = "2026-02-30T00:00:00Z";
      return input;
    })()],
    ["resolved digest", (() => {
      const input = comparison();
      delete input.retrieval.digest;
      return input;
    })()],
    ["resolved version", (() => {
      const input = comparison();
      delete input.retrieval.externalVersion;
      return input;
    })()],
    ["missing method", {
      ...comparison(),
      retrieval: {
        status: "missing",
        comparedAt: "2026-09-01T01:00:00Z",
      },
    }],
    ["unavailable reason", {
      ...comparison(),
      retrieval: {
        status: "unavailable",
        comparedAt: "2026-09-01T01:00:00Z",
      },
    }],
  ];

  for (const [name, input] of cases) {
    await t.test(name, () => {
      const report = compareExternalArtifactReference(input);
      assert.equal(report.status, "invalid");
      assert.equal(issueCodes(report)[0], "EXTERNAL_REFERENCE_INCOMPLETE");
      assert.equal(validateReport(report).type, "external-artifact-report");
    });
  }

  const optionalVersion = comparison();
  delete optionalVersion.artifact.attributes.externalVersion;
  optionalVersion.retrieval.externalVersion = null;
  const resolvedExtra = comparison();
  resolvedExtra.retrieval.method = "unexpected";
  const unknownRetrieval = comparison();
  unknownRetrieval.retrieval.unknown = "unexpected";
  const conflictingRetrievals = [
    ["resolved optional version shape", optionalVersion],
    ["resolved extra field", resolvedExtra],
    [
      "missing resolved fields",
      {
        ...comparison(),
        retrieval: {
          status: "missing",
          comparedAt: "2026-09-01T01:00:00Z",
          method: "provider-not-found",
          digest: digest("a"),
          digestRule: "raw-bytes@1",
        },
      },
    ],
    [
      "unavailable extra field",
      {
        ...comparison(),
        retrieval: {
          status: "unavailable",
          comparedAt: "2026-09-01T01:00:00Z",
          reason: "temporary-network-failure",
          method: "unexpected",
        },
      },
    ],
    ["unknown retrieval field", unknownRetrieval],
  ];
  for (const [name, input] of conflictingRetrievals) {
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "invalid", name);
    assert.equal(validateReport(report).type, "external-artifact-report", name);
  }

  for (const { name, input } of invalidGraphRevisionCases()) {
    const before = JSON.stringify(input);
    const report = compareExternalArtifactReference(deepFreeze(input));
    assert.equal(report.status, "invalid", name);
    assert.equal(report.graphRevision, null, name);
    assert.deepEqual(issueCodes(report), ["EXTERNAL_REFERENCE_INCOMPLETE"], name);
    assert.equal(validateReport(report).type, "external-artifact-report", name);
    assert.equal(JSON.stringify(input), before, name);
  }
});

test("requires a supported digest rule and matching retrieval rule", async (t) => {
  await t.test("unsupported", () => {
    const input = comparison({ supportedDigestRules: [] });
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "invalid");
    assert.deepEqual(issueCodes(report), [
      "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
    ]);
  });

  await t.test("mismatch", () => {
    const input = comparison();
    input.retrieval.digestRule = "normalized-text@1";
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "invalid");
    assert.deepEqual(issueCodes(report), [
      "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
    ]);
  });

  await t.test("invalid allowlist", () => {
    const input = comparison({ supportedDigestRules: [null] });
    const report = compareExternalArtifactReference(input);
    assert.equal(report.status, "invalid");
    assert.deepEqual(issueCodes(report), [
      "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
    ]);
  });
});

test("keeps invalid issue codes in ADR priority order", () => {
  const input = comparison({
    graphRevision: "invalid",
    supportedDigestRules: [],
  });
  const report = compareExternalArtifactReference(input);
  assert.equal(report.status, "invalid");
  assert.deepEqual(issueCodes(report), [
    "EXTERNAL_REFERENCE_INCOMPLETE",
    "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
  ]);
});
