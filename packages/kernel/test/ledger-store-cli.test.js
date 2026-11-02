import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const cli = join(testDirectory, "..", "src", "cli.js");
const digest = (value) => `sha256:${value.repeat(64)}`;
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;

function changeSet() {
  return {
    format: "morivyx.changeset/0.1",
    id: stableId(30),
    baseRevision: "graph:stage-1-package-v1",
    resultingRevision: "graph:stage-1-package-v2",
    resultingRootDigest: digest("1"),
    schemaLockDigest: digest("2"),
    operations: [
      {
        op: "create",
        targetId: stableId(31),
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
    id: stableId(32),
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

function run(arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    encoding: "utf8",
  });
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-store-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package");
  await cp(fixture, packagePath, { recursive: true });
  return { directory, packagePath };
}

test("stores a ChangeSet and its Migration from strict YAML files", async (t) => {
  const { directory, packagePath } = await workspace(t);
  const changeSetRecord = changeSet();
  const migrationRecord = migration(changeSetRecord);
  const changeSetPath = join(directory, "changeset.yaml");
  const migrationPath = join(directory, "migration.yaml");
  await Promise.all([
    writeFile(changeSetPath, serializeYamlRecord(changeSetRecord), "utf8"),
    writeFile(migrationPath, serializeYamlRecord(migrationRecord), "utf8"),
  ]);

  const storedChangeSet = run(["store", packagePath, changeSetPath]);
  assert.equal(
    storedChangeSet.status,
    0,
    storedChangeSet.stdout || storedChangeSet.stderr,
  );
  const changeSetOutput = JSON.parse(storedChangeSet.stdout);
  assert.equal(changeSetOutput.valid, true);
  assert.equal(changeSetOutput.format, changeSetRecord.format);
  assert.equal(changeSetOutput.id, changeSetRecord.id);
  assert.match(changeSetOutput.digest, /^sha256:[0-9a-f]{64}$/);

  const storedMigration = run([
    "store",
    join(packagePath, ".morivyx"),
    migrationPath,
  ]);
  assert.equal(
    storedMigration.status,
    0,
    storedMigration.stdout || storedMigration.stderr,
  );
  const migrationOutput = JSON.parse(storedMigration.stdout);
  assert.equal(migrationOutput.valid, true);
  assert.equal(migrationOutput.format, migrationRecord.format);
  assert.equal(migrationOutput.id, migrationRecord.id);
});

test("stores an Approval from a strict YAML file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packagePath = join(directory, "package");
  await cp(fixture, packagePath, { recursive: true });
  const approvalPath = join(directory, "approval.yaml");
  const record = {
    format: "morivyx.approval/0.1",
    id: stableId(40),
    actor: stableId(1),
    targetId: stableId(2),
    targetRevision: digest("1"),
    operation: "approve",
    scope: "single-revision",
    approvedAt: "2026-08-31T01:00:00Z",
    recordedAt: "2026-08-31T01:01:00Z",
  };
  await writeFile(approvalPath, serializeYamlRecord(record), "utf8");

  const result = run(["store", packagePath, approvalPath]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.format, record.format);
  assert.equal(output.id, record.id);
  assert.equal(output.valid, true);
});

test("prints coded failures for existing IDs and unsupported formats", async (t) => {
  const { directory, packagePath } = await workspace(t);
  const changeSetPath = join(directory, "changeset.yaml");
  await writeFile(
    changeSetPath,
    serializeYamlRecord(changeSet()),
    "utf8",
  );
  assert.equal(run(["store", packagePath, changeSetPath]).status, 0);

  const duplicate = run(["store", packagePath, changeSetPath]);
  assert.equal(duplicate.status, 1);
  assert.equal(
    JSON.parse(duplicate.stdout).issues[0].code,
    "CHANGESET_ALREADY_EXISTS",
  );

  const unknownPath = join(directory, "unknown.yaml");
  await writeFile(unknownPath, 'format: "morivyx.unknown/0.1"\n', "utf8");
  const unknown = run(["store", packagePath, unknownPath]);
  assert.equal(unknown.status, 1);
  const issue = JSON.parse(unknown.stdout).issues[0];
  assert.equal(issue.code, "PACKAGE_FORMAT_UNSUPPORTED");
  assert.equal(issue.path, `${unknownPath}#/format`);
});

test("rejects invalid store arguments with usage", async (t) => {
  const { packagePath } = await workspace(t);
  for (const arguments_ of [
    ["store", packagePath],
    ["store", packagePath, "record.yaml", "extra"],
    ["store", "--package", "record.yaml"],
  ]) {
    const result = run(arguments_);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /morivyx store <package> <record\.yaml>/);
    assert.equal(result.stdout, "");
  }
});
