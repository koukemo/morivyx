import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
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
import { writeChangeSet } from "../src/ledger-store.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const cli = join(testDirectory, "..", "src", "cli.js");
const schema = {
  format: "morivyx.schema/0.1",
  schemaId: "morivyx.core",
  version: "0.1",
  stableIdScheme: "urn-uuid-v4",
  digestAlgorithm: "sha256",
  reviewStates: ["approved", "proposed", "rejected", "unreviewed"],
  entityTypes: [
    {
      typeId: "core.observation",
      requiredAttributes: ["observedAt", "recordedAt", "stringValues"],
      lifecycle: ["draft"],
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

function candidates(base) {
  const revised = structuredClone(base.elements[0]);
  revised.attributes.stringValues[2] = "revised";
  revised.revision = revisionId(revised);
  const created = structuredClone(base.elements[1]);
  created.id = "urn:uuid:550e8400-e29b-41d4-a716-446655440004";
  created.attributes.stringValues = ["third"];
  created.revision = revisionId(created);
  return [revised, created];
}

function changeSet(base, [revised, created]) {
  return {
    format: "morivyx.changeset/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440005",
    baseRevision: base.revision.id,
    resultingRevision: "graph:stage-1-package-v2",
    resultingRootDigest: graphRootDigest([
      revised,
      base.elements[1],
      created,
    ]),
    schemaLockDigest: base.calculatedSchemaLockDigest,
    operations: [
      {
        op: "revise",
        targetId: revised.id,
        beforeRevision: base.elements[0].revision,
        afterRevision: revised.revision,
      },
      {
        op: "create",
        targetId: created.id,
        afterRevision: created.revision,
      },
    ],
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-31T02:00:00Z",
    },
    recordedAt: "2026-08-31T02:00:00Z",
  };
}

function resultingRevision(record) {
  return {
    format: "morivyx.graph-revision/0.1",
    id: record.resultingRevision,
    parentRevision: record.baseRevision,
    rootDigest: record.resultingRootDigest,
    schemaLockDigest: record.schemaLockDigest,
  };
}

async function vector(basePath = fixture) {
  const base = await readGraphPackage(basePath);
  const candidateElements = candidates(base);
  const record = changeSet(base, candidateElements);
  return { base, candidateElements, record };
}

async function doesNotExist(path) {
  await assert.rejects(access(path), (error) => error.code === "ENOENT");
}

async function copyValidatedFixture(directory) {
  const basePath = join(directory, "base");
  const schemaDirectory = join(basePath, ".morivyx", "schemas");
  await cp(fixture, basePath, { recursive: true });
  await mkdir(schemaDirectory);
  const lock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [
      {
        schemaId: schema.schemaId,
        version: schema.version,
        digest: schemaDefinitionDigest(schema),
      },
    ],
  };
  const base = await readGraphPackage(basePath);
  const revision = {
    ...base.revision,
    schemaLockDigest: schemaLockDigest(lock),
  };
  await Promise.all([
    writeFile(
      join(schemaDirectory, "morivyx.core@0.1.yaml"),
      serializeYamlRecord(schema),
      "utf8",
    ),
    writeFile(
      join(basePath, ".morivyx", "schema.lock.yaml"),
      serializeYamlRecord(lock),
      "utf8",
    ),
    writeFile(
      join(basePath, ".morivyx", "revision.yaml"),
      serializeYamlRecord(revision),
      "utf8",
    ),
  ]);
  return basePath;
}

function run(arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    encoding: "utf8",
  });
}

test("writes a verified ChangeSet result to a new Graph Package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = await copyValidatedFixture(directory);
  const baseIndexPath = join(basePath, ".morivyx", "index.json");
  await writeFile(baseIndexPath, '{"graphRevision":"graph:stale"}\n', "utf8");
  const before = await readGraphPackage(basePath);
  const { candidateElements, record } = await vector(basePath);

  const result = await writeAppliedPackage({
    basePath: join(basePath, ".morivyx"),
    outputPath,
    changeSet: record,
    candidateElements,
    resultingRevision: resultingRevision(record),
  });
  const output = await readGraphPackage(outputPath);
  const after = await readGraphPackage(basePath);

  assert.equal(result.valid, true);
  assert.equal(result.graphRevision, record.resultingRevision);
  assert.equal(result.rootDigest, record.resultingRootDigest);
  assert.equal(result.elementCount, 3);
  assert.equal(output.revision.id, record.resultingRevision);
  assert.equal(output.revision.rootDigest, record.resultingRootDigest);
  assert.equal(output.changeSets.at(-1).id, record.id);
  assert.equal(output.approvals.length, before.approvals.length);
  assert.deepEqual(after, before);
  assert.equal(
    await readFile(baseIndexPath, "utf8"),
    '{"graphRevision":"graph:stale"}\n',
  );
  await doesNotExist(join(outputPath, ".morivyx", "index.json"));
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("publishes exactly one valid Package under concurrent ChangeSet output", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-package-concurrent-output-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = await copyValidatedFixture(directory);
  const { candidateElements, record } = await vector(basePath);
  const before = await readGraphPackage(basePath);

  const results = await Promise.allSettled(
    [0, 1].map(() =>
      writeAppliedPackage({
        basePath,
        outputPath,
        changeSet: structuredClone(record),
        candidateElements: structuredClone(candidateElements),
        resultingRevision: resultingRevision(record),
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
  assert.equal(output.revision.id, record.resultingRevision);
  assert.equal(output.changeSets.filter(({ id }) => id === record.id).length, 1);
  assert.equal(validation.valid, true);
  assert.deepEqual(await readGraphPackage(basePath), before);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("rejects a different existing ChangeSet with the same stable ID", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "morivyx-package-id-conflict-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = await copyValidatedFixture(directory);
  const { candidateElements, record } = await vector(basePath);
  const existing = structuredClone(record);
  existing.provenance.recordedAt = "2026-08-31T02:00:01Z";
  existing.recordedAt = "2026-08-31T02:00:01Z";
  await writeChangeSet(basePath, existing);
  const before = await readGraphPackage(basePath);

  await assert.rejects(
    writeAppliedPackage({
      basePath,
      outputPath,
      changeSet: record,
      candidateElements,
      resultingRevision: resultingRevision(record),
    }),
    (error) =>
      error.code === "CHANGESET_ALREADY_EXISTS" &&
      error.path === "/changeSet/id",
  );

  assert.deepEqual(await readGraphPackage(basePath), before);
  await doesNotExist(outputPath);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("refuses an existing output without changing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  await mkdir(outputPath);
  const marker = join(outputPath, "marker.txt");
  await writeFile(marker, "keep", "utf8");
  const { candidateElements, record } = await vector();

  await assert.rejects(
    writeAppliedPackage({
      basePath: fixture,
      outputPath,
      changeSet: record,
      candidateElements,
      resultingRevision: resultingRevision(record),
    }),
    (error) =>
      error.code === "PACKAGE_OUTPUT_EXISTS" && error.path === outputPath,
  );
  assert.equal(await readFile(marker, "utf8"), "keep");
});

test("refuses output resolving into the base Package through a symbolic link", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = await copyValidatedFixture(directory);
  const linkedBase = join(directory, "linked-base");
  await symlink(basePath, linkedBase, "dir");
  const missingParent = join(linkedBase, "missing-parent");
  const outputPath = join(missingParent, "result");
  const { candidateElements, record } = await vector(basePath);

  await assert.rejects(
    writeAppliedPackage({
      basePath,
      outputPath,
      changeSet: record,
      candidateElements,
      resultingRevision: resultingRevision(record),
    }),
    (error) =>
      error.code === "PACKAGE_OUTPUT_INVALID" && error.path === "/outputPath",
  );
  await doesNotExist(missingParent);
});

test("cleans temporary output after validation failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const { candidateElements, record } = await vector();
  candidateElements[0].revision = `sha256:${"0".repeat(64)}`;

  await assert.rejects(
    writeAppliedPackage({
      basePath: fixture,
      outputPath,
      changeSet: record,
      candidateElements,
      resultingRevision: resultingRevision(record),
    }),
    (error) => error.code === "CHANGESET_CANDIDATE_REVISION_MISMATCH",
  );
  await doesNotExist(outputPath);
  assert.deepEqual(await readdir(directory), []);
});

test("refuses a Schema-invalid result without publishing output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const basePath = await copyValidatedFixture(directory);
  const { base, candidateElements, record } = await vector(basePath);
  candidateElements[0].typeVersion = "9.0";
  candidateElements[0].revision = revisionId(candidateElements[0]);
  record.operations[0].afterRevision = candidateElements[0].revision;
  record.resultingRootDigest = graphRootDigest([
    candidateElements[0],
    base.elements[1],
    candidateElements[1],
  ]);

  await assert.rejects(
    writeAppliedPackage({
      basePath,
      outputPath,
      changeSet: record,
      candidateElements,
      resultingRevision: resultingRevision(record),
    }),
    (error) =>
      error.code === "CHANGESET_TARGET_VALIDATION_FAILED" &&
      error.path === "/candidateElements",
  );
  await doesNotExist(outputPath);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("refuses to revoke the ChangeSet that produced the current revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-revoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = await copyValidatedFixture(directory);
  const appliedPath = join(directory, "applied");
  const outputPath = join(directory, "revoked");
  const { candidateElements, record } = await vector(basePath);
  await writeAppliedPackage({
    basePath,
    outputPath: appliedPath,
    changeSet: record,
    candidateElements,
    resultingRevision: resultingRevision(record),
  });
  const applied = await readGraphPackage(appliedPath);
  const revokeRecord = {
    format: "morivyx.changeset/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440006",
    baseRevision: applied.revision.id,
    resultingRevision: "graph:stage-1-package-v3",
    resultingRootDigest: applied.revision.rootDigest,
    schemaLockDigest: applied.revision.schemaLockDigest,
    operations: [{ op: "revoke", targetId: record.id }],
    provenance: {
      method: "asserted",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-08-31T03:00:00Z",
    },
    recordedAt: "2026-08-31T03:00:00Z",
  };

  await assert.rejects(
    writeAppliedPackage({
      basePath: appliedPath,
      outputPath,
      changeSet: revokeRecord,
      resultingRevision: resultingRevision(revokeRecord),
    }),
    (error) =>
      error.code === "CHANGESET_REVOKE_INVALID" &&
      error.path === "/operations/0/targetId",
  );
  await doesNotExist(outputPath);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("requires a new Package root outside the base Package", async (t) => {
  for (const invalidInput of [undefined, null]) {
    await assert.rejects(
      writeAppliedPackage(invalidInput),
      (error) =>
        error.name === "PackageError" &&
        error.code === "PACKAGE_OUTPUT_INVALID" &&
        error.path === "/outputPath",
    );
  }
  const { candidateElements, record } = await vector();
  const input = {
    basePath: fixture,
    changeSet: record,
    candidateElements,
    resultingRevision: resultingRevision(record),
  };
  await assert.rejects(
    writeAppliedPackage({ ...input, outputPath: "" }),
    (error) => error.code === "PACKAGE_OUTPUT_INVALID",
  );
  await assert.rejects(
    writeAppliedPackage({ ...input, outputPath: "/tmp/result/.morivyx" }),
    (error) => error.code === "PACKAGE_OUTPUT_INVALID",
  );
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-nested-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = await copyValidatedFixture(directory);
  const nestedPackageOutput = join(basePath, "nested-output");
  for (const base of [basePath, join(basePath, ".morivyx")]) {
    await assert.rejects(
      writeAppliedPackage({
        ...input,
        basePath: base,
        outputPath: nestedPackageOutput,
      }),
      (error) =>
        error.code === "PACKAGE_OUTPUT_INVALID" &&
        error.path === "/outputPath",
    );
  }
  await doesNotExist(nestedPackageOutput);
  const nestedOutput = join(fixture, ".morivyx", "nested-output");
  await assert.rejects(
    writeAppliedPackage({ ...input, outputPath: nestedOutput }),
    (error) =>
      error.code === "PACKAGE_OUTPUT_INVALID" && error.path === "/outputPath",
  );
  await doesNotExist(nestedOutput);
});

test("applies a ChangeSet from strict YAML files through the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-apply-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result");
  const candidatesPath = join(directory, "candidates");
  const basePath = await copyValidatedFixture(directory);
  await mkdir(candidatesPath);
  const { candidateElements, record } = await vector(basePath);
  const changeSetPath = join(directory, "changeset.yaml");
  const revisionPath = join(directory, "revision.yaml");
  await Promise.all([
    writeFile(changeSetPath, serializeYamlRecord(record), "utf8"),
    writeFile(
      revisionPath,
      serializeYamlRecord(resultingRevision(record)),
      "utf8",
    ),
    ...candidateElements.map((candidate, index) =>
      writeFile(
        join(candidatesPath, `${String(index).padStart(2, "0")}.yaml`),
        serializeYamlRecord(candidate),
        "utf8",
      ),
    ),
  ]);

  const result = run([
    "apply",
    basePath,
    changeSetPath,
    revisionPath,
    outputPath,
    "--candidates",
    candidatesPath,
  ]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.graphRevision, record.resultingRevision);
  assert.equal((await readGraphPackage(outputPath)).elements.length, 3);

  for (const [candidatePath, code] of [
    [join(directory, "missing-candidates"), "PACKAGE_FILE_MISSING"],
    [changeSetPath, "PACKAGE_CANDIDATE_DIRECTORY_INVALID"],
  ]) {
    const failure = run([
      "apply",
      basePath,
      changeSetPath,
      revisionPath,
      join(directory, "unused-output"),
      "--candidates",
      candidatePath,
    ]);
    assert.equal(failure.status, 1, failure.stderr);
    const issue = JSON.parse(failure.stdout).issues[0];
    assert.equal(issue.code, code);
    assert.equal(issue.path, candidatePath);
  }
});

test("reports missing apply CLI inputs in declaration order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-apply-cli-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = await copyValidatedFixture(directory);
  const baseBefore = await readGraphPackage(basePath);
  const { candidateElements, record } = await vector(basePath);
  const names = ["ChangeSet", "resulting GraphRevision", "candidate elements"];

  for (const [index, name] of names.entries()) {
    await t.test(name, async () => {
      const caseDirectory = join(directory, String(index));
      const candidatesPath = join(caseDirectory, "candidates");
      const changeSetPath = join(caseDirectory, "changeset.yaml");
      const revisionPath = join(caseDirectory, "revision.yaml");
      const outputPath = join(caseDirectory, "result");
      await mkdir(candidatesPath, { recursive: true });
      await Promise.all([
        writeFile(changeSetPath, serializeYamlRecord(record), "utf8"),
        writeFile(
          revisionPath,
          serializeYamlRecord(resultingRevision(record)),
          "utf8",
        ),
        ...candidateElements.map((candidate, candidateIndex) =>
          writeFile(
            join(
              candidatesPath,
              `${String(candidateIndex).padStart(2, "0")}.yaml`,
            ),
            serializeYamlRecord(candidate),
            "utf8",
          ),
        ),
      ]);
      const inputPaths = [changeSetPath, revisionPath, candidatesPath];
      for (const inputPath of inputPaths.slice(index)) {
        await rm(inputPath, { recursive: true, force: true });
      }

      const result = run([
        "apply",
        basePath,
        changeSetPath,
        revisionPath,
        outputPath,
        "--candidates",
        candidatesPath,
      ]);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.equal(result.stderr, "");
      const response = JSON.parse(result.stdout);
      assert.equal(response.valid, false);
      assert.equal(response.issues.length, 1);
      assert.equal(response.issues[0].code, "PACKAGE_FILE_MISSING");
      assert.equal(response.issues[0].path, inputPaths[index]);
      await doesNotExist(outputPath);
      assert.deepEqual(await readGraphPackage(basePath), baseBefore);
    });
  }
});

test("applies a candidate-free ChangeSet through the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-apply-retire-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = await copyValidatedFixture(directory);
  const base = await readGraphPackage(basePath);
  const { record } = await vector(basePath);
  record.operations = [
    {
      op: "retire",
      targetId: base.elements[0].id,
      beforeRevision: base.elements[0].revision,
    },
  ];
  record.resultingRootDigest = graphRootDigest([base.elements[1]]);
  const changeSetPath = join(directory, "changeset.yaml");
  const revisionPath = join(directory, "revision.yaml");
  const outputPath = join(directory, "result");
  await Promise.all([
    writeFile(changeSetPath, serializeYamlRecord(record), "utf8"),
    writeFile(
      revisionPath,
      serializeYamlRecord(resultingRevision(record)),
      "utf8",
    ),
  ]);

  const result = run([
    "apply",
    basePath,
    changeSetPath,
    revisionPath,
    outputPath,
  ]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal((await readGraphPackage(outputPath)).elements.length, 1);
});

test("rejects invalid apply CLI arguments with usage", () => {
  for (const arguments_ of [
    ["apply"],
    ["apply", "base", "change.yaml", "revision.yaml"],
    ["apply", "base", "change.yaml", "revision.yaml", "out", "extra"],
    [
      "apply",
      "base",
      "change.yaml",
      "revision.yaml",
      "out",
      "--candidates",
    ],
  ]) {
    const result = run(arguments_);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /morivyx apply <base>/);
    assert.equal(result.stdout, "");
  }
});
