import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionId } from "../src/canonical.js";
import { applyChangeSet } from "../src/changeset-apply.js";
import { PackageError } from "../src/errors.js";
import { applyMigration } from "../src/migration-apply.js";
import { readGraphPackage } from "../src/package-reader.js";
import { migrationSemanticDiffDigest } from "../src/semantic-diff.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const sourceSchemaLockDigest =
  "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842";
const targetSchemaLockDigest =
  "sha256:85724a0823d941a238089f9de10f1fd81d5ff5710cc6f873a88bb067a58eb10d";
const resultingRootDigest =
  "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538";

function migration() {
  return {
    format: "morivyx.migration/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440014",
    baseRevision: "graph:stage-1-package-v1",
    sourceSchemaLockDigest,
    targetSchemaLockDigest,
    rulesDigest:
      "sha256:8800ac85f305b58f6863ea94ad51113e8abd7a1ffeebbe4956d98492bb758854",
    mappingDigest:
      "sha256:7b948be1c612ec87bd6ec317af7c2c38896fe0b447d8ada0a041f8db85863f5a",
    plannedSemanticDiffDigest: migrationSemanticDiffDigest(
      plannedSemanticDiff(),
    ),
    changeSetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440012",
    resultingRevision: "graph:stage-1-migration-v1",
    resultingRootDigest,
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-03T00:00:00Z",
    },
    recordedAt: "2026-08-03T00:00:00Z",
  };
}

function changeSet() {
  return {
    format: "morivyx.changeset/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440012",
    baseRevision: "graph:stage-1-package-v1",
    resultingRevision: "graph:stage-1-migration-v1",
    resultingRootDigest,
    schemaLockDigest: targetSchemaLockDigest,
    operations: [
      {
        op: "revise",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        beforeRevision:
          "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
        afterRevision:
          "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
      },
      {
        op: "create",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
        afterRevision:
          "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
      },
    ],
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-03T00:00:00Z",
    },
    recordedAt: "2026-08-03T00:00:00Z",
  };
}

function plannedSemanticDiff() {
  return {
    format: "morivyx.migration-semantic-diff/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440013",
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-migration-v1",
    sourceSchemaLockDigest,
    targetSchemaLockDigest,
    evaluatedAt: "2026-08-03T00:00:00Z",
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
      { kind: "schema_changed", targetId: "morivyx.core" },
    ],
  };
}

function candidateElements(base) {
  const revised = structuredClone(base.elements[0]);
  revised.attributes.stringValues[2] = "revised";
  revised.revision = revisionId(revised);
  const created = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
    type: "core.observation",
    typeVersion: "0.1",
    revision:
      "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
    lifecycle: "draft",
    reviewState: "unreviewed",
    attributes: {
      observedAt: "2026-07-31T04:00:00Z",
      recordedAt: "2026-07-31T04:05:00Z",
      stringValues: ["third"],
    },
    provenance: {
      method: "observed",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-07-31T04:05:00Z",
    },
  };
  return [revised, created];
}

async function vectorInput() {
  const base = await readGraphPackage(fixture);
  const migrationRecord = migration();
  return {
    migration: migrationRecord,
    changeSet: changeSet(),
    plannedSemanticDiff: plannedSemanticDiff(),
    currentRevision: base.revision,
    currentElements: base.elements,
    candidateElements: candidateElements(base),
    resultingRevision: {
      format: "morivyx.graph-revision/0.1",
      id: migrationRecord.resultingRevision,
      parentRevision: migrationRecord.baseRevision,
      rootDigest: migrationRecord.resultingRootDigest,
      schemaLockDigest: migrationRecord.targetSchemaLockDigest,
    },
    targetValidation: {
      valid: true,
      graphRevision: migrationRecord.resultingRevision,
      schemaLockDigest: migrationRecord.targetSchemaLockDigest,
      rootDigest: migrationRecord.resultingRootDigest,
      issues: [],
    },
  };
}

function expectCode(action, code, path) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}

test("applies the Migration validation vector across Schema locks", async () => {
  const input = await vectorInput();
  const result = applyMigration(input);

  assert.equal(result.rootDigest, resultingRootDigest);
  assert.equal(
    result.plannedSemanticDiffDigest,
    input.migration.plannedSemanticDiffDigest,
  );
  assert.equal(
    result.migrationDigest,
    "sha256:db4ff26038cdc82d8972ab41269a0a8d4b8c1ebc0e482a17e12243735c7b82b8",
  );
});

test("keeps ordinary ChangeSet application on one Schema lock", async () => {
  const input = await vectorInput();
  expectCode(
    () =>
      applyChangeSet({
        changeSet: input.changeSet,
        currentRevision: input.currentRevision,
        schemaLockDigest: sourceSchemaLockDigest,
        currentElements: input.currentElements,
        candidateElements: input.candidateElements,
        resultingRevision: input.resultingRevision,
      }),
    "CHANGESET_SCHEMA_LOCK_MISMATCH",
    "/schemaLockDigest",
  );
});

test("rejects planned semantic diff digest and boundary mismatches", async () => {
  const input = await vectorInput();
  const missing = { ...input, plannedSemanticDiff: undefined };
  const digestMismatch = structuredClone(input);
  digestMismatch.plannedSemanticDiff.evaluatedAt = "2026-08-03T00:00:01Z";
  const boundaryMismatch = structuredClone(input);
  boundaryMismatch.plannedSemanticDiff.baseRevision = "graph:other";
  boundaryMismatch.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
    boundaryMismatch.plannedSemanticDiff,
  );
  const sourceSchemaMismatch = structuredClone(input);
  sourceSchemaMismatch.plannedSemanticDiff.sourceSchemaLockDigest =
    `sha256:${"f".repeat(64)}`;
  sourceSchemaMismatch.migration.plannedSemanticDiffDigest =
    migrationSemanticDiffDigest(sourceSchemaMismatch.plannedSemanticDiff);
  const targetSchemaMismatch = structuredClone(input);
  targetSchemaMismatch.plannedSemanticDiff.targetSchemaLockDigest =
    `sha256:${"e".repeat(64)}`;
  targetSchemaMismatch.migration.plannedSemanticDiffDigest =
    migrationSemanticDiffDigest(targetSchemaMismatch.plannedSemanticDiff);
  const schemaEntryMissing = structuredClone(input);
  schemaEntryMissing.plannedSemanticDiff.entries =
    schemaEntryMissing.plannedSemanticDiff.entries.filter(
      ({ kind }) => kind !== "schema_changed",
    );
  schemaEntryMissing.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
    schemaEntryMissing.plannedSemanticDiff,
  );
  const invalidStructure = structuredClone(input);
  invalidStructure.plannedSemanticDiff.entries[0].targetId = "invalid";
  invalidStructure.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
    invalidStructure.plannedSemanticDiff,
  );

  expectCode(
    () => applyMigration(missing),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff",
  );
  for (const format of [
    "morivyx.semantic-diff/0.1",
    "morivyx.migration-semantic-diff/0.2",
    "morivyx.semantic-diff/unknown",
  ]) {
    const incompatible = structuredClone(input);
    incompatible.plannedSemanticDiff.format = format;
    const snapshot = structuredClone(incompatible);
    expectCode(
      () => applyMigration(incompatible),
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff/format",
    );
    assert.deepEqual(incompatible, snapshot);
  }
  expectCode(
    () => applyMigration(digestMismatch),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiffDigest",
  );
  expectCode(
    () => applyMigration(boundaryMismatch),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff/baseRevision",
  );
  expectCode(
    () => applyMigration(sourceSchemaMismatch),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff/sourceSchemaLockDigest",
  );
  expectCode(
    () => applyMigration(targetSchemaMismatch),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff/targetSchemaLockDigest",
  );
  expectCode(
    () => applyMigration(schemaEntryMissing),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff/entries",
  );
  expectCode(
    () => applyMigration(invalidStructure),
    "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    "/plannedSemanticDiff/entries/0/targetId",
  );
});

test("requires a matching successful target Validator result", async () => {
  for (const input of [null, undefined]) {
    expectCode(() => applyMigration(input), "MIGRATION_INVALID", "");
  }
  const input = await vectorInput();
  const missing = { ...input, targetValidation: undefined };
  const failed = structuredClone(input);
  failed.targetValidation.valid = false;
  failed.targetValidation.issues = [{ code: "SCHEMA_REQUIRED_FIELD" }];
  const malformedIssues = structuredClone(input);
  malformedIssues.targetValidation.issues = {};
  const reportedIssues = structuredClone(input);
  reportedIssues.targetValidation.issues = [
    { code: "SCHEMA_REQUIRED_FIELD" },
  ];
  const wrongRevision = structuredClone(input);
  wrongRevision.targetValidation.graphRevision = "graph:other";
  const wrongSchema = structuredClone(input);
  wrongSchema.targetValidation.schemaLockDigest = sourceSchemaLockDigest;
  const wrongRoot = structuredClone(input);
  wrongRoot.targetValidation.rootDigest = `sha256:${"0".repeat(64)}`;

  expectCode(
    () => applyMigration(missing),
    "MIGRATION_TARGET_VALIDATION_REQUIRED",
    "/targetValidation",
  );
  expectCode(
    () => applyMigration(failed),
    "MIGRATION_TARGET_VALIDATION_FAILED",
    "/targetValidation/valid",
  );
  expectCode(
    () => applyMigration(malformedIssues),
    "MIGRATION_TARGET_VALIDATION_FAILED",
    "/targetValidation/issues",
  );
  expectCode(
    () => applyMigration(reportedIssues),
    "MIGRATION_TARGET_VALIDATION_FAILED",
    "/targetValidation/issues",
  );
  expectCode(
    () => applyMigration(wrongRevision),
    "MIGRATION_TARGET_VALIDATION_MISMATCH",
    "/targetValidation/graphRevision",
  );
  expectCode(
    () => applyMigration(wrongSchema),
    "MIGRATION_TARGET_VALIDATION_MISMATCH",
    "/targetValidation/schemaLockDigest",
  );
  expectCode(
    () => applyMigration(wrongRoot),
    "MIGRATION_TARGET_VALIDATION_MISMATCH",
    "/targetValidation/rootDigest",
  );
});

test("rejects a wrong source Schema without mutating inputs", async () => {
  const input = await vectorInput();
  const snapshot = structuredClone(input);
  input.currentRevision.schemaLockDigest = `sha256:${"0".repeat(64)}`;

  expectCode(
    () => applyMigration(input),
    "CHANGESET_SCHEMA_LOCK_MISMATCH",
    "/schemaLockDigest",
  );
  assert.deepEqual(input.currentElements, snapshot.currentElements);
  assert.deepEqual(input.candidateElements, snapshot.candidateElements);
});
