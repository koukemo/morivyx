import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  canonicalJson,
  changeSetDigest,
  compareUnicode,
  migrationDigest,
  schemaDefinitionDigest,
  schemaLockDigest,
} from "./canonical.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { writeChangeSet, writeMigration } from "./ledger-store.js";
import { applyMigration } from "./migration-apply.js";
import { validateMigrationChangeSet } from "./migration.js";
import { readGraphPackage } from "./package-reader.js";
import { validateReport, writeReport } from "./report.js";
import { validateSchemaDefinition } from "./schema-definition.js";
import { validateSchemaLock } from "./schema-lock.js";
import { resolveSchemaRegistry, schemaKey } from "./schema-registry.js";
import {
  migrationSemanticDiffDigest,
  migrationSchemaChangeEntries,
  semanticDiffStructuralEntries,
} from "./semantic-diff.js";
import { validateGraph, validatePackage } from "./validator.js";
import { serializeYamlRecord } from "./yaml-writer.js";

function metadataPath(path) {
  const absolute = resolve(path);
  return basename(absolute) === ".morivyx"
    ? absolute
    : join(absolute, ".morivyx");
}

function recordFilename(id) {
  return `${id.slice("urn:uuid:".length)}.yaml`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isWithin(directory, path) {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function resolveOutputRoot(basePath, outputPath) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new PackageError(
      "PACKAGE_OUTPUT_INVALID",
      "/outputPath",
      "出力Packageのpathが必要です。",
    );
  }
  const outputRoot = resolve(outputPath);
  const baseRoot = dirname(metadataPath(basePath));
  if (
    basename(outputRoot) === ".morivyx" ||
    isWithin(baseRoot, outputRoot)
  ) {
    throw new PackageError(
      "PACKAGE_OUTPUT_INVALID",
      "/outputPath",
      "出力先にはbase Package外にあるPackage rootを指定します。",
    );
  }
  if (await pathExists(outputRoot)) {
    throw new PackageError(
      "PACKAGE_OUTPUT_EXISTS",
      outputRoot,
      "出力先が既に存在するため上書きしません。",
    );
  }
  return outputRoot;
}

async function resolveThroughExistingAncestor(path) {
  let ancestor = resolve(path);
  const missingSegments = [];
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missingSegments.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertRealOutputOutsideBase(basePath, outputRoot) {
  const [baseRealPath, outputParentRealPath] = await Promise.all([
    realpath(dirname(metadataPath(basePath))),
    resolveThroughExistingAncestor(dirname(outputRoot)),
  ]);
  if (
    isWithin(
      baseRealPath,
      join(outputParentRealPath, basename(outputRoot)),
    )
  ) {
    throw new PackageError(
      "PACKAGE_OUTPUT_INVALID",
      "/outputPath",
      "出力先の実パスはbase Package外に指定します。",
    );
  }
}

async function writeSyncedRecord(path, record) {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(serializeYamlRecord(record), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeTemporaryPackage(path) {
  await rm(path, { recursive: true, force: true });
}

function assertVerifiedPackage(verified, applied, changeSet) {
  const sortElements = (elements) =>
    [...elements].sort((left, right) => compareUnicode(left.id, right.id));
  if (
    verified.revision.id !== applied.revision.id ||
    verified.revision.rootDigest !== applied.rootDigest ||
    canonicalJson(sortElements(verified.elements)) !==
      canonicalJson(sortElements(applied.elements))
  ) {
    throw new PackageError(
      "PACKAGE_OUTPUT_MISMATCH",
      "/outputPath",
      "再読込したPackageがChangeSet適用結果と一致しません。",
    );
  }
  const stored = verified.changeSets.find((record) => record.id === changeSet.id);
  if (!stored || changeSetDigest(stored) !== changeSetDigest(changeSet)) {
    throw new PackageError(
      "PACKAGE_OUTPUT_MISMATCH",
      "/outputPath/.morivyx/ledger",
      "適用したChangeSetが出力Packageのledgerと一致しません。",
    );
  }
}

export async function writeAppliedPackage(input) {
  const {
    basePath,
    outputPath,
    changeSet,
    candidateElements = [],
    resultingRevision,
    appliedChangeSetIds = [],
  } = input ?? {};
  const outputRoot = await resolveOutputRoot(basePath, outputPath);

  const base = await readGraphPackage(basePath);
  if (Array.isArray(candidateElements)) {
    candidateElements.forEach((element, index) =>
      validateGraphElement(element, `/candidateElements/${index}`),
    );
  }
  let existingChangeSet;
  const knownChangeSetIds = [];
  const inferredAppliedChangeSetIds = [];
  for (const record of base.changeSets) {
    knownChangeSetIds.push(record.id);
    if (record.id === changeSet?.id) {
      existingChangeSet = record;
    }
    if (
      record.baseRevision === base.revision.parentRevision &&
      record.resultingRevision === base.revision.id &&
      record.resultingRootDigest === base.revision.rootDigest &&
      record.schemaLockDigest === base.revision.schemaLockDigest
    ) {
      inferredAppliedChangeSetIds.push(record.id);
    }
  }
  let effectiveAppliedChangeSetIds = appliedChangeSetIds;
  if (Array.isArray(appliedChangeSetIds)) {
    effectiveAppliedChangeSetIds = [...appliedChangeSetIds];
    for (const id of inferredAppliedChangeSetIds) {
      if (!effectiveAppliedChangeSetIds.includes(id)) {
        effectiveAppliedChangeSetIds.push(id);
      }
    }
  }
  const applied = applyChangeSet({
    changeSet,
    currentRevision: base.revision,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    currentElements: base.elements,
    candidateElements,
    resultingRevision,
    knownChangeSetIds,
    appliedChangeSetIds: effectiveAppliedChangeSetIds,
  });
  if (
    existingChangeSet &&
    changeSetDigest(existingChangeSet) !== changeSetDigest(changeSet)
  ) {
    throw new PackageError(
      "CHANGESET_ALREADY_EXISTS",
      "/changeSet/id",
      "同じstable IDの異なるChangeSetがbase Packageにあります。",
    );
  }
  const registry = await resolveSchemaRegistry(
    base.directory,
    base.schemaLock,
  );
  const targetValidation = validateGraph({
    graphRevision: applied.revision.id,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    schemas: registry.schemas,
    elements: applied.elements,
    previousElements: base.elements,
    approvals: base.approvals,
    registryIssues: registry.issues,
  });
  if (targetValidation.valid !== true) {
    throw new PackageError(
      "CHANGESET_TARGET_VALIDATION_FAILED",
      "/candidateElements",
      "ChangeSet適用後のGraphが固定Schemaの検査に失敗しました。",
    );
  }

  await assertRealOutputOutsideBase(basePath, outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  const temporaryRoot = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}-${process.pid}-${randomUUID()}.tmp`,
  );
  const temporaryMetadata = join(temporaryRoot, ".morivyx");
  let temporaryCreated = false;
  let claimedOutput = false;
  try {
    await mkdir(temporaryRoot);
    temporaryCreated = true;
    await cp(metadataPath(basePath), temporaryMetadata, {
      recursive: true,
      dereference: true,
    });
    await rm(join(temporaryMetadata, "index.json"), { force: true });
    await rm(join(temporaryMetadata, "graph"), {
      recursive: true,
      force: true,
    });
    await rm(join(temporaryMetadata, "revision.yaml"), { force: true });
    const entityDirectory = join(temporaryMetadata, "graph", "entities");
    const relationDirectory = join(temporaryMetadata, "graph", "relations");
    await mkdir(entityDirectory, { recursive: true });
    await mkdir(relationDirectory, { recursive: true });

    for (const element of applied.elements) {
      const directory =
        element.kind === "entity" ? entityDirectory : relationDirectory;
      await writeSyncedRecord(
        join(directory, recordFilename(element.id)),
        element,
      );
    }
    await writeSyncedRecord(
      join(temporaryMetadata, "revision.yaml"),
      applied.revision,
    );
    if (!existingChangeSet) {
      await writeChangeSet(temporaryRoot, changeSet);
    }

    const verified = await readGraphPackage(temporaryRoot);
    assertVerifiedPackage(verified, applied, changeSet);
    const outputValidation = await validatePackage(temporaryRoot);
    if (
      outputValidation.valid !== true ||
      outputValidation.graphRevision !== targetValidation.graphRevision ||
      outputValidation.schemaLockDigest !== targetValidation.schemaLockDigest ||
      outputValidation.rootDigest !== targetValidation.rootDigest
    ) {
      throw new PackageError(
        "CHANGESET_TARGET_VALIDATION_FAILED",
        "/outputPath",
        "出力PackageのChangeSet適用後検査が一致しません。",
      );
    }

    try {
      await mkdir(outputRoot);
      claimedOutput = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PackageError(
          "PACKAGE_OUTPUT_EXISTS",
          outputRoot,
          "出力先が既に存在するため上書きしません。",
        );
      }
      throw error;
    }
    await rename(temporaryMetadata, join(outputRoot, ".morivyx"));
    await removeTemporaryPackage(temporaryRoot);
  } catch (error) {
    if (temporaryCreated) {
      await removeTemporaryPackage(temporaryRoot);
    }
    if (claimedOutput) {
      await removeTemporaryPackage(outputRoot);
    }
    throw error;
  }

  return {
    valid: true,
    outputPath: outputRoot,
    metadataPath: join(outputRoot, ".morivyx"),
    graphRevision: applied.revision.id,
    rootDigest: applied.rootDigest,
    elementCount: applied.elements.length,
    changeSetId: changeSet.id,
  };
}

function findRecord(records, id) {
  for (const record of records) {
    if (record.id === id) {
      return record;
    }
  }
  return undefined;
}

function findStoredReport(results, id) {
  for (const result of results) {
    if (result.report?.id === id) {
      return result.report;
    }
  }
  return undefined;
}

function assertExistingRecord(existing, record, digest, code, path, message) {
  if (existing && digest(existing) !== digest(record)) {
    throw new PackageError(code, path, message);
  }
}

function targetSchemaMap(targetSchemaLock, targetSchemaDefinitions) {
  validateSchemaLock(targetSchemaLock, "/targetSchemaLock");
  if (!Array.isArray(targetSchemaDefinitions)) {
    throw new PackageError(
      "MIGRATION_TARGET_SCHEMA_MISMATCH",
      "/targetSchemaDefinitions",
      "変換先Schema定義の一覧が必要です。",
    );
  }
  const schemas = new Map();
  targetSchemaDefinitions.forEach((definition, index) => {
    const path = `/targetSchemaDefinitions/${index}`;
    validateSchemaDefinition(definition, path);
    const key = schemaKey(definition.schemaId, definition.version);
    if (schemas.has(key)) {
      throw new PackageError(
        "MIGRATION_TARGET_SCHEMA_MISMATCH",
        `${path}/schemaId`,
        "変換先Schema定義が重複しています。",
      );
    }
    schemas.set(key, definition);
  });
  if (schemas.size !== targetSchemaLock.schemas.length) {
    throw new PackageError(
      "MIGRATION_TARGET_SCHEMA_MISMATCH",
      "/targetSchemaDefinitions",
      "Schema lockと変換先Schema定義の件数が一致しません。",
    );
  }
  targetSchemaLock.schemas.forEach((locked, index) => {
    const definition = schemas.get(schemaKey(locked.schemaId, locked.version));
    if (!definition || schemaDefinitionDigest(definition) !== locked.digest) {
      throw new PackageError(
        "MIGRATION_TARGET_SCHEMA_MISMATCH",
        `/targetSchemaLock/schemas/${index}/digest`,
        "Schema lockと変換先Schema定義のdigestが一致しません。",
      );
    }
  });
  return schemas;
}

function validateMigrationSchemaChanges(
  plannedSemanticDiff,
  sourceSchemaLock,
  targetSchemaLock,
) {
  const actual = plannedSemanticDiff.entries.filter(
    ({ kind }) => kind === "schema_changed",
  );
  const expected = migrationSchemaChangeEntries(
    sourceSchemaLock,
    targetSchemaLock,
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new PackageError(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff/entries",
      "計画semantic diffのSchema変更がSchema lockの実差分と一致しません。",
    );
  }
}

function validateMigrationStructuralChanges(
  plannedSemanticDiff,
  baseElements,
  targetElements,
) {
  const actual = plannedSemanticDiff.entries.filter(
    ({ kind }) =>
      kind !== "schema_changed" && kind !== "trace_quality_changed",
  );
  const expected = semanticDiffStructuralEntries(baseElements, targetElements);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new PackageError(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff/entries",
      "計画semantic diffのGraph変更が適用前後Graphの実差分と一致しません。",
    );
  }
}

function validateMigrationPlanReport(plannedSemanticDiff) {
  if (
    plannedSemanticDiff &&
    typeof plannedSemanticDiff === "object" &&
    !Array.isArray(plannedSemanticDiff) &&
    plannedSemanticDiff.format !== "morivyx.migration-semantic-diff/0.1"
  ) {
    throw new PackageError(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      "/plannedSemanticDiff/format",
      "Migration計画差分の保存形式が不正です。",
    );
  }
  try {
    const validated = validateReport(plannedSemanticDiff);
    if (validated.type !== "migration-semantic-diff") {
      throw new PackageError(
        "MIGRATION_SEMANTIC_DIFF_MISMATCH",
        "/format",
        "Migration計画差分の保存形式が不正です。",
      );
    }
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    throw new PackageError(
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      `/plannedSemanticDiff${error.path}`,
      error.message,
    );
  }
}

export async function writeMigratedPackage(input) {
  const {
    basePath,
    outputPath,
    migration,
    changeSet,
    plannedSemanticDiff,
    candidateElements = [],
    resultingRevision,
    targetSchemaLock,
    targetSchemaDefinitions,
  } = input ?? {};
  const outputRoot = await resolveOutputRoot(basePath, outputPath);

  const base = await readGraphPackage(basePath);
  if (Array.isArray(candidateElements)) {
    candidateElements.forEach((element, index) =>
      validateGraphElement(element, `/candidateElements/${index}`),
    );
  }
  validateMigrationChangeSet(migration, changeSet);
  validateMigrationPlanReport(plannedSemanticDiff);
  const targetSchemas = targetSchemaMap(
    targetSchemaLock,
    targetSchemaDefinitions,
  );
  const targetDigest = schemaLockDigest(targetSchemaLock);
  if (targetDigest !== migration.targetSchemaLockDigest) {
    throw new PackageError(
      "MIGRATION_TARGET_SCHEMA_MISMATCH",
      "/targetSchemaLock",
      "変換先Schema lockのdigestがMigrationと一致しません。",
    );
  }
  validateMigrationSchemaChanges(
    plannedSemanticDiff,
    base.schemaLock,
    targetSchemaLock,
  );

  const provisional = applyChangeSet({
    changeSet,
    currentRevision: base.revision,
    sourceSchemaLockDigest: migration.sourceSchemaLockDigest,
    targetSchemaLockDigest: migration.targetSchemaLockDigest,
    currentElements: base.elements,
    candidateElements,
    resultingRevision,
  });
  validateMigrationStructuralChanges(
    plannedSemanticDiff,
    base.elements,
    provisional.elements,
  );
  const targetValidation = validateGraph({
    graphRevision: provisional.revision.id,
    schemaLockDigest: targetDigest,
    schemas: targetSchemas,
    elements: provisional.elements,
    previousElements: base.elements,
    approvals: base.approvals,
  });
  const applied = applyMigration({
    migration,
    changeSet,
    plannedSemanticDiff,
    currentRevision: base.revision,
    currentElements: base.elements,
    candidateElements,
    resultingRevision,
    targetValidation,
  });

  const existingChangeSet = findRecord(base.changeSets, changeSet.id);
  const existingMigration = findRecord(base.migrations, migration.id);
  const existingReport = findStoredReport(base.reports, plannedSemanticDiff.id);
  assertExistingRecord(
    existingChangeSet,
    changeSet,
    changeSetDigest,
    "CHANGESET_ALREADY_EXISTS",
    "/changeSet/id",
    "同じstable IDの異なるChangeSetがbase Packageにあります。",
  );
  assertExistingRecord(
    existingMigration,
    migration,
    migrationDigest,
    "MIGRATION_ALREADY_EXISTS",
    "/migration/id",
    "同じstable IDの異なるMigrationがbase Packageにあります。",
  );
  assertExistingRecord(
    existingReport,
    plannedSemanticDiff,
    migrationSemanticDiffDigest,
    "REPORT_ALREADY_EXISTS",
    "/plannedSemanticDiff/id",
    "同じstable IDの異なる計画semantic diffがbase Packageにあります。",
  );

  await assertRealOutputOutsideBase(basePath, outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  const temporaryRoot = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}-${process.pid}-${randomUUID()}.tmp`,
  );
  const temporaryMetadata = join(temporaryRoot, ".morivyx");
  let temporaryCreated = false;
  let claimedOutput = false;
  try {
    await mkdir(temporaryRoot);
    temporaryCreated = true;
    await cp(metadataPath(basePath), temporaryMetadata, {
      recursive: true,
      dereference: true,
    });
    await rm(join(temporaryMetadata, "index.json"), { force: true });
    await rm(join(temporaryMetadata, "graph"), {
      recursive: true,
      force: true,
    });
    await rm(join(temporaryMetadata, "revision.yaml"), { force: true });
    await rm(join(temporaryMetadata, "schema.lock.yaml"), { force: true });
    await rm(join(temporaryMetadata, "schemas"), {
      recursive: true,
      force: true,
    });
    const entityDirectory = join(temporaryMetadata, "graph", "entities");
    const relationDirectory = join(temporaryMetadata, "graph", "relations");
    const schemaDirectory = join(temporaryMetadata, "schemas");
    await mkdir(entityDirectory, { recursive: true });
    await mkdir(relationDirectory, { recursive: true });
    await mkdir(schemaDirectory, { recursive: true });

    for (const element of applied.elements) {
      const directory =
        element.kind === "entity" ? entityDirectory : relationDirectory;
      await writeSyncedRecord(
        join(directory, recordFilename(element.id)),
        element,
      );
    }
    await writeSyncedRecord(
      join(temporaryMetadata, "revision.yaml"),
      applied.revision,
    );
    await writeSyncedRecord(
      join(temporaryMetadata, "schema.lock.yaml"),
      targetSchemaLock,
    );
    for (const definition of targetSchemaDefinitions) {
      await writeSyncedRecord(
        join(
          schemaDirectory,
          `${schemaKey(definition.schemaId, definition.version)}.yaml`,
        ),
        definition,
      );
    }
    if (!existingChangeSet) {
      await writeChangeSet(temporaryRoot, changeSet);
    }
    if (!existingMigration) {
      await writeMigration(temporaryRoot, migration);
    }
    if (!existingReport) {
      await writeReport(temporaryRoot, plannedSemanticDiff);
    }

    const verified = await readGraphPackage(temporaryRoot);
    assertVerifiedPackage(verified, applied, changeSet);
    const storedMigration = findRecord(verified.migrations, migration.id);
    const storedReport = findStoredReport(
      verified.reports,
      plannedSemanticDiff.id,
    );
    if (
      verified.calculatedSchemaLockDigest !== targetDigest ||
      !storedMigration ||
      migrationDigest(storedMigration) !== migrationDigest(migration) ||
      !storedReport ||
      migrationSemanticDiffDigest(storedReport) !==
        migrationSemanticDiffDigest(plannedSemanticDiff)
    ) {
      throw new PackageError(
        "PACKAGE_OUTPUT_MISMATCH",
        "/outputPath/.morivyx",
        "Schema lock、Migration、または計画semantic diffが一致しません。",
      );
    }
    const outputValidation = await validatePackage(temporaryRoot);
    if (
      outputValidation.valid !== true ||
      outputValidation.graphRevision !== targetValidation.graphRevision ||
      outputValidation.schemaLockDigest !== targetValidation.schemaLockDigest ||
      outputValidation.rootDigest !== targetValidation.rootDigest
    ) {
      throw new PackageError(
        "MIGRATION_TARGET_VALIDATION_FAILED",
        "/outputPath",
        "出力Packageの変換先Schema検証が一致しません。",
      );
    }

    try {
      await mkdir(outputRoot);
      claimedOutput = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PackageError(
          "PACKAGE_OUTPUT_EXISTS",
          outputRoot,
          "出力先が既に存在するため上書きしません。",
        );
      }
      throw error;
    }
    await rename(temporaryMetadata, join(outputRoot, ".morivyx"));
    await removeTemporaryPackage(temporaryRoot);
  } catch (error) {
    if (temporaryCreated) {
      await removeTemporaryPackage(temporaryRoot);
    }
    if (claimedOutput) {
      await removeTemporaryPackage(outputRoot);
    }
    throw error;
  }

  return {
    valid: true,
    outputPath: outputRoot,
    metadataPath: join(outputRoot, ".morivyx"),
    graphRevision: applied.revision.id,
    rootDigest: applied.rootDigest,
    elementCount: applied.elements.length,
    changeSetId: changeSet.id,
    migrationId: migration.id,
    plannedSemanticDiffId: plannedSemanticDiff.id,
    schemaLockDigest: targetDigest,
  };
}
