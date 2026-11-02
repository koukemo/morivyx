import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import {
  migrationDigest,
  validateMigrationChangeSet,
} from "./migration.js";
import { validateMigrationSemanticDiffReport } from "./report.js";
import { migrationSemanticDiffDigest } from "./semantic-diff.js";

function failure(code, path, message) {
  throw new PackageError(code, path, message);
}

function validatePlannedSemanticDiff(migration, report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    failure(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff",
      "計画semantic diffが必要です。",
    );
  }
  if (report.format !== "morivyx.migration-semantic-diff/0.1") {
    failure(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff/format",
      "計画semantic diffの保存形式が不正です。",
    );
  }
  try {
    validateMigrationSemanticDiffReport(report);
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    failure(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      `/plannedSemanticDiff${error.path}`,
      error.message,
    );
  }
  const digest = migrationSemanticDiffDigest(report);
  if (digest !== migration.plannedSemanticDiffDigest) {
    failure(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiffDigest",
      "計画semantic diffのdigestがMigrationと一致しません。",
    );
  }
  const boundaries = [
    ["baseRevision", migration.baseRevision],
    ["targetRevision", migration.resultingRevision],
    ["sourceSchemaLockDigest", migration.sourceSchemaLockDigest],
    ["targetSchemaLockDigest", migration.targetSchemaLockDigest],
  ];
  for (const [field, expected] of boundaries) {
    if (report[field] !== expected) {
      failure(
        "MIGRATION_SEMANTIC_DIFF_MISMATCH",
        `/plannedSemanticDiff/${field}`,
        `計画semantic diffとMigrationの境界が一致しません: ${field}`,
      );
    }
  }
  return digest;
}

function validateTargetResult(migration, validation, rootDigest) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    failure(
      "MIGRATION_TARGET_VALIDATION_REQUIRED",
      "/targetValidation",
      "変換先SchemaによるValidator結果が必要です。",
    );
  }
  if (validation.valid !== true) {
    failure(
      "MIGRATION_TARGET_VALIDATION_FAILED",
      "/targetValidation/valid",
      "変換先SchemaによるValidator検査が不合格です。",
    );
  }
  if (!Array.isArray(validation.issues) || validation.issues.length > 0) {
    failure(
      "MIGRATION_TARGET_VALIDATION_FAILED",
      "/targetValidation/issues",
      "変換先SchemaによるValidator検査に問題があります。",
    );
  }
  const boundaries = [
    ["graphRevision", migration.resultingRevision],
    ["schemaLockDigest", migration.targetSchemaLockDigest],
    ["rootDigest", rootDigest],
  ];
  for (const [field, expected] of boundaries) {
    if (validation[field] !== expected) {
      failure(
        "MIGRATION_TARGET_VALIDATION_MISMATCH",
        `/targetValidation/${field}`,
        `Validator結果がMigrationの変換先と一致しません: ${field}`,
      );
    }
  }
}

export function applyMigration(input) {
  const {
    migration,
    changeSet,
    plannedSemanticDiff,
    currentRevision,
    currentElements,
    candidateElements = [],
    resultingRevision,
    targetValidation,
  } = input ?? {};
  validateMigrationChangeSet(migration, changeSet);
  const plannedDigest = validatePlannedSemanticDiff(
    migration,
    plannedSemanticDiff,
  );
  const application = applyChangeSet({
    changeSet,
    currentRevision,
    sourceSchemaLockDigest: migration.sourceSchemaLockDigest,
    targetSchemaLockDigest: migration.targetSchemaLockDigest,
    currentElements,
    candidateElements,
    resultingRevision,
  });
  validateTargetResult(migration, targetValidation, application.rootDigest);
  return {
    ...application,
    migrationDigest: migrationDigest(migration),
    plannedSemanticDiffDigest: plannedDigest,
  };
}
