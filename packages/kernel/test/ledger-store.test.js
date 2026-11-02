import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changeSetDigest, migrationDigest } from "../src/canonical.js";
import { PackageError } from "../src/errors.js";
import { writeChangeSet, writeMigration } from "../src/ledger-store.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeReport } from "../src/report.js";
import { readYamlRecord } from "../src/yaml-reader.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const digest = (value) => `sha256:${value.repeat(64)}`;
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;

function changeSet() {
  return {
    format: "morivyx.changeset/0.1",
    id: stableId(20),
    baseRevision: "graph:stage-1-package-v1",
    resultingRevision: "graph:stage-1-package-v2",
    resultingRootDigest: digest("1"),
    schemaLockDigest: digest("2"),
    operations: [
      {
        op: "create",
        targetId: stableId(21),
        afterRevision: digest("3"),
      },
    ],
    provenance: {
      method: "generated",
      actor: stableId(1),
      recordedAt: "2026-08-03T00:00:00Z",
    },
    recordedAt: "2026-08-03T00:00:00Z",
  };
}

function migration(changeSetRecord) {
  return {
    format: "morivyx.migration/0.1",
    id: stableId(22),
    baseRevision: changeSetRecord.baseRevision,
    sourceSchemaLockDigest: digest("4"),
    targetSchemaLockDigest: changeSetRecord.schemaLockDigest,
    rulesDigest: digest("5"),
    mappingDigest: digest("6"),
    plannedSemanticDiffDigest: digest("7"),
    changeSetId: changeSetRecord.id,
    resultingRevision: changeSetRecord.resultingRevision,
    resultingRootDigest: changeSetRecord.resultingRootDigest,
    provenance: {
      method: "migration",
      actor: stableId(1),
      recordedAt: "2026-08-03T00:00:00Z",
    },
    recordedAt: "2026-08-03T00:00:00Z",
  };
}

function semanticDiffReport() {
  return {
    format: "morivyx.semantic-diff/0.1",
    id: stableId(23),
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-package-v2",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    evaluatedAt: "2026-08-03T00:00:00Z",
    entries: [],
  };
}

async function packageCopy(t) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-ledger-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package");
  await cp(fixture, packagePath, { recursive: true });
  return packagePath;
}

function expectCode(action, code, path) {
  return assert.rejects(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    if (path !== undefined) {
      assert.equal(error.path, path);
    }
    return true;
  });
}

test("writes and reads an append-only ChangeSet", async (t) => {
  const packagePath = await packageCopy(t);
  const record = changeSet();
  const result = await writeChangeSet(packagePath, record);

  assert.equal(result.valid, true);
  assert.equal(result.digest, changeSetDigest(record));
  assert.equal(
    result.path,
    join(
      packagePath,
      ".morivyx",
      "ledger",
      "550e8400-e29b-41d4-a716-000000000020.yaml",
    ),
  );
  assert.deepEqual(await readYamlRecord(result.path), record);

  const contents = await readGraphPackage(packagePath);
  assert.deepEqual(contents.changeSets, [record]);
  assert.equal(contents.calculatedRootDigest, contents.revision.rootDigest);
});

test("writes a Migration only after its generated ChangeSet", async (t) => {
  const packagePath = await packageCopy(t);
  const changeSetRecord = changeSet();
  const migrationRecord = migration(changeSetRecord);
  await writeChangeSet(packagePath, changeSetRecord);
  const result = await writeMigration(
    join(packagePath, ".morivyx"),
    migrationRecord,
  );

  assert.equal(result.digest, migrationDigest(migrationRecord));
  assert.deepEqual(await readYamlRecord(result.path), migrationRecord);
  const contents = await readGraphPackage(packagePath);
  assert.deepEqual(contents.changeSets, [changeSetRecord]);
  assert.deepEqual(contents.migrations, [migrationRecord]);
});

test("publishes only one concurrent write for a stable ID", async (t) => {
  const packagePath = await packageCopy(t);
  const results = await Promise.allSettled([
    writeChangeSet(packagePath, changeSet()),
    writeChangeSet(packagePath, changeSet()),
  ]);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "CHANGESET_ALREADY_EXISTS");

  const files = await readdir(join(packagePath, ".morivyx", "ledger"));
  assert.deepEqual(files, ["550e8400-e29b-41d4-a716-000000000020.yaml"]);
});

test("publishes only one concurrent write across Package record types", async (t) => {
  const packagePath = await packageCopy(t);
  const changeSetRecord = changeSet();
  const report = { ...semanticDiffReport(), id: changeSetRecord.id };
  const results = await Promise.allSettled([
    writeChangeSet(packagePath, changeSetRecord),
    writeReport(packagePath, report),
  ]);

  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "ID_DUPLICATE");
  const contents = await readGraphPackage(packagePath);
  assert.equal(contents.changeSets.length + contents.reports.length, 1);
  assert.deepEqual(
    (await readdir(join(packagePath, ".morivyx"))).filter((name) =>
      name.endsWith(".lock"),
    ),
    [],
  );
});

test("rejects a symbolic link Package record directory", async (t) => {
  const packagePath = await packageCopy(t);
  const outside = join(dirname(packagePath), "outside-ledger");
  const ledgerDirectory = join(packagePath, ".morivyx", "ledger");
  await mkdir(outside);
  await symlink(outside, ledgerDirectory, "dir");

  await expectCode(
    writeChangeSet(packagePath, changeSet()),
    "PACKAGE_PATH_INVALID",
    ledgerDirectory,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("rejects a symbolic link metadata root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-ledger-linked-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "package");
  const metadataPath = join(packagePath, ".morivyx");
  await mkdir(packagePath);
  await symlink(join(fixture, ".morivyx"), metadataPath, "dir");

  await expectCode(
    writeChangeSet(packagePath, changeSet()),
    "PACKAGE_RECORD_PACKAGE_MISSING",
    metadataPath,
  );
});

test("does not overwrite stored ChangeSets or Migrations", async (t) => {
  const packagePath = await packageCopy(t);
  const changeSetRecord = changeSet();
  const migrationRecord = migration(changeSetRecord);
  await writeChangeSet(packagePath, changeSetRecord);
  await expectCode(
    writeChangeSet(packagePath, changeSetRecord),
    "CHANGESET_ALREADY_EXISTS",
  );
  await writeMigration(packagePath, migrationRecord);
  await expectCode(
    writeMigration(packagePath, migrationRecord),
    "MIGRATION_ALREADY_EXISTS",
  );
});

test("rejects stable IDs already used by another Package record type", async (t) => {
  const packagePath = await packageCopy(t);
  const elementId =
    "urn:uuid:550e8400-e29b-41d4-a716-446655440000";
  await expectCode(
    writeChangeSet(packagePath, { ...changeSet(), id: elementId }),
    "ID_DUPLICATE",
  );

  const report = semanticDiffReport();
  const savedReport = await writeReport(packagePath, report);
  await rename(
    savedReport.path,
    join(dirname(savedReport.path), "arbitrary-name.yaml"),
  );
  await expectCode(
    writeChangeSet(packagePath, { ...changeSet(), id: report.id }),
    "ID_DUPLICATE",
  );

  const changeSetRecord = changeSet();
  await writeChangeSet(packagePath, changeSetRecord);
  await expectCode(
    writeMigration(packagePath, {
      ...migration(changeSetRecord),
      id: report.id,
    }),
    "ID_DUPLICATE",
  );

  const contents = await readGraphPackage(packagePath);
  assert.deepEqual(contents.changeSets, [changeSetRecord]);
  assert.deepEqual(contents.migrations, []);
  assert.equal(contents.reports[0].report.id, report.id);
});

test("rejects missing packages, invalid records, and missing generated ChangeSets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-ledger-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await expectCode(
    writeChangeSet(directory, changeSet()),
    "PACKAGE_RECORD_PACKAGE_MISSING",
    join(directory, ".morivyx"),
  );

  const packagePath = await packageCopy(t);
  await expectCode(
    writeChangeSet(packagePath, { ...changeSet(), operations: [] }),
    "CHANGESET_INVALID",
    "/operations",
  );
  await assert.rejects(
    readdir(join(packagePath, ".morivyx", "ledger")),
    (error) => error.code === "ENOENT",
  );

  const migrationRecord = migration(changeSet());
  await expectCode(
    writeMigration(packagePath, migrationRecord),
    "MIGRATION_CHANGESET_MISSING",
    "/changeSetId",
  );
  await assert.rejects(
    readdir(join(packagePath, ".morivyx", "migrations")),
    (error) => error.code === "ENOENT",
  );

  await writeChangeSet(packagePath, changeSet());
  await expectCode(
    writeMigration(packagePath, {
      ...migrationRecord,
      resultingRootDigest: digest("8"),
    }),
    "MIGRATION_CHANGESET_MISMATCH",
    "/resultingRootDigest",
  );
  await assert.rejects(
    readdir(join(packagePath, ".morivyx", "migrations")),
    (error) => error.code === "ENOENT",
  );
});
