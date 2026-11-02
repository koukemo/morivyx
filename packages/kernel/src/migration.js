import { canonicalJson, migrationDigest } from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { PackageError } from "./errors.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROOT_FIELDS = new Set([
  "format",
  "id",
  "baseRevision",
  "sourceSchemaLockDigest",
  "targetSchemaLockDigest",
  "rulesDigest",
  "mappingDigest",
  "plannedSemanticDiffDigest",
  "changeSetId",
  "resultingRevision",
  "resultingRootDigest",
  "provenance",
  "recordedAt",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(code, filePath, path, message) {
  const issuePath = filePath && path ? `${filePath}#${path}` : filePath || path;
  throw new PackageError(code, issuePath, message);
}

function assertString(value, filePath, path) {
  if (typeof value !== "string" || value.length === 0) {
    invalid("MIGRATION_INVALID", filePath, path, "空でない文字列が必要です。");
  }
}

function assertStableId(value, filePath, path) {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    invalid(
      "MIGRATION_INVALID",
      filePath,
      path,
      "小文字のUUID版4 stable IDが必要です。",
    );
  }
}

function assertDigest(value, filePath, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    invalid(
      "MIGRATION_INVALID",
      filePath,
      path,
      "小文字のSHA-256 digestが必要です。",
    );
  }
}

function assertGraphRevision(value, filePath, path) {
  if (typeof value !== "string" || !GRAPH_REVISION_PATTERN.test(value)) {
    invalid(
      "MIGRATION_INVALID",
      filePath,
      path,
      "graph:で始まるGraphRevision IDが必要です。",
    );
  }
}

function assertTimestamp(value, filePath, path) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    invalid("MIGRATION_INVALID", filePath, path, "RFC 3339形式の時刻が必要です。");
  }
  try {
    canonicalJson(value);
  } catch {
    invalid(
      "MIGRATION_INVALID",
      filePath,
      path,
      "実在する日時と時間帯が必要です。",
    );
  }
}

export function validateMigration(migration, filePath = "") {
  if (!migration || typeof migration !== "object" || Array.isArray(migration)) {
    invalid("MIGRATION_INVALID", filePath, "", "Migrationは対応表にします。");
  }
  for (const key of Object.keys(migration)) {
    if (!ROOT_FIELDS.has(key)) {
      invalid(
        "MIGRATION_INVALID",
        filePath,
        pointerChild("", key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
  if (migration.format !== "morivyx.migration/0.1") {
    invalid(
      "MIGRATION_INVALID",
      filePath,
      "/format",
      "対応していないMigration形式です。",
    );
  }
  assertStableId(migration.id, filePath, "/id");
  assertGraphRevision(migration.baseRevision, filePath, "/baseRevision");
  assertGraphRevision(migration.resultingRevision, filePath, "/resultingRevision");
  for (const field of [
    "sourceSchemaLockDigest",
    "targetSchemaLockDigest",
    "rulesDigest",
    "mappingDigest",
    "plannedSemanticDiffDigest",
    "resultingRootDigest",
  ]) {
    assertDigest(migration[field], filePath, pointerChild("", field));
  }
  if (migration.sourceSchemaLockDigest === migration.targetSchemaLockDigest) {
    invalid(
      "MIGRATION_SCHEMA_UNCHANGED",
      filePath,
      "/targetSchemaLockDigest",
      "Migrationの変換元と変換先のSchema lock digestは異なる値にします。",
    );
  }
  assertStableId(migration.changeSetId, filePath, "/changeSetId");
  if (
    !migration.provenance ||
    typeof migration.provenance !== "object" ||
    Array.isArray(migration.provenance)
  ) {
    invalid("MIGRATION_INVALID", filePath, "/provenance", "ProvenanceRecordが必要です。");
  }
  assertString(migration.provenance.method, filePath, "/provenance/method");
  assertStableId(migration.provenance.actor, filePath, "/provenance/actor");
  assertTimestamp(
    migration.provenance.recordedAt,
    filePath,
    "/provenance/recordedAt",
  );
  assertTimestamp(migration.recordedAt, filePath, "/recordedAt");
  return migration;
}

export function validateMigrationChangeSet(migration, changeSet, filePath = "") {
  validateMigration(migration, filePath);
  if (!changeSet) {
    invalid(
      "MIGRATION_CHANGESET_MISSING",
      filePath,
      "/changeSetId",
      "Migrationが参照するChangeSetがありません。",
    );
  }
  validateChangeSet(changeSet);
  const boundaries = [
    ["changeSetId", changeSet.id],
    ["baseRevision", changeSet.baseRevision],
    ["resultingRevision", changeSet.resultingRevision],
    ["resultingRootDigest", changeSet.resultingRootDigest],
    ["targetSchemaLockDigest", changeSet.schemaLockDigest],
  ];
  for (const [field, actual] of boundaries) {
    if (migration[field] !== actual) {
      invalid(
        "MIGRATION_CHANGESET_MISMATCH",
        filePath,
        pointerChild("", field),
        `MigrationとChangeSetの境界が一致しません: ${field}`,
      );
    }
  }
  return true;
}

export { migrationDigest };
