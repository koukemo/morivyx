import assert from "node:assert/strict";
import test from "node:test";
import { PackageError } from "../src/errors.js";
import {
  migrationDigest,
  validateMigration,
  validateMigrationChangeSet,
} from "../src/migration.js";

const sourceSchemaLockDigest =
  "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842";
const targetSchemaLockDigest =
  "sha256:85724a0823d941a238089f9de10f1fd81d5ff5710cc6f873a88bb067a58eb10d";

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
    plannedSemanticDiffDigest:
      "sha256:58cd060db029a17b8095c8fd8b8d55841792004a565ebebe4976993ada791090",
    changeSetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440012",
    resultingRevision: "graph:stage-1-migration-v1",
    resultingRootDigest:
      "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538",
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-03T00:00:00Z",
    },
    recordedAt: "2026-08-03T00:00:00Z",
  };
}

function changeSet() {
  const value = migration();
  return {
    format: "morivyx.changeset/0.1",
    id: value.changeSetId,
    baseRevision: value.baseRevision,
    resultingRevision: value.resultingRevision,
    resultingRootDigest: value.resultingRootDigest,
    schemaLockDigest: value.targetSchemaLockDigest,
    operations: [
      {
        op: "create",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
        afterRevision:
          "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
      },
    ],
    provenance: structuredClone(value.provenance),
    recordedAt: value.recordedAt,
  };
}

function expectCode(action, code, path, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  }, message);
}

test("matches the Migration digest validation vector", () => {
  const value = migration();
  assert.equal(
    migrationDigest(validateMigration(value)),
    "sha256:db4ff26038cdc82d8972ab41269a0a8d4b8c1ebc0e482a17e12243735c7b82b8",
  );

  const renamed = { ...value, id: "urn:uuid:550e8400-e29b-41d4-a716-446655440015" };
  assert.equal(migrationDigest(renamed), migrationDigest(value));
});

test("rejects invalid Migration value forms with precise paths", () => {
  const emptyMethod = migration();
  emptyMethod.provenance.method = "";
  const cases = [
    ["mapping root", null, ""],
    [
      "format",
      { ...migration(), format: "morivyx.migration/unknown" },
      "/format",
    ],
    [
      "future format",
      { ...migration(), format: "morivyx.migration/0.2" },
      "/format",
    ],
    ["stable ID", { ...migration(), id: "not-a-stable-id" }, "/id"],
    [
      "GraphRevision ID",
      { ...migration(), baseRevision: "revision" },
      "/baseRevision",
    ],
    [
      "ProvenanceRecord",
      { ...migration(), provenance: null },
      "/provenance",
    ],
    ["provenance method", emptyMethod, "/provenance/method"],
    [
      "timestamp format",
      { ...migration(), recordedAt: "2026-08-03T00:00:00" },
      "/recordedAt",
    ],
  ];

  for (const [name, value, path] of cases) {
    expectCode(
      () => validateMigration(value),
      "MIGRATION_INVALID",
      path,
      name,
    );
  }
});

test("rejects invalid Migration structure and an unchanged Schema", () => {
  const unchanged = migration();
  unchanged.targetSchemaLockDigest = unchanged.sourceSchemaLockDigest;
  const missingDigest = migration();
  delete missingDigest.plannedSemanticDiffDigest;
  const unknown = migration();
  unknown.extra = "value";
  const badRecordedAt = migration();
  badRecordedAt.recordedAt = "2026-02-30T00:00:00Z";
  const badProvenanceTime = migration();
  badProvenanceTime.provenance.recordedAt = "2026-08-03T00:00:00+14:01";
  const badUtcYear = migration();
  badUtcYear.recordedAt = "9999-12-31T23:59:59-14:00";
  const offsetTime = migration();
  offsetTime.recordedAt = "2026-08-03T09:00:00+09:00";
  offsetTime.provenance.recordedAt = "2026-08-03T09:00:00+09:00";

  expectCode(
    () => validateMigration(unchanged),
    "MIGRATION_SCHEMA_UNCHANGED",
    "/targetSchemaLockDigest",
  );
  expectCode(
    () => validateMigration(missingDigest),
    "MIGRATION_INVALID",
    "/plannedSemanticDiffDigest",
  );
  expectCode(() => validateMigration(unknown), "MIGRATION_INVALID", "/extra");
  expectCode(
    () => validateMigration(badRecordedAt),
    "MIGRATION_INVALID",
    "/recordedAt",
  );
  expectCode(
    () => validateMigration(badProvenanceTime),
    "MIGRATION_INVALID",
    "/provenance/recordedAt",
  );
  expectCode(
    () => validateMigration(badUtcYear),
    "MIGRATION_INVALID",
    "/recordedAt",
  );
  assert.equal(validateMigration(offsetTime), offsetTime);
});

test("accepts a ChangeSet matching every Migration boundary", () => {
  assert.equal(validateMigrationChangeSet(migration(), changeSet()), true);
});

test("rejects a missing or mismatched generated ChangeSet", () => {
  expectCode(
    () => validateMigrationChangeSet(migration(), undefined),
    "MIGRATION_CHANGESET_MISSING",
    "/changeSetId",
  );
  const cases = [
    ["changeSetId", "id", "urn:uuid:550e8400-e29b-41d4-a716-446655440099"],
    ["baseRevision", "baseRevision", "graph:other"],
    ["resultingRevision", "resultingRevision", "graph:other"],
    ["resultingRootDigest", "resultingRootDigest", `sha256:${"0".repeat(64)}`],
    ["targetSchemaLockDigest", "schemaLockDigest", `sha256:${"0".repeat(64)}`],
  ];
  for (const [migrationField, changeSetField, value] of cases) {
    const candidate = changeSet();
    candidate[changeSetField] = value;
    expectCode(
      () => validateMigrationChangeSet(migration(), candidate),
      "MIGRATION_CHANGESET_MISMATCH",
      `/${migrationField}`,
    );
  }
});
