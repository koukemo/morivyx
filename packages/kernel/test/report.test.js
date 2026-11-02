import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { PackageError } from "../src/errors.js";
import {
  externalArtifactReportCanonicalJson,
  externalArtifactReportDigest,
} from "../src/external-artifact.js";
import { readGraphPackage } from "../src/package-reader.js";
import {
  migrationSemanticDiffCanonicalJson,
  migrationSemanticDiffDigest,
} from "../src/semantic-diff.js";
import {
  readReport,
  serializeReportYaml,
  validateExternalArtifactReport,
  validateMigrationSemanticDiffReport,
  validateReport,
  validateSemanticDiffReport,
  validateTraceReport,
  writeReport,
} from "../src/report.js";
import { yaml } from "../test-support/yaml.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
const packageFixture = join(testDirectory, "fixtures", "package-v1");
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;
const digest = (value) => `sha256:${value.repeat(64)}`;

function traceReport() {
  return {
    format: "morivyx.trace-report/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440010",
    queryId: "governing-decision",
    graphRevision: "graph:stage-1-package-v1",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    focusId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
    evaluatedAt: "2026-08-02T00:00:00Z",
    status: "complete",
    paths: [
      {
        hops: [
          {
            fromId: "urn:uuid:550e8400-e29b-41d4-a716-446655440002",
            predicate: "governs",
            toId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
            fromRevision:
              "sha256:2b56691b87622570d4d69c26a56cfd3cb9e01e8c83c434c88f9d4284ba94e3c6",
            toRevision:
              "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
          },
        ],
      },
    ],
    missing: [],
  };
}

function semanticDiff() {
  return {
    format: "morivyx.semantic-diff/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440011",
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-package-v2",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    evaluatedAt: "2026-08-02T00:00:00Z",
    entries: [
      {
        kind: "entity_added",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
        afterRevision:
          "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
      },
      {
        kind: "entity_revised",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        beforeRevision:
          "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
        afterRevision:
          "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
      },
      {
        kind: "trace_quality_changed",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        queryId: "governing-decision",
        beforeStatus: "partial",
        afterStatus: "complete",
      },
    ],
  };
}

function migrationSemanticDiff() {
  return {
    format: "morivyx.migration-semantic-diff/0.1",
    id: stableId(15),
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-migration-v1",
    sourceSchemaLockDigest: digest("1"),
    targetSchemaLockDigest: digest("2"),
    evaluatedAt: "2026-09-01T02:00:00Z",
    entries: [{ kind: "schema_changed", targetId: "morivyx.core" }],
  };
}

function externalArtifactReport() {
  return {
    format: "morivyx.external-artifact-report/0.1",
    id: stableId(12),
    graphRevision: "graph:external-comparison-v1",
    artifact: {
      id: stableId(2),
      revision: digest("2"),
      lifecycle: "active",
    },
    externalSource: {
      id: stableId(3),
      revision: digest("3"),
    },
    relation: {
      id: stableId(4),
      revision: digest("4"),
    },
    retrieval: {
      status: "resolved",
      comparedAt: "2026-09-01T01:00:00Z",
      digest: digest("a"),
      digestRule: "raw-bytes@1",
      externalVersion: "v1",
    },
    comparedAt: "2026-09-01T01:00:00Z",
    status: "current",
    issues: [],
  };
}

async function writeReportFile(report) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-report-"));
  temporaryDirectories.add(directory);
  const path = join(directory, "report.yaml");
  await writeFile(path, yaml(report));
  return path;
}

async function packageRoot() {
  const root = await mkdtemp(join(tmpdir(), "morivyx-report-package-"));
  temporaryDirectories.add(root);
  await mkdir(join(root, ".morivyx"));
  return root;
}

function reversedMappings(value) {
  if (Array.isArray(value)) {
    return value.map(reversedMappings);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reversedMappings(entry)]),
  );
}

function expectCode(action, code, pathSuffix) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    if (pathSuffix) {
      assert.ok(error.path.endsWith(pathSuffix), error.path);
    }
    return true;
  });
}

test("reads both ADR-0012 Report validation vectors", async () => {
  const trace = await readReport(await writeReportFile(traceReport()));
  const diff = await readReport(await writeReportFile(semanticDiff()));

  assert.equal(trace.type, "trace-report");
  assert.equal(
    trace.digest,
    "sha256:e2268da4eae9d3d868b483de0add3bbdb9359b4895f34043d771a0ed52b292b7",
  );
  assert.equal(diff.type, "semantic-diff");
  assert.equal(
    diff.digest,
    "sha256:8d05635012d207209a197cb68cface531db5f2970e5e4ce4f60ae35f2b25d66b",
  );
});

test("writes a Migration semantic diff with both Schema boundaries", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migration-diff-package-"),
  );
  temporaryDirectories.add(directory);
  await cp(packageFixture, directory, { recursive: true });
  const before = await readGraphPackage(directory);
  const report = migrationSemanticDiff();
  const result = await writeReport(directory, report);
  const roundTrip = await readReport(result.path);
  const after = await readGraphPackage(directory);

  assert.equal(result.type, "migration-semantic-diff");
  assert.equal(roundTrip.type, "migration-semantic-diff");
  assert.equal(roundTrip.digest, migrationSemanticDiffDigest(report));
  assert.deepEqual(roundTrip.report, report);
  assert.equal(after.revision.rootDigest, before.revision.rootDigest);
  assert.equal(
    Object.hasOwn(JSON.parse(migrationSemanticDiffCanonicalJson(report)), "id"),
    false,
  );
  assert.equal(
    migrationSemanticDiffDigest({ ...report, id: stableId(16) }),
    migrationSemanticDiffDigest(report),
  );
});

test("rejects invalid Migration semantic diff boundaries", () => {
  const report = migrationSemanticDiff();
  expectCode(
    () =>
      validateMigrationSemanticDiffReport({
        ...report,
        format: "morivyx.semantic-diff/0.1",
      }),
    "REPORT_STRUCTURE_INVALID",
    "/format",
  );
  assert.throws(
    () =>
      validateMigrationSemanticDiffReport({
        ...report,
        targetSchemaLockDigest: report.sourceSchemaLockDigest,
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_STRUCTURE_INVALID" &&
      error.path === "/targetSchemaLockDigest",
  );
  assert.throws(
    () =>
      validateMigrationSemanticDiffReport({
        ...report,
        entries: [],
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "MIGRATION_SEMANTIC_DIFF_MISMATCH" &&
      error.path === "/entries",
  );
});

test("writes and reads an external Artifact Report without changing its digest", async () => {
  const root = await packageRoot();
  const report = externalArtifactReport();
  const snapshot = structuredClone(report);
  const result = await writeReport(root, report);

  assert.equal(result.type, "external-artifact-report");
  assert.equal(
    result.path,
    join(
      root,
      ".morivyx",
      "reports",
      "550e8400-e29b-41d4-a716-000000000012.yaml",
    ),
  );
  assert.equal(await readFile(result.path, "utf8"), serializeReportYaml(report));
  const roundTrip = await readReport(result.path);
  assert.equal(roundTrip.type, "external-artifact-report");
  assert.equal(roundTrip.digest, result.digest);
  assert.deepEqual(roundTrip.report, report);
  assert.deepEqual(report, snapshot);

  const differentId = { ...report, id: stableId(13) };
  assert.equal(
    externalArtifactReportDigest(differentId),
    externalArtifactReportDigest(report),
  );
  assert.equal(
    Object.hasOwn(JSON.parse(externalArtifactReportCanonicalJson(report)), "id"),
    false,
  );
});

test("saves an external Artifact Report without changing the Graph root digest", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-external-report-package-"),
  );
  temporaryDirectories.add(directory);
  await cp(packageFixture, directory, { recursive: true });
  const before = await readGraphPackage(directory);

  await writeReport(directory, externalArtifactReport());
  const after = await readGraphPackage(directory);

  assert.equal(after.revision.rootDigest, before.revision.rootDigest);
  assert.equal(after.reports.length, before.reports.length + 1);
  assert.equal(
    after.reports.find(({ report }) => report.id === externalArtifactReport().id)
      ?.report.format,
    "morivyx.external-artifact-report/0.1",
  );
});

test("serializes an external Artifact Report independently of mapping insertion order", () => {
  const report = externalArtifactReport();
  const reordered = reversedMappings(report);
  reordered.comparedAt = "2026-09-01T10:00:00+09:00";
  reordered.retrieval.comparedAt = "2026-09-01T10:00:00+09:00";

  assert.equal(serializeReportYaml(reordered), serializeReportYaml(report));
  assert.equal(
    externalArtifactReportDigest(reordered),
    externalArtifactReportDigest(report),
  );
});

test("validates all external Artifact Report statuses", () => {
  const current = externalArtifactReport();
  const stale = {
    ...externalArtifactReport(),
    status: "stale",
    issues: [
      { code: "EXTERNAL_VERSION_CHANGED" },
      { code: "EXTERNAL_DIGEST_CHANGED" },
    ],
  };
  const missing = {
    ...externalArtifactReport(),
    retrieval: {
      status: "missing",
      comparedAt: "2026-09-01T01:00:00Z",
      method: "provider-not-found",
    },
    status: "missing",
    issues: [{ code: "EXTERNAL_TARGET_MISSING" }],
  };
  const unavailable = {
    ...externalArtifactReport(),
    retrieval: {
      status: "unavailable",
      comparedAt: "2026-09-01T01:00:00Z",
      reason: "network-timeout",
    },
    status: "unavailable",
    issues: [{ code: "EXTERNAL_SOURCE_UNAVAILABLE" }],
  };
  const invalid = {
    ...externalArtifactReport(),
    graphRevision: null,
    artifact: { id: null, revision: null, lifecycle: null },
    externalSource: { id: null, revision: null },
    relation: { id: null, revision: null },
    retrieval: null,
    comparedAt: null,
    status: "invalid",
    issues: [{ code: "EXTERNAL_REFERENCE_INCOMPLETE" }],
  };

  for (const report of [current, stale, missing, unavailable, invalid]) {
    assert.equal(validateExternalArtifactReport(report), report);
    assert.equal(validateReport(report).type, "external-artifact-report");
    assert.match(serializeReportYaml(report), /^format:/);
  }
});

test("rejects inconsistent external Artifact Report fields", () => {
  const cases = [
    [
      {
        ...externalArtifactReport(),
        format: "morivyx.semantic-diff/0.1",
      },
      "/format",
      "REPORT_STRUCTURE_INVALID",
    ],
    [{ ...externalArtifactReport(), id: "invalid" }, "/id", "REPORT_STRUCTURE_INVALID"],
    [{ ...externalArtifactReport(), status: "unknown" }, "/status", "REPORT_STRUCTURE_INVALID"],
    [{ ...externalArtifactReport(), graphRevision: null }, "/graphRevision", "REPORT_STRUCTURE_INVALID"],
    [{ ...externalArtifactReport(), comparedAt: null }, "/comparedAt", "REPORT_STRUCTURE_INVALID"],
    [{ ...externalArtifactReport(), retrieval: null }, "/retrieval", "REPORT_STRUCTURE_INVALID"],
    [{ ...externalArtifactReport(), issues: null }, "/issues", "REPORT_STRUCTURE_INVALID"],
    [
      {
        ...externalArtifactReport(),
        issues: [{ code: "EXTERNAL_UNKNOWN" }],
      },
      "/issues/0/code",
      "REPORT_STRUCTURE_INVALID",
    ],
    [
      {
        ...externalArtifactReport(),
        comparedAt: "2026-09-01T02:00:00Z",
      },
      "/comparedAt",
      "REPORT_STRUCTURE_INVALID",
    ],
    [
      {
        ...externalArtifactReport(),
        retrieval: {
          ...externalArtifactReport().retrieval,
          status: "missing",
        },
      },
      "/retrieval/status",
      "REPORT_STRUCTURE_INVALID",
    ],
    [
      {
        ...externalArtifactReport(),
        status: "stale",
        issues: [
          { code: "EXTERNAL_DIGEST_CHANGED" },
          { code: "EXTERNAL_VERSION_CHANGED" },
        ],
      },
      "/issues/1",
      "REPORT_ORDER_INVALID",
    ],
    [
      {
        ...externalArtifactReport(),
        issues: [{ code: "EXTERNAL_TARGET_MISSING" }],
      },
      "/issues",
      "REPORT_STRUCTURE_INVALID",
    ],
    [
      { ...externalArtifactReport(), extra: true },
      "/extra",
      "REPORT_STRUCTURE_INVALID",
    ],
  ];

  for (const [report, pathSuffix, code] of cases) {
    expectCode(
      () => validateExternalArtifactReport(report),
      code,
      pathSuffix,
    );
  }
});

test("serializes the same logical Report to identical YAML bytes", () => {
  const original = traceReport();
  const snapshot = structuredClone(original);
  const reordered = reversedMappings(original);
  reordered.evaluatedAt = "2026-08-02T09:00:00+09:00";

  const originalSource = serializeReportYaml(original);
  const reorderedSource = serializeReportYaml(reordered);

  assert.equal(reorderedSource, originalSource);
  assert.match(originalSource, /^format: "morivyx\.trace-report\/0\.1"\n/);
  assert.ok(originalSource.endsWith("\n"));
  assert.deepEqual(original, snapshot);
});

test("writes and reads a Report without changing its digest", async () => {
  const root = await packageRoot();
  const report = traceReport();
  const snapshot = structuredClone(report);
  const result = await writeReport(root, report);

  assert.equal(
    result.path,
    join(
      root,
      ".morivyx",
      "reports",
      "550e8400-e29b-41d4-a716-446655440010.yaml",
    ),
  );
  assert.equal(await readFile(result.path, "utf8"), serializeReportYaml(report));
  const roundTrip = await readReport(result.path);
  assert.equal(roundTrip.digest, result.digest);
  assert.deepEqual(report, snapshot);

  await assert.rejects(
    () => writeReport(root, report),
    (error) =>
      error instanceof PackageError && error.code === "REPORT_ALREADY_EXISTS",
  );
  assert.equal((await readReport(result.path)).digest, result.digest);
});

test("publishes only one of two concurrent writes for the same Report ID", async () => {
  const root = await packageRoot();
  const results = await Promise.allSettled([
    writeReport(root, semanticDiff()),
    writeReport(root, semanticDiff()),
  ]);

  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.ok(rejected.reason instanceof PackageError);
  assert.equal(rejected.reason.code, "REPORT_ALREADY_EXISTS");
  const saved = results.find(({ status }) => status === "fulfilled").value;
  assert.equal((await readReport(saved.path)).digest, saved.digest);
});

test("rejects a symbolic link Report directory", async (t) => {
  const root = await packageRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside-reports");
  const reportsDirectory = join(root, ".morivyx", "reports");
  await mkdir(outside);
  await symlink(outside, reportsDirectory, "dir");

  await assert.rejects(
    writeReport(root, semanticDiff()),
    (error) =>
      error instanceof PackageError &&
      error.code === "PACKAGE_RECORD_OUTPUT_INVALID" &&
      error.path === reportsDirectory,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("rejects a symbolic link Report metadata root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-report-linked-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataPath = join(root, ".morivyx");
  await symlink(join(packageFixture, ".morivyx"), metadataPath, "dir");

  await assert.rejects(
    writeReport(root, semanticDiff()),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_PACKAGE_MISSING" &&
      error.path === metadataPath,
  );
});

test("rejects a Report ID already used by another Package record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-report-collision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(packageFixture, directory, { recursive: true });
  const elementId =
    "urn:uuid:550e8400-e29b-41d4-a716-446655440000";

  await assert.rejects(
    () => writeReport(directory, { ...traceReport(), id: elementId }),
    (error) =>
      error instanceof PackageError &&
      error.code === "ID_DUPLICATE" &&
      error.path ===
        join(
          directory,
          ".morivyx",
          "reports",
          "550e8400-e29b-41d4-a716-446655440000.yaml",
        ),
  );

  await assert.rejects(
    readdir(join(directory, ".morivyx", "reports")),
    (error) => error.code === "ENOENT",
  );
  const contents = await readGraphPackage(directory);
  assert.equal(contents.elements.some(({ id }) => id === elementId), true);
  assert.deepEqual(contents.reports, []);
});

test("checks stored Package records in declared order before saving a Report", async (t) => {
  const recordGroups = [
    ["Entity", ["graph", "entities"]],
    ["Relation", ["graph", "relations"]],
    ["Approval", ["approvals"]],
    ["ChangeSet", ["ledger"]],
    ["Migration", ["migrations"]],
    ["Report", ["reports"]],
  ];

  for (const [index, [name]] of recordGroups.entries()) {
    await t.test(name, async () => {
      const root = await packageRoot();
      const invalidPaths = [];

      for (const [, pathParts] of recordGroups.slice(index)) {
        const recordDirectory = join(root, ".morivyx", ...pathParts);
        await mkdir(recordDirectory, { recursive: true });
        const invalidPath = join(recordDirectory, "zz-invalid.yaml");
        await writeFile(invalidPath, "value: [\n");
        invalidPaths.push(invalidPath);
      }

      await assert.rejects(writeReport(root, traceReport()), (error) => {
        assert.ok(error instanceof PackageError);
        assert.equal(error.code, "PACKAGE_YAML_INVALID");
        assert.equal(error.path, invalidPaths[0]);
        return true;
      });
    });
  }

  await t.test("Unicode filename order", async () => {
    const root = await packageRoot();
    const recordDirectory = join(root, ".morivyx", "graph", "entities");
    await mkdir(recordDirectory, { recursive: true });
    const firstPath = join(recordDirectory, "aa-invalid.yaml");
    await writeFile(firstPath, "value: [\n");
    await writeFile(
      join(recordDirectory, "zz-invalid.yaml"),
      "value: [\n",
    );

    await assert.rejects(writeReport(root, traceReport()), (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "PACKAGE_YAML_INVALID");
      assert.equal(error.path, firstPath);
      return true;
    });
  });
});

test("rejects a Report ID saved under an arbitrary filename", async (t) => {
  const root = await packageRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = traceReport();
  const saved = await writeReport(root, report);
  const arbitraryPath = join(dirname(saved.path), "arbitrary-name.yaml");
  await rename(saved.path, arbitraryPath);

  await assert.rejects(
    () => writeReport(root, report),
    (error) =>
      error instanceof PackageError && error.code === "REPORT_ALREADY_EXISTS",
  );
  assert.deepEqual(await readdir(dirname(saved.path)), ["arbitrary-name.yaml"]);
});

test("requires a Report ID and an existing package directory", async () => {
  const root = await packageRoot();
  const noId = traceReport();
  delete noId.id;
  await assert.rejects(
    () => writeReport(root, noId),
    (error) =>
      error instanceof PackageError && error.code === "REPORT_ID_REQUIRED",
  );

  const missingPackage = await mkdtemp(
    join(tmpdir(), "morivyx-report-missing-package-"),
  );
  temporaryDirectories.add(missingPackage);
  await assert.rejects(
    () => writeReport(missingPackage, traceReport()),
    (error) =>
      error instanceof PackageError && error.code === "REPORT_PACKAGE_MISSING",
  );

  const invalidPackage = await mkdtemp(
    join(tmpdir(), "morivyx-report-invalid-package-"),
  );
  temporaryDirectories.add(invalidPackage);
  await writeFile(join(invalidPackage, ".morivyx"), "not a directory\n");
  await assert.rejects(
    () => writeReport(invalidPackage, traceReport()),
    (error) =>
      error instanceof PackageError && error.code === "REPORT_PACKAGE_MISSING",
  );
});

test("validates waived Trace Reports and rejects invalid waiver use", () => {
  const waived = {
    ...traceReport(),
    status: "waived",
    missing: ["governs"],
    waiverDecisionId: stableId(20),
  };
  assert.equal(validateTraceReport(waived), waived);

  const missing = structuredClone(waived);
  delete missing.waiverDecisionId;
  expectCode(
    () => validateTraceReport(missing),
    "REPORT_STRUCTURE_INVALID",
    "/waiverDecisionId",
  );
  expectCode(
    () =>
      validateTraceReport({
        ...traceReport(),
        waiverDecisionId: stableId(20),
      }),
    "REPORT_STRUCTURE_INVALID",
    "/waiverDecisionId",
  );
});

test("rejects invalid Trace Report structure and logical order", () => {
  const unknownQuery = { ...traceReport(), queryId: "unknown" };
  expectCode(
    () => validateTraceReport(unknownQuery),
    "REPORT_STRUCTURE_INVALID",
    "/queryId",
  );

  const emptyHop = structuredClone(traceReport());
  emptyHop.paths[0].hops = [];
  expectCode(
    () => validateTraceReport(emptyHop),
    "REPORT_STRUCTURE_INVALID",
    "/paths/0/hops",
  );

  const unrelatedFocus = structuredClone(traceReport());
  unrelatedFocus.paths[0].hops[0].toId = stableId(9);
  expectCode(
    () => validateTraceReport(unrelatedFocus),
    "REPORT_STRUCTURE_INVALID",
    "/paths/0/hops/0",
  );

  expectCode(
    () => validateTraceReport({ ...traceReport(), paths: [] }),
    "REPORT_STRUCTURE_INVALID",
    "/paths",
  );
  expectCode(
    () => validateTraceReport({ ...traceReport(), missing: ["governs"] }),
    "REPORT_STRUCTURE_INVALID",
    "/missing",
  );
  expectCode(
    () => validateTraceReport({ ...traceReport(), status: "partial" }),
    "REPORT_STRUCTURE_INVALID",
    "/missing",
  );

  const connectedHops = structuredClone(traceReport());
  const firstHop = connectedHops.paths[0].hops[0];
  connectedHops.paths[0].hops.push({
    fromId: firstHop.fromId,
    predicate: "executes",
    toId: stableId(4),
    fromRevision: firstHop.fromRevision,
    toRevision: `sha256:${"4".repeat(64)}`,
  });
  assert.equal(validateTraceReport(connectedHops), connectedHops);

  const disconnectedHops = structuredClone(connectedHops);
  disconnectedHops.paths[0].hops[1].fromId = stableId(5);
  disconnectedHops.paths[0].hops[1].fromRevision = `sha256:${"5".repeat(64)}`;
  expectCode(
    () => validateTraceReport(disconnectedHops),
    "REPORT_STRUCTURE_INVALID",
    "/paths/0/hops/1",
  );

  const unorderedPaths = structuredClone(traceReport());
  const firstPath = structuredClone(unorderedPaths.paths[0]);
  firstPath.hops[0].fromId = stableId(2);
  const secondPath = structuredClone(unorderedPaths.paths[0]);
  secondPath.hops[0].fromId = stableId(1);
  unorderedPaths.paths = [firstPath, secondPath];
  expectCode(
    () => validateTraceReport(unorderedPaths),
    "REPORT_ORDER_INVALID",
    "/paths/1",
  );

  const duplicateMissing = { ...traceReport(), missing: ["same", "same"] };
  expectCode(
    () => validateTraceReport(duplicateMissing),
    "REPORT_ORDER_INVALID",
    "/missing/1",
  );
});

test("rejects malformed Trace Report scalar and collection fields", async () => {
  const cases = [
    [null, ""],
    [{ ...traceReport(), format: "morivyx.semantic-diff/0.1" }, "/format"],
    [{ ...traceReport(), id: "invalid" }, "/id"],
    [{ ...traceReport(), graphRevision: "" }, "/graphRevision"],
    [{ ...traceReport(), graphRevision: "invalid" }, "/graphRevision"],
    [{ ...traceReport(), schemaLockDigest: "invalid" }, "/schemaLockDigest"],
    [{ ...traceReport(), focusId: "invalid" }, "/focusId"],
    [{ ...traceReport(), evaluatedAt: "invalid" }, "/evaluatedAt"],
    [
      { ...traceReport(), evaluatedAt: "2026-02-30T00:00:00Z" },
      "/evaluatedAt",
    ],
    [
      { ...traceReport(), evaluatedAt: "9999-12-31T23:59:59-14:00" },
      "/evaluatedAt",
    ],
    [{ ...traceReport(), status: "unknown" }, "/status"],
    [{ ...traceReport(), paths: {} }, "/paths"],
    [{ ...traceReport(), missing: {} }, "/missing"],
    [{ ...traceReport(), missing: [""] }, "/missing/0"],
  ];

  for (const [report, pathSuffix] of cases) {
    expectCode(
      () => validateTraceReport(report),
      "REPORT_STRUCTURE_INVALID",
      pathSuffix,
    );
  }

  const invalidHop = structuredClone(traceReport());
  invalidHop.paths[0].hops[0].toRevision = "invalid";
  expectCode(
    () => validateTraceReport(invalidHop),
    "REPORT_STRUCTURE_INVALID",
    "/paths/0/hops/0/toRevision",
  );

  await assert.rejects(
    readReport(
      await writeReportFile({ ...traceReport(), paths: ["not-a-path"] }),
    ),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_STRUCTURE_INVALID" &&
      error.path.endsWith("#/paths/0"),
  );
  await assert.rejects(
    readReport(await writeReportFile({ ...traceReport(), missing: [1] })),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_STRUCTURE_INVALID" &&
      error.path.endsWith("#/missing/0"),
  );
});

test("accepts every semantic diff entry shape", () => {
  const entries = [
    { kind: "entity_added", targetId: stableId(1), afterRevision: digest("1") },
    {
      kind: "entity_revised",
      targetId: stableId(2),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
    },
    { kind: "entity_retired", targetId: stableId(3), beforeRevision: digest("1") },
    {
      kind: "entity_replaced",
      targetId: stableId(4),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
      replacementId: stableId(5),
    },
    { kind: "relation_added", targetId: stableId(6), afterRevision: digest("1") },
    {
      kind: "relation_revised",
      targetId: stableId(7),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
    },
    { kind: "relation_retired", targetId: stableId(8), beforeRevision: digest("1") },
    {
      kind: "decision_changed",
      targetId: stableId(9),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
      aspect: "selection",
    },
    {
      kind: "goal_changed",
      targetId: stableId(10),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
      aspect: "achievement",
    },
    {
      kind: "trace_quality_changed",
      targetId: stableId(11),
      queryId: "governing-decision",
      beforeStatus: "partial",
      afterStatus: "complete",
    },
    {
      kind: "provenance_changed",
      targetId: stableId(12),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
    },
    {
      kind: "external_digest_changed",
      targetId: stableId(13),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
    },
    { kind: "schema_changed", targetId: "morivyx.core" },
    {
      kind: "unknown_extension_changed",
      targetId: stableId(14),
      beforeRevision: digest("1"),
      afterRevision: digest("2"),
    },
  ];
  const report = { ...semanticDiff(), entries };

  assert.equal(validateSemanticDiffReport(report), report);
});

test("rejects invalid semantic diff entries and logical order", () => {
  const unknown = semanticDiff();
  unknown.entries = [{ kind: "unknown", targetId: stableId(1) }];
  expectCode(
    () => validateSemanticDiffReport(unknown),
    "REPORT_STRUCTURE_INVALID",
    "/entries/0/kind",
  );

  const missing = semanticDiff();
  missing.entries = [{ kind: "entity_added", targetId: stableId(1) }];
  expectCode(
    () => validateSemanticDiffReport(missing),
    "REPORT_STRUCTURE_INVALID",
    "/entries/0/afterRevision",
  );

  const unordered = semanticDiff();
  unordered.entries = [...unordered.entries].reverse();
  expectCode(
    () => validateSemanticDiffReport(unordered),
    "REPORT_ORDER_INVALID",
    "/entries/1",
  );

  const duplicateKey = semanticDiff();
  duplicateKey.entries = [
    duplicateKey.entries[2],
    {
      ...duplicateKey.entries[2],
      beforeStatus: "broken",
      afterStatus: "partial",
    },
  ];
  expectCode(
    () => validateSemanticDiffReport(duplicateKey),
    "REPORT_ORDER_INVALID",
    "/entries/1",
  );
});

test("rejects malformed semantic diff scalar and conditional fields", () => {
  const invalidRootCases = [
    [null, ""],
    [{ ...semanticDiff(), format: "morivyx.trace-report/0.1" }, "/format"],
    [{ ...semanticDiff(), id: "invalid" }, "/id"],
    [{ ...semanticDiff(), baseRevision: "" }, "/baseRevision"],
    [{ ...semanticDiff(), baseRevision: "invalid" }, "/baseRevision"],
    [{ ...semanticDiff(), targetRevision: "graph:" }, "/targetRevision"],
    [{ ...semanticDiff(), schemaLockDigest: "invalid" }, "/schemaLockDigest"],
    [{ ...semanticDiff(), evaluatedAt: "invalid" }, "/evaluatedAt"],
    [{ ...semanticDiff(), entries: {} }, "/entries"],
  ];
  for (const [report, pathSuffix] of invalidRootCases) {
    expectCode(
      () => validateSemanticDiffReport(report),
      "REPORT_STRUCTURE_INVALID",
      pathSuffix,
    );
  }

  const invalidEntries = [
    [null, "/entries/0"],
    [
      { kind: "entity_added", targetId: "invalid", afterRevision: digest("1") },
      "/entries/0/targetId",
    ],
    [
      { kind: "schema_changed", targetId: "invalid" },
      "/entries/0/targetId",
    ],
    [
      {
        kind: "entity_added",
        targetId: stableId(1),
        afterRevision: "invalid",
      },
      "/entries/0/afterRevision",
    ],
    [
      {
        kind: "decision_changed",
        targetId: stableId(1),
        beforeRevision: digest("1"),
        afterRevision: digest("2"),
        aspect: "unknown",
      },
      "/entries/0/aspect",
    ],
    [
      {
        kind: "goal_changed",
        targetId: stableId(1),
        beforeRevision: digest("1"),
        afterRevision: digest("2"),
        aspect: "unknown",
      },
      "/entries/0/aspect",
    ],
    [
      {
        kind: "trace_quality_changed",
        targetId: stableId(1),
        queryId: "unknown",
        beforeStatus: "partial",
        afterStatus: "complete",
      },
      "/entries/0/queryId",
    ],
    [
      {
        kind: "trace_quality_changed",
        targetId: stableId(1),
        queryId: "governing-decision",
        beforeStatus: "unknown",
        afterStatus: "complete",
      },
      "/entries/0",
    ],
    [
      {
        kind: "entity_revised",
        targetId: stableId(1),
        beforeRevision: digest("1"),
        afterRevision: digest("1"),
      },
      "/entries/0/afterRevision",
    ],
    [
      {
        kind: "entity_replaced",
        targetId: stableId(1),
        beforeRevision: digest("1"),
        afterRevision: digest("2"),
        replacementId: stableId(1),
      },
      "/entries/0/replacementId",
    ],
    [
      {
        kind: "trace_quality_changed",
        targetId: stableId(1),
        queryId: "governing-decision",
        beforeStatus: "partial",
        afterStatus: "partial",
      },
      "/entries/0/afterStatus",
    ],
  ];
  for (const [entry, pathSuffix] of invalidEntries) {
    expectCode(
      () => validateSemanticDiffReport({ ...semanticDiff(), entries: [entry] }),
      "REPORT_STRUCTURE_INVALID",
      pathSuffix,
    );
  }
});

test("rejects unsupported and unknown Report fields", async () => {
  for (const format of [
    "example.report/0.1",
    "morivyx.migration-semantic-diff/0.2",
  ]) {
    expectCode(
      () => validateReport({ format }),
      "REPORT_FORMAT_UNSUPPORTED",
      "/format",
    );
  }
  const futureMigrationDiff = {
    ...migrationSemanticDiff(),
    format: "morivyx.migration-semantic-diff/0.2",
  };
  const snapshot = structuredClone(futureMigrationDiff);
  expectCode(
    () => serializeReportYaml(futureMigrationDiff),
    "REPORT_FORMAT_UNSUPPORTED",
    "/format",
  );
  await assert.rejects(
    readReport(await writeReportFile(futureMigrationDiff)),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_FORMAT_UNSUPPORTED" &&
      error.path.endsWith("#/format"),
  );
  assert.deepEqual(futureMigrationDiff, snapshot);
  expectCode(
    () => validateTraceReport({ ...traceReport(), extra: true }),
    "REPORT_STRUCTURE_INVALID",
    "/extra",
  );
});

test("prints a validated stored Report from the command", async () => {
  const path = await writeReportFile(traceReport());
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "report", path],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.type, "trace-report");
  assert.equal(
    output.digest,
    "sha256:e2268da4eae9d3d868b483de0add3bbdb9359b4895f34043d771a0ed52b292b7",
  );
});
