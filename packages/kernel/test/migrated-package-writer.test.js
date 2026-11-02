import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  graphRootDigest,
  revisionId,
  schemaDefinitionDigest,
  schemaLockDigest,
} from "../src/canonical.js";
import { writeChangeSet, writeMigration } from "../src/ledger-store.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeMigratedPackage } from "../src/package-writer.js";
import { writeReport } from "../src/report.js";
import { migrationSemanticDiffDigest } from "../src/semantic-diff.js";
import { validatePackage } from "../src/validator.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const cli = join(testDirectory, "..", "src", "cli.js");
const digest = (value) => `sha256:${value.repeat(64)}`;

function run(arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    encoding: "utf8",
  });
}

function targetSchema() {
  return {
    format: "morivyx.schema/0.1",
    schemaId: "morivyx.core",
    version: "0.2",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    reviewStates: ["approved", "proposed", "rejected", "unreviewed"],
    entityTypes: [
      {
        typeId: "core.observation",
        requiredAttributes: ["observedAt", "recordedAt"],
        optionalAttributes: ["stringValues"],
        lifecycle: ["active", "draft"],
      },
    ],
    relationTypes: [],
    authoringOrders: {
      root: [
        "format",
        "kind",
        "id",
        "type",
        "typeVersion",
        "revision",
        "lifecycle",
        "reviewState",
        "attributes",
        "provenance",
        "extensions",
      ],
      attributes: [],
      provenance: ["method", "actor", "recordedAt"],
    },
  };
}

function candidates(base) {
  const revised = structuredClone(base.elements[0]);
  revised.typeVersion = "0.2";
  revised.attributes.stringValues[2] = "revised";
  revised.revision = revisionId(revised);
  const second = structuredClone(base.elements[1]);
  second.typeVersion = "0.2";
  second.revision = revisionId(second);
  const created = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
    type: "core.observation",
    typeVersion: "0.2",
    revision: "",
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
  created.revision = revisionId(created);
  return [revised, second, created];
}

async function vector() {
  const base = await readGraphPackage(fixture);
  const targetSchemaDefinitions = [targetSchema()];
  const targetSchemaLock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: targetSchemaDefinitions.map((definition) => ({
      schemaId: definition.schemaId,
      version: definition.version,
      digest: schemaDefinitionDigest(definition),
    })),
  };
  const targetDigest = schemaLockDigest(targetSchemaLock);
  const candidateElements = candidates(base);
  const resultingRootDigest = graphRootDigest([
    candidateElements[0],
    candidateElements[1],
    candidateElements[2],
  ]);
  const changeSet = {
    format: "morivyx.changeset/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440012",
    baseRevision: base.revision.id,
    resultingRevision: "graph:migrated-package-v1",
    resultingRootDigest,
    schemaLockDigest: targetDigest,
    operations: [
      {
        op: "revise",
        targetId: candidateElements[0].id,
        beforeRevision: base.elements[0].revision,
        afterRevision: candidateElements[0].revision,
      },
      {
        op: "revise",
        targetId: candidateElements[1].id,
        beforeRevision: base.elements[1].revision,
        afterRevision: candidateElements[1].revision,
      },
      {
        op: "create",
        targetId: candidateElements[2].id,
        afterRevision: candidateElements[2].revision,
      },
    ],
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-31T02:20:00Z",
    },
    recordedAt: "2026-08-31T02:20:00Z",
  };
  const plannedSemanticDiff = {
    format: "morivyx.migration-semantic-diff/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440013",
    baseRevision: changeSet.baseRevision,
    targetRevision: changeSet.resultingRevision,
    sourceSchemaLockDigest: base.calculatedSchemaLockDigest,
    targetSchemaLockDigest: targetDigest,
    evaluatedAt: "2026-08-31T02:20:00Z",
    entries: [
      {
        kind: "entity_added",
        targetId: candidateElements[2].id,
        afterRevision: candidateElements[2].revision,
      },
      {
        kind: "entity_revised",
        targetId: candidateElements[0].id,
        beforeRevision: base.elements[0].revision,
        afterRevision: candidateElements[0].revision,
      },
      {
        kind: "entity_revised",
        targetId: candidateElements[1].id,
        beforeRevision: base.elements[1].revision,
        afterRevision: candidateElements[1].revision,
      },
      { kind: "schema_changed", targetId: "morivyx.core" },
    ],
  };
  const migration = {
    format: "morivyx.migration/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440014",
    baseRevision: changeSet.baseRevision,
    sourceSchemaLockDigest: base.calculatedSchemaLockDigest,
    targetSchemaLockDigest: targetDigest,
    rulesDigest: digest("8"),
    mappingDigest: digest("7"),
    plannedSemanticDiffDigest: migrationSemanticDiffDigest(
      plannedSemanticDiff,
    ),
    changeSetId: changeSet.id,
    resultingRevision: changeSet.resultingRevision,
    resultingRootDigest,
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-31T02:20:00Z",
    },
    recordedAt: "2026-08-31T02:20:00Z",
  };
  const resultingRevision = {
    format: "morivyx.graph-revision/0.1",
    id: migration.resultingRevision,
    parentRevision: migration.baseRevision,
    rootDigest: migration.resultingRootDigest,
    schemaLockDigest: migration.targetSchemaLockDigest,
  };
  return {
    base,
    migration,
    changeSet,
    plannedSemanticDiff,
    candidateElements,
    resultingRevision,
    targetSchemaLock,
    targetSchemaDefinitions,
  };
}

async function writeMigrationCliInput(
  directory,
  input,
  {
    migrationSource,
    diffSource,
    revisionSource,
    targetSchemaLockSource,
    targetSchemaDefinitionSources = [],
  } = {},
) {
  const candidatesDirectory = join(directory, "candidates");
  const targetDirectory = join(directory, "target");
  const schemasDirectory = join(targetDirectory, "schemas");
  await mkdir(candidatesDirectory, { recursive: true });
  await mkdir(schemasDirectory, { recursive: true });
  const migrationPath = join(directory, "migration.yaml");
  const changeSetPath = join(directory, "changeset.yaml");
  const diffPath = join(directory, "diff.yaml");
  const revisionPath = join(directory, "revision.yaml");
  const outputPath = join(directory, "result");
  await Promise.all([
    writeFile(
      migrationPath,
      migrationSource ?? serializeYamlRecord(input.migration),
      "utf8",
    ),
    writeFile(changeSetPath, serializeYamlRecord(input.changeSet), "utf8"),
    writeFile(
      diffPath,
      diffSource ?? serializeYamlRecord(input.plannedSemanticDiff),
      "utf8",
    ),
    writeFile(
      revisionPath,
      revisionSource ?? serializeYamlRecord(input.resultingRevision),
      "utf8",
    ),
    writeFile(
      join(targetDirectory, "schema.lock.yaml"),
      targetSchemaLockSource ?? serializeYamlRecord(input.targetSchemaLock),
      "utf8",
    ),
    ...input.targetSchemaDefinitions.map((definition, index) =>
      writeFile(
        join(
          schemasDirectory,
          `${definition.schemaId}@${definition.version}.yaml`,
        ),
        targetSchemaDefinitionSources[index] ??
          serializeYamlRecord(definition),
        "utf8",
      ),
    ),
    ...input.candidateElements.map((candidate, index) =>
      writeFile(
        join(candidatesDirectory, `${String(index).padStart(2, "0")}.yaml`),
        serializeYamlRecord(candidate),
        "utf8",
      ),
    ),
  ]);
  return {
    outputPath,
    arguments_: [
      "migrate",
      fixture,
      migrationPath,
      changeSetPath,
      diffPath,
      revisionPath,
      outputPath,
      "--target-schema",
      targetDirectory,
      "--candidates",
      candidatesDirectory,
    ],
  };
}

test("writes a validated Migration result to a new Graph Package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migrated-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = join(directory, "base");
  await cp(fixture, basePath, { recursive: true });
  const baseIndexPath = join(basePath, ".morivyx", "index.json");
  await writeFile(baseIndexPath, '{"graphRevision":"graph:stale"}\n', "utf8");
  const input = await vector();

  const result = await writeMigratedPackage({
    basePath,
    outputPath,
    ...input,
  });
  const output = await readGraphPackage(outputPath);
  const validation = await validatePackage(outputPath);

  assert.equal(result.valid, true);
  assert.equal(result.schemaLockDigest, input.migration.targetSchemaLockDigest);
  assert.equal(output.revision.schemaLockDigest, result.schemaLockDigest);
  assert.equal(output.changeSets.at(-1).id, input.changeSet.id);
  assert.equal(output.migrations.at(-1).id, input.migration.id);
  assert.equal(output.reports.at(-1).report.id, input.plannedSemanticDiff.id);
  assert.equal(validation.valid, true);
  assert.equal(validation.graphRevision, input.migration.resultingRevision);
  assert.equal(
    (await readGraphPackage(basePath)).revision.id,
    input.base.revision.id,
  );
  await access(baseIndexPath);
  await assert.rejects(
    access(join(outputPath, ".morivyx", "index.json")),
    (error) => error.code === "ENOENT",
  );
});

test("publishes exactly one valid Package under concurrent Migration output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migration-concurrent-output-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = join(directory, "base");
  await cp(fixture, basePath, { recursive: true });
  const input = await vector();
  const before = await readGraphPackage(basePath);

  const results = await Promise.allSettled(
    [0, 1].map(() =>
      writeMigratedPackage({
        basePath,
        outputPath,
        ...structuredClone(input),
      }),
    ),
  );
  const fulfilled = results.filter(({ status }) => status === "fulfilled");
  const rejected = results.filter(({ status }) => status === "rejected");
  const output = await readGraphPackage(outputPath);
  const validation = await validatePackage(outputPath);

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "PACKAGE_OUTPUT_EXISTS");
  assert.equal(output.revision.id, input.migration.resultingRevision);
  assert.equal(
    output.migrations.filter(({ id }) => id === input.migration.id).length,
    1,
  );
  assert.equal(validation.valid, true);
  assert.deepEqual(await readGraphPackage(basePath), before);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("rejects different existing ledger records with the same stable ID", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migration-id-conflict-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    {
      name: "ChangeSet",
      async seed(basePath, input) {
        const existing = structuredClone(input.changeSet);
        existing.provenance.recordedAt = "2026-08-31T02:20:01Z";
        existing.recordedAt = "2026-08-31T02:20:01Z";
        await writeChangeSet(basePath, existing);
      },
      code: "CHANGESET_ALREADY_EXISTS",
      path: "/changeSet/id",
    },
    {
      name: "Migration",
      async seed(basePath, input) {
        await writeChangeSet(basePath, input.changeSet);
        const existing = structuredClone(input.migration);
        existing.provenance.recordedAt = "2026-08-31T02:20:01Z";
        existing.recordedAt = "2026-08-31T02:20:01Z";
        await writeMigration(basePath, existing);
      },
      code: "MIGRATION_ALREADY_EXISTS",
      path: "/migration/id",
    },
    {
      name: "planned semantic diff",
      async seed(basePath, input) {
        await writeChangeSet(basePath, input.changeSet);
        await writeMigration(basePath, input.migration);
        const existing = structuredClone(input.plannedSemanticDiff);
        existing.evaluatedAt = "2026-08-31T02:20:01Z";
        await writeReport(basePath, existing);
      },
      code: "REPORT_ALREADY_EXISTS",
      path: "/plannedSemanticDiff/id",
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const basePath = join(directory, `base-${index}`);
      const outputPath = join(directory, `result-${index}`);
      await cp(fixture, basePath, { recursive: true });
      const input = await vector();
      await current.seed(basePath, input);
      const before = await readGraphPackage(basePath);

      await assert.rejects(
        writeMigratedPackage({ basePath, outputPath, ...input }),
        (error) =>
          error.code === current.code && error.path === current.path,
      );
      assert.deepEqual(await readGraphPackage(basePath), before);
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
    });
  }
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("rejects an incomplete target Schema set without output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migration-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const input = await vector();
  input.targetSchemaDefinitions.pop();

  await assert.rejects(
    writeMigratedPackage({ basePath: fixture, outputPath, ...input }),
    (error) => error.code === "MIGRATION_TARGET_SCHEMA_MISMATCH",
  );
  await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");
  assert.deepEqual(await readdir(directory), []);
});

test("rejects malformed or mismatched target Schema definitions without output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migration-schema-mismatch-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    {
      name: "non-array definitions",
      mutate(input) {
        input.targetSchemaDefinitions = null;
      },
      path: "/targetSchemaDefinitions",
    },
    {
      name: "duplicate definitions",
      mutate(input) {
        input.targetSchemaDefinitions.push(
          structuredClone(input.targetSchemaDefinitions[0]),
        );
      },
      path: "/targetSchemaDefinitions/1/schemaId",
    },
    {
      name: "definition digest mismatch",
      mutate(input) {
        input.targetSchemaLock.schemas[0].digest = digest("9");
      },
      path: "/targetSchemaLock/schemas/0/digest",
    },
    {
      name: "Migration target digest mismatch",
      mutate(input) {
        input.migration.targetSchemaLockDigest = digest("6");
        input.changeSet.schemaLockDigest = digest("6");
      },
      path: "/targetSchemaLock",
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const input = await vector();
      const outputPath = join(directory, `result-${index}`);
      current.mutate(input);

      await assert.rejects(
        writeMigratedPackage({ basePath: fixture, outputPath, ...input }),
        (error) =>
          error.code === "MIGRATION_TARGET_SCHEMA_MISMATCH" &&
          error.path === current.path,
      );
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
    });
  }
  assert.deepEqual(await readdir(directory), []);
});

test("rejects planned Schema changes that differ from the Schema locks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migration-diff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mutations = [
    (entries) =>
      entries.map((entry) =>
        entry.kind === "schema_changed"
          ? { ...entry, targetId: "example.unrelated" }
          : entry,
      ),
    (entries) => entries.filter(({ kind }) => kind !== "schema_changed"),
    (entries) => [
      ...entries,
      { kind: "schema_changed", targetId: "zz.unrelated" },
    ],
  ];

  for (const [index, mutate] of mutations.entries()) {
    const input = await vector();
    input.plannedSemanticDiff.entries = mutate(
      input.plannedSemanticDiff.entries,
    );
    input.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
      input.plannedSemanticDiff,
    );
    const outputPath = join(directory, `result-${index}`);

    await assert.rejects(
      writeMigratedPackage({ basePath: fixture, outputPath, ...input }),
      (error) =>
        error.code === "MIGRATION_SEMANTIC_DIFF_MISMATCH" &&
        error.path === "/plannedSemanticDiff/entries",
    );
    await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");
  }
  assert.deepEqual(await readdir(directory), []);
});

test("rejects planned Graph changes that differ from the applied Graph", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migration-graph-diff-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unrelatedId = "urn:uuid:550e8400-e29b-41d4-a716-446655449999";
  const mutations = [
    (entries) =>
      entries.map((entry) =>
        entry.kind === "entity_added"
          ? { ...entry, targetId: unrelatedId }
          : entry,
      ),
    (entries) => entries.filter(({ kind }) => kind !== "entity_added"),
    (entries) => [
      entries[0],
      {
        kind: "entity_added",
        targetId: unrelatedId,
        afterRevision: entries[0].afterRevision,
      },
      ...entries.slice(1),
    ],
  ];

  for (const [index, mutate] of mutations.entries()) {
    const input = await vector();
    input.plannedSemanticDiff.entries = mutate(
      input.plannedSemanticDiff.entries,
    );
    input.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
      input.plannedSemanticDiff,
    );
    const outputPath = join(directory, `result-${index}`);

    await assert.rejects(
      writeMigratedPackage({ basePath: fixture, outputPath, ...input }),
      (error) =>
        error.code === "MIGRATION_SEMANTIC_DIFF_MISMATCH" &&
        error.path === "/plannedSemanticDiff/entries",
    );
    await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");
  }
  assert.deepEqual(await readdir(directory), []);
});

test("rejects Migration output resolving into the base Package", async (t) => {
  for (const invalidInput of [undefined, null]) {
    await assert.rejects(
      writeMigratedPackage(invalidInput),
      (error) =>
        error.name === "PackageError" &&
        error.code === "PACKAGE_OUTPUT_INVALID" &&
        error.path === "/outputPath",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migration-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = join(directory, "base");
  await cp(fixture, basePath, { recursive: true });
  const linkedBase = join(directory, "linked-base");
  await symlink(basePath, linkedBase, "dir");
  const missingParent = join(linkedBase, "missing-parent");
  const outputPath = join(missingParent, "result");
  const input = await vector();

  await assert.rejects(
    writeMigratedPackage({ basePath, outputPath, ...input }),
    (error) =>
      error.code === "PACKAGE_OUTPUT_INVALID" && error.path === "/outputPath",
  );
  await assert.rejects(
    access(missingParent),
    (error) => error.code === "ENOENT",
  );
});

test("rejects linked base schemas without writing through the link", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migration-base-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = join(directory, "base");
  await cp(fixture, basePath, { recursive: true });
  const schemas = join(basePath, ".morivyx", "schemas");
  const externalSchemas = join(directory, "external-schemas");
  await mkdir(externalSchemas);
  await symlink(externalSchemas, schemas, "dir");
  const outputPath = join(directory, "result");
  const escapedSchema = join(externalSchemas, "morivyx.core@0.2.yaml");
  const input = await vector();

  await assert.rejects(
    writeMigratedPackage({ basePath, outputPath, ...input }),
    (error) =>
      error.code === "PACKAGE_PATH_INVALID" && error.path === schemas,
  );
  await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");
  await assert.rejects(access(escapedSchema), (error) => error.code === "ENOENT");
});

test("rejects a target Validator failure without output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migration-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const input = await vector();
  input.candidateElements[0].typeVersion = "9.0";
  input.candidateElements[0].revision = revisionId(input.candidateElements[0]);
  input.changeSet.operations[0].afterRevision =
    input.candidateElements[0].revision;
  input.plannedSemanticDiff.entries.find(
    ({ targetId }) => targetId === input.candidateElements[0].id,
  ).afterRevision = input.candidateElements[0].revision;
  input.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(
    input.plannedSemanticDiff,
  );
  input.changeSet.resultingRootDigest = graphRootDigest([
    input.candidateElements[0],
    input.candidateElements[1],
    input.candidateElements[2],
  ]);
  input.migration.resultingRootDigest = input.changeSet.resultingRootDigest;
  input.resultingRevision.rootDigest = input.changeSet.resultingRootDigest;

  await assert.rejects(
    writeMigratedPackage({ basePath: fixture, outputPath, ...input }),
    (error) => error.code === "MIGRATION_TARGET_VALIDATION_FAILED",
  );
  await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");
  assert.deepEqual(await readdir(directory), []);
});

test("applies a Migration from strict YAML through the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-migrate-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await vector();
  const { arguments_, outputPath } = await writeMigrationCliInput(
    directory,
    input,
  );

  const result = run(arguments_);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.migrationId, input.migration.id);
  assert.equal((await validatePackage(outputPath)).valid, true);
});

test("reports missing migrate CLI inputs in declaration order", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migrate-cli-input-order-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBefore = await readGraphPackage(fixture);
  const names = [
    "Migration",
    "ChangeSet",
    "planned semantic diff",
    "resulting GraphRevision",
    "candidate elements",
  ];

  for (const [index, name] of names.entries()) {
    await t.test(name, async () => {
      const caseDirectory = join(directory, String(index));
      const { arguments_, outputPath } = await writeMigrationCliInput(
        caseDirectory,
        await vector(),
      );
      const inputPaths = [
        ...arguments_.slice(2, 6),
        arguments_[arguments_.indexOf("--candidates") + 1],
        arguments_[arguments_.indexOf("--target-schema") + 1],
      ];
      for (const inputPath of inputPaths.slice(index)) {
        await rm(inputPath, { recursive: true, force: true });
      }

      const result = run(arguments_);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.valid, false);
      assert.equal(response.issues.length, 1);
      assert.equal(response.issues[0].code, "PACKAGE_FILE_MISSING");
      assert.equal(response.issues[0].path, inputPaths[index]);
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
      assert.deepEqual(await readGraphPackage(fixture), baseBefore);
    });
  }
});

test("rejects incompatible Migration and target Schema CLI inputs without output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migrate-cli-incompatible-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBefore = await readGraphPackage(fixture);
  const cases = [
    {
      name: "future Migration format",
      code: "MIGRATION_INVALID",
      path: "/format",
      migrationSource(input) {
        return serializeYamlRecord(input.migration).replace(
          "morivyx.migration/0.1",
          "morivyx.migration/0.2",
        );
      },
    },
    {
      name: "ordinary semantic diff format",
      code: "MIGRATION_SEMANTIC_DIFF_MISMATCH",
      path: "/plannedSemanticDiff/format",
      diffSource(input) {
        return serializeYamlRecord(input.plannedSemanticDiff).replace(
          "morivyx.migration-semantic-diff/0.1",
          "morivyx.semantic-diff/0.1",
        );
      },
    },
    {
      name: "ChangeSet base Revision mismatch",
      code: "MIGRATION_CHANGESET_MISMATCH",
      path: "/baseRevision",
      mutate(input) {
        input.changeSet.baseRevision = "graph:other";
      },
    },
    {
      name: "future resulting GraphRevision format",
      code: "CHANGESET_RESULT_MISMATCH",
      path: "/resultingRevisionRecord/format",
      revisionSource(input) {
        return serializeYamlRecord(input.resultingRevision).replace(
          "morivyx.graph-revision/0.1",
          "morivyx.graph-revision/0.2",
        );
      },
    },
    {
      name: "resulting GraphRevision ID mismatch",
      code: "CHANGESET_RESULT_MISMATCH",
      path: "/resultingRevisionRecord/id",
      mutate(input) {
        input.resultingRevision.id = "graph:other";
      },
    },
    {
      name: "resulting GraphRevision parent mismatch",
      code: "CHANGESET_RESULT_MISMATCH",
      path: "/resultingRevisionRecord/parentRevision",
      mutate(input) {
        input.resultingRevision.parentRevision = "graph:other";
      },
    },
    {
      name: "resulting GraphRevision Schema lock mismatch",
      code: "CHANGESET_RESULT_MISMATCH",
      path: "/resultingRevisionRecord/schemaLockDigest",
      mutate(input) {
        input.resultingRevision.schemaLockDigest = digest("9");
      },
    },
    {
      name: "future target Schema lock format",
      code: "PACKAGE_FORMAT_UNSUPPORTED",
      path: "/targetSchemaLock#/format",
      targetSchemaLockSource(input) {
        return serializeYamlRecord(input.targetSchemaLock).replace(
          "morivyx.schema-lock/0.1",
          "morivyx.schema-lock/0.2",
        );
      },
    },
    {
      name: "unsupported target stable ID scheme",
      code: "STABLE_ID_SCHEME_UNSUPPORTED",
      path: "/targetSchemaLock#/stableIdScheme",
      mutate(input) {
        input.targetSchemaLock.stableIdScheme = "urn-ulid";
      },
    },
    {
      name: "unsupported target digest algorithm",
      code: "DIGEST_ALGORITHM_UNSUPPORTED",
      path: "/targetSchemaLock#/digestAlgorithm",
      mutate(input) {
        input.targetSchemaLock.digestAlgorithm = "sha512";
      },
    },
    {
      name: "future target Schema definition format",
      code: "SCHEMA_DEFINITION_INVALID",
      path: "/targetSchemaDefinitions/0#/format",
      targetSchemaDefinitionSources(input) {
        return [
          serializeYamlRecord(input.targetSchemaDefinitions[0]).replace(
            "morivyx.schema/0.1",
            "morivyx.schema/0.2",
          ),
        ];
      },
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const input = await vector();
      current.mutate?.(input);
      const caseDirectory = join(directory, String(index));
      const { arguments_, outputPath } = await writeMigrationCliInput(
        caseDirectory,
        input,
        {
          migrationSource: current.migrationSource?.(input),
          diffSource: current.diffSource?.(input),
          revisionSource: current.revisionSource?.(input),
          targetSchemaLockSource: current.targetSchemaLockSource?.(input),
          targetSchemaDefinitionSources:
            current.targetSchemaDefinitionSources?.(input),
        },
      );

      const result = run(arguments_);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.valid, false);
      assert.equal(response.issues.length, 1);
      assert.equal(response.issues[0].code, current.code);
      assert.equal(response.issues[0].path, current.path);
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
      assert.deepEqual(await readGraphPackage(fixture), baseBefore);
    });
  }
});

test("rejects invalid target Schema root paths without output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migrate-cli-target-schema-path-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBefore = await readGraphPackage(fixture);
  const cases = [
    {
      name: "missing target Schema directory",
      code: "PACKAGE_FILE_MISSING",
      path: "missing-target",
    },
    {
      name: "target Schema path is a file",
      code: "PACKAGE_TARGET_SCHEMA_DIRECTORY_INVALID",
      path: "target.yaml",
      prepare(path) {
        return writeFile(path, 'format: "morivyx.schema-lock/0.1"\n', "utf8");
      },
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const caseDirectory = join(directory, String(index));
      const { arguments_, outputPath } = await writeMigrationCliInput(
        caseDirectory,
        await vector(),
      );
      const targetSchemaPath = join(caseDirectory, current.path);
      await current.prepare?.(targetSchemaPath);
      arguments_[arguments_.indexOf("--target-schema") + 1] = targetSchemaPath;

      const result = run(arguments_);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.valid, false);
      assert.equal(response.issues.length, 1);
      assert.equal(response.issues[0].code, current.code);
      assert.equal(response.issues[0].path, targetSchemaPath);
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
      assert.deepEqual(await readGraphPackage(fixture), baseBefore);
    });
  }
});

test("rejects incomplete target Schema bundle paths in order without output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-migrate-cli-target-schema-bundle-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseBefore = await readGraphPackage(fixture);
  const cases = [
    {
      name: "missing target Schema lock",
      expectedPath(targetSchemaPath) {
        return join(targetSchemaPath, "schema.lock.yaml");
      },
      async prepare(targetSchemaPath) {
        await rm(targetSchemaPath, { recursive: true, force: true });
        await mkdir(targetSchemaPath);
      },
    },
    {
      name: "missing target Schema definitions directory",
      expectedPath(targetSchemaPath) {
        return join(targetSchemaPath, "schemas");
      },
      prepare(targetSchemaPath) {
        return rm(join(targetSchemaPath, "schemas"), {
          recursive: true,
          force: true,
        });
      },
    },
  ];

  for (const [index, current] of cases.entries()) {
    await t.test(current.name, async () => {
      const caseDirectory = join(directory, String(index));
      const { arguments_, outputPath } = await writeMigrationCliInput(
        caseDirectory,
        await vector(),
      );
      const targetSchemaPath =
        arguments_[arguments_.indexOf("--target-schema") + 1];
      await current.prepare(targetSchemaPath);

      const result = run(arguments_);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.valid, false);
      assert.equal(response.issues.length, 1);
      assert.equal(response.issues[0].code, "PACKAGE_FILE_MISSING");
      assert.equal(
        response.issues[0].path,
        current.expectedPath(targetSchemaPath),
      );
      await assert.rejects(
        access(outputPath),
        (error) => error.code === "ENOENT",
      );
      assert.deepEqual(await readGraphPackage(fixture), baseBefore);
    });
  }
});

test("rejects invalid migrate CLI arguments with usage", () => {
  for (const arguments_ of [
    ["migrate"],
    [
      "migrate",
      "base",
      "migration.yaml",
      "changeset.yaml",
      "diff.yaml",
      "revision.yaml",
      "output",
    ],
    [
      "migrate",
      "base",
      "migration.yaml",
      "changeset.yaml",
      "diff.yaml",
      "revision.yaml",
      "output",
      "--target-schema",
    ],
  ]) {
    const result = run(arguments_);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /morivyx migrate <base>/);
    assert.equal(result.stdout, "");
  }
});
