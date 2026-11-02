import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateApproval, validateApprovalLedger } from "./approval.js";
import {
  compareUnicode,
  graphRootDigest,
  revisionId,
  schemaLockDigest,
} from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { validateGraphRevision } from "./graph-revision.js";
import { validateMigration, validateMigrationChangeSet } from "./migration.js";
import { validateSchemaLock } from "./schema-lock.js";
import { readYamlRecord } from "./yaml-reader.js";

async function assertSafePackageTree(directory) {
  let information;
  try {
    information = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new PackageError(
      "PACKAGE_PATH_INVALID",
      directory,
      "Graph package の .morivyx は通常のディレクトリでなければなりません。",
    );
  }

  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareUnicode(left.name, right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new PackageError(
          "PACKAGE_PATH_INVALID",
          path,
          "Graph package には symbolic link や特殊ファイルを置けません。",
        );
      }
      if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
}

async function yamlFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => join(directory, entry.name))
    .sort(compareUnicode);
}

function assertRecordFilename(path, id) {
  const expected = `${id.slice("urn:uuid:".length)}.yaml`;
  if (basename(path) !== expected) {
    throw new PackageError(
      "PACKAGE_FILENAME_ID_MISMATCH",
      path,
      "ファイル名と記録内の stable ID が一致しません。",
    );
  }
}

async function readElements(directory, kind) {
  const records = [];
  for (const path of await yamlFiles(directory)) {
    const record = await readYamlRecord(path);
    validateGraphElement(record, path);
    assertRecordFilename(path, record.id);
    if (record.kind !== kind) {
      throw new PackageError(
        "GRAPH_ELEMENT_KIND_MISMATCH",
        path,
        `配置先と GraphElement の kind が一致しません: ${String(record.kind)}`,
      );
    }
    records.push({ path, record });
  }
  return records;
}

async function readApprovals(directory) {
  const approvals = [];
  for (const path of await yamlFiles(directory)) {
    const record = await readYamlRecord(path);
    validateApproval(record, path);
    assertRecordFilename(path, record.id);
    approvals.push({ path, record });
  }
  return approvals;
}

async function readChangeSets(directory) {
  const changeSets = [];
  for (const path of await yamlFiles(directory)) {
    const record = await readYamlRecord(path);
    validateChangeSet(record, path);
    assertRecordFilename(path, record.id);
    changeSets.push({ path, record });
  }
  return changeSets;
}

async function readMigrations(directory) {
  const migrations = [];
  for (const path of await yamlFiles(directory)) {
    const record = await readYamlRecord(path);
    validateMigration(record, path);
    assertRecordFilename(path, record.id);
    migrations.push({ path, record });
  }
  return migrations;
}

async function readReports(directory) {
  const { readReport } = await import("./report.js");
  const reports = [];
  for (const path of await yamlFiles(directory)) {
    const result = await readReport(path);
    if (!Object.hasOwn(result.report, "id")) {
      throw new PackageError(
        "REPORT_ID_REQUIRED",
        `${path}#/id`,
        "保存済みReportにはstable IDが必要です。",
      );
    }
    reports.push({ path, result });
  }
  return reports;
}

function packageDirectory(path) {
  const absolute = resolve(path);
  return basename(absolute) === ".morivyx" ? absolute : join(absolute, ".morivyx");
}

export async function readGraphPackage(path) {
  const directory = packageDirectory(path);
  await assertSafePackageTree(directory);
  const schemaLockPath = join(directory, "schema.lock.yaml");
  const revisionPath = join(directory, "revision.yaml");
  const schemaLock = await readYamlRecord(schemaLockPath);
  const revision = await readYamlRecord(revisionPath);
  validateSchemaLock(schemaLock, schemaLockPath);
  validateGraphRevision(revision, revisionPath);

  const entities = await readElements(
    join(directory, "graph", "entities"),
    "entity",
  );
  const relations = await readElements(
    join(directory, "graph", "relations"),
    "relation",
  );
  const approvals = await readApprovals(join(directory, "approvals"));
  const changeSets = await readChangeSets(join(directory, "ledger"));
  const migrations = await readMigrations(join(directory, "migrations"));
  const reports = await readReports(join(directory, "reports"));
  const elementEntries = [...entities, ...relations];
  const reportEntries = reports.map(({ path, result }) => ({
    path,
    record: result.report,
  }));
  const recordEntries = [
    ...elementEntries,
    ...approvals,
    ...changeSets,
    ...migrations,
    ...reportEntries,
  ];
  const seen = new Map();

  for (const entry of recordEntries) {
    const existing = seen.get(entry.record.id);
    if (existing) {
      throw new PackageError(
        "ID_DUPLICATE",
        entry.path,
        `同じ stable ID が複数のファイルにあります: ${existing}`,
      );
    }
    seen.set(entry.record.id, entry.path);
  }

  validateApprovalLedger(
    approvals.map(({ record }) => record),
    approvals.map(({ path: approvalPath }) => approvalPath),
  );

  const changeSetsById = new Map(
    changeSets.map(({ record }) => [record.id, record]),
  );
  for (const { path: migrationPath, record } of migrations) {
    validateMigrationChangeSet(
      record,
      changeSetsById.get(record.changeSetId),
      migrationPath,
    );
  }

  const elements = elementEntries
    .map(({ path: elementPath, record }) => {
      const calculatedRevision = revisionId(record);
      if (record.revision !== calculatedRevision) {
        throw new PackageError(
          "REVISION_ID_MISMATCH",
          elementPath,
          "記録した Revision ID が canonical form の再計算値と一致しません。",
        );
      }
      return record;
    })
    .sort((left, right) => compareUnicode(left.id, right.id));

  const calculatedSchemaLockDigest = schemaLockDigest(schemaLock);
  if (revision.schemaLockDigest !== calculatedSchemaLockDigest) {
    throw new PackageError(
      "SCHEMA_LOCK_DIGEST_MISMATCH",
      revisionPath,
      "記録した Schema 固定情報の digest が再計算値と一致しません。",
    );
  }

  const calculatedRootDigest = graphRootDigest(elements);
  if (revision.rootDigest !== calculatedRootDigest) {
    throw new PackageError(
      "ROOT_DIGEST_MISMATCH",
      revisionPath,
      "記録した Graph の根の digest が再計算値と一致しません。",
    );
  }

  return {
    directory,
    schemaLock,
    revision,
    elements,
    approvals: approvals.map(({ record }) => record),
    changeSets: changeSets.map(({ record }) => record),
    migrations: migrations.map(({ record }) => record),
    reports: reports.map(({ result }) => result),
    calculatedSchemaLockDigest,
    calculatedRootDigest,
  };
}

export async function inspectPackage(path) {
  const packageContents = await readGraphPackage(path);
  const {
    revision,
    elements,
    approvals,
    changeSets,
    migrations,
    reports,
    calculatedSchemaLockDigest,
    calculatedRootDigest,
  } = packageContents;

  return {
    valid: true,
    graphRevision: revision.id,
    parentRevision: revision.parentRevision,
    elementCount: elements.length,
    approvalCount: approvals.length,
    changeSetCount: changeSets.length,
    migrationCount: migrations.length,
    reportCount: reports.length,
    schemaLockDigest: {
      recorded: revision.schemaLockDigest,
      calculated: calculatedSchemaLockDigest,
    },
    rootDigest: {
      recorded: revision.rootDigest,
      calculated: calculatedRootDigest,
    },
    elements: elements.map(({ id, kind, revision: elementRevision }) => ({
      id,
      kind,
      revision: elementRevision,
    })),
  };
}

export { PackageError } from "./errors.js";
export { readYamlRecord } from "./yaml-reader.js";
