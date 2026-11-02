import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateApproval, validateApprovalLedger } from "./approval.js";
import {
  canonicalJson,
  changeSetDigest,
  migrationDigest,
} from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { PackageError } from "./errors.js";
import {
  validateMigration,
  validateMigrationChangeSet,
} from "./migration.js";
import { readGraphPackage } from "./package-reader.js";
import {
  assertPackageRecordIdAvailable,
  ensurePackageRecordDirectory,
  withPackageRecordIdLock,
} from "./package-record-id.js";
import { readYamlRecord } from "./yaml-reader.js";
import { serializeYamlRecord } from "./yaml-writer.js";

function metadataPath(path) {
  const absolute = resolve(path);
  return basename(absolute) === ".morivyx"
    ? absolute
    : join(absolute, ".morivyx");
}

async function metadataDirectory(path) {
  const directory = metadataPath(path);
  let information;
  try {
    information = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PackageError(
        "PACKAGE_RECORD_PACKAGE_MISSING",
        directory,
        "記録の保存先となる.morivyxディレクトリがありません。",
      );
    }
    throw error;
  }
  if (!information.isDirectory()) {
    throw new PackageError(
      "PACKAGE_RECORD_PACKAGE_MISSING",
      directory,
      "記録の保存先.morivyxがディレクトリではありません。",
    );
  }
  return directory;
}

function recordFilename(id) {
  return `${id.slice("urn:uuid:".length)}.yaml`;
}

async function removeTemporaryFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function publishRecord({
  directory,
  record,
  digest,
  validate,
  alreadyExistsCode,
  alreadyExistsMessage,
}) {
  await ensurePackageRecordDirectory(directory);
  const targetPath = join(directory, recordFilename(record.id));
  const temporaryPath = join(
    directory,
    `.record-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o644);
  try {
    await handle.writeFile(serializeYamlRecord(record), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await removeTemporaryFile(temporaryPath);
    throw error;
  }
  await handle.close();

  try {
    const persisted = await readYamlRecord(temporaryPath);
    validate(persisted, temporaryPath);
    if (canonicalJson(persisted) !== canonicalJson(record)) {
      throw new PackageError(
        "PACKAGE_RECORD_DIGEST_MISMATCH",
        temporaryPath,
        "保存前後で記録のcanonical論理値が変化しました。",
      );
    }
    if (digest && digest(persisted) !== digest(record)) {
      throw new PackageError(
        "PACKAGE_RECORD_DIGEST_MISMATCH",
        temporaryPath,
        "保存前後で記録のdigestが変化しました。",
      );
    }
    await link(temporaryPath, targetPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new PackageError(
        alreadyExistsCode,
        targetPath,
        alreadyExistsMessage,
      );
    }
    throw error;
  } finally {
    await removeTemporaryFile(temporaryPath);
  }

  const result = {
    valid: true,
    path: targetPath,
  };
  if (digest) {
    result.digest = digest(record);
  }
  return result;
}

export async function writeApproval(path, approval) {
  validateApproval(approval);
  const directory = await metadataDirectory(path);
  const targetPath = join(directory, "approvals", recordFilename(approval.id));
  return withPackageRecordIdLock(directory, approval.id, async () => {
    const packageContents = await readGraphPackage(directory);
    await assertPackageRecordIdAvailable({
      packageContents,
      recordType: "approval",
      id: approval.id,
      targetPath,
      alreadyExistsCode: "APPROVAL_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのApprovalが既に存在します。",
    });
    validateApprovalLedger(
      [...packageContents.approvals, approval],
      [...packageContents.approvals.map(() => ""), targetPath],
    );
    return publishRecord({
      directory: join(directory, "approvals"),
      record: approval,
      validate: validateApproval,
      alreadyExistsCode: "APPROVAL_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのApprovalが既に存在します。",
    });
  });
}

export async function writeChangeSet(path, changeSet) {
  validateChangeSet(changeSet);
  const directory = await metadataDirectory(path);
  const targetPath = join(directory, "ledger", recordFilename(changeSet.id));
  return withPackageRecordIdLock(directory, changeSet.id, async () => {
    const packageContents = await readGraphPackage(directory);
    await assertPackageRecordIdAvailable({
      packageContents,
      recordType: "change-set",
      id: changeSet.id,
      targetPath,
      alreadyExistsCode: "CHANGESET_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのChangeSetが既に存在します。",
    });
    return publishRecord({
      directory: join(directory, "ledger"),
      record: changeSet,
      digest: changeSetDigest,
      validate: validateChangeSet,
      alreadyExistsCode: "CHANGESET_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのChangeSetが既に存在します。",
    });
  });
}

export async function writeMigration(path, migration) {
  validateMigration(migration);
  const directory = await metadataDirectory(path);
  const targetPath = join(
    directory,
    "migrations",
    recordFilename(migration.id),
  );
  return withPackageRecordIdLock(directory, migration.id, async () => {
    const packageContents = await readGraphPackage(directory);
    const changeSet = packageContents.changeSets.find(
      (candidate) => candidate.id === migration.changeSetId,
    );
    validateMigrationChangeSet(migration, changeSet);
    await assertPackageRecordIdAvailable({
      packageContents,
      recordType: "migration",
      id: migration.id,
      targetPath,
      alreadyExistsCode: "MIGRATION_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのMigrationが既に存在します。",
    });
    return publishRecord({
      directory: join(directory, "migrations"),
      record: migration,
      digest: migrationDigest,
      validate: validateMigration,
      alreadyExistsCode: "MIGRATION_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのMigrationが既に存在します。",
    });
  });
}
