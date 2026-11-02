import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { parse } from "yaml";
import {
  graphRootDigest,
  revisionId,
  schemaDefinitionDigest,
  schemaLockDigest,
} from "../src/canonical.js";
import { yaml } from "../test-support/yaml.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..", "..");
const cliPath = join(testDirectory, "..", "src", "cli.js");
const networkGuardPath = join(
  testDirectory,
  "..",
  "test-support",
  "network-denial-guard.mjs",
);
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(suffix, type, attributes) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes,
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-09-01T15:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

function relation(suffix, source, predicate, target) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "relation",
    id: stableId(suffix),
    type: `core.${predicate}`,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: { source, predicate, target },
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-09-01T15:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

async function createPackage() {
  const root = await mkdtemp(join(tmpdir(), "morivyx-offline-"));
  temporaryDirectories.add(root);
  const packagePath = join(root, "package-copy");
  const metadataPath = join(packagePath, ".morivyx");
  const schemaDirectory = join(metadataPath, "schemas");
  const entityDirectory = join(metadataPath, "graph", "entities");
  const relationDirectory = join(metadataPath, "graph", "relations");
  await Promise.all([
    mkdir(schemaDirectory, { recursive: true }),
    mkdir(entityDirectory, { recursive: true }),
    mkdir(relationDirectory, { recursive: true }),
  ]);

  const schema = parse(
    await readFile(
      join(repositoryRoot, "docs", "schema", "morivyx.core@0.1.yaml"),
      "utf8",
    ),
  );
  const artifact = entity(1, "core.artifact", {
    artifactKind: "document",
    uri: "urn:morivyx:test:offline-artifact",
  });
  const decision = entity(2, "core.decision", {
    consequences: ["offline-validation"],
    question: "Can the package be validated without network access?",
    rationale: "The canonical package must remain locally usable.",
  });
  const elements = [
    artifact,
    decision,
    relation(3, decision.id, "governs", artifact.id),
  ];
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
  const graphRevision = {
    format: "morivyx.graph-revision/0.1",
    id: "graph:offline-cli-v1",
    parentRevision: null,
    rootDigest: graphRootDigest(elements),
    schemaLockDigest: schemaLockDigest(lock),
  };

  await Promise.all([
    writeFile(
      join(schemaDirectory, "morivyx.core@0.1.yaml"),
      yaml(schema),
    ),
    writeFile(join(metadataPath, "schema.lock.yaml"), yaml(lock)),
    writeFile(join(metadataPath, "revision.yaml"), yaml(graphRevision)),
    ...elements.map((element) =>
      writeFile(
        join(
          element.kind === "entity" ? entityDirectory : relationDirectory,
          `${element.id.slice("urn:uuid:".length)}.yaml`,
        ),
        yaml(element),
      ),
    ),
  ]);
  return { artifact, decision, elements, graphRevision, packagePath };
}

function runOffline(arguments_) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      networkGuardPath,
      cliPath,
      ...arguments_,
    ],
    { encoding: "utf8" },
  );
}

test("validates and reports from a copied package without network access", async () => {
  const denied = spawnSync(
    process.execPath,
    [
      "--import",
      networkGuardPath,
      "-e",
      'require("node:net").connect({ host: "127.0.0.1", port: 1 })',
    ],
    { encoding: "utf8" },
  );
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /MORIVYX_TEST_NETWORK_DENIED/);

  const { artifact, packagePath } = await createPackage();
  const validated = runOffline(["validate", packagePath]);
  assert.equal(validated.status, 0, validated.stdout || validated.stderr);
  const validation = JSON.parse(validated.stdout);
  assert.equal(validation.valid, true);
  assert.equal(validation.graphRevision, "graph:offline-cli-v1");
  assert.match(validation.schemaLockDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(validation.rootDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(validation.issues, []);

  const reportId = stableId(10);
  const traced = runOffline([
    "trace",
    packagePath,
    "--query",
    "governing-decision",
    "--focus",
    artifact.id,
    "--evaluated-at",
    "2026-09-01T15:01:00Z",
    "--id",
    reportId,
    "--save",
  ]);
  assert.equal(traced.status, 0, traced.stdout || traced.stderr);
  const generated = JSON.parse(traced.stdout);
  assert.equal(generated.valid, true);
  assert.equal(generated.report.id, reportId);
  assert.equal(generated.report.status, "complete");
  assert.deepEqual(generated.report.missing, []);
  assert.equal(generated.report.paths.length, 1);

  const reported = runOffline(["report", generated.savedPath]);
  assert.equal(reported.status, 0, reported.stdout || reported.stderr);
  const restored = JSON.parse(reported.stdout);
  assert.equal(restored.valid, true);
  assert.equal(restored.type, "trace-report");
  assert.equal(restored.digest, generated.digest);
  assert.deepEqual(restored.report, generated.report);
});

test("revises a Decision from strict YAML files without network access", async () => {
  const { decision, elements, graphRevision, packagePath } =
    await createPackage();
  const revisedDecision = structuredClone(decision);
  revisedDecision.attributes.rationale =
    "The copied package and its Decision must remain locally maintainable.";
  revisedDecision.provenance.recordedAt = "2026-09-01T15:02:00Z";
  revisedDecision.revision = revisionId(revisedDecision);
  const revisedElements = elements.map((element) =>
    element.id === revisedDecision.id ? revisedDecision : element,
  );
  const rootDigest = graphRootDigest(revisedElements);
  const resultingRevision = {
    format: "morivyx.graph-revision/0.1",
    id: "graph:offline-cli-v2",
    parentRevision: graphRevision.id,
    rootDigest,
    schemaLockDigest: graphRevision.schemaLockDigest,
  };
  const changeSet = {
    format: "morivyx.changeset/0.1",
    id: stableId(11),
    baseRevision: graphRevision.id,
    resultingRevision: resultingRevision.id,
    resultingRootDigest: rootDigest,
    schemaLockDigest: graphRevision.schemaLockDigest,
    operations: [
      {
        op: "revise",
        targetId: decision.id,
        beforeRevision: decision.revision,
        afterRevision: revisedDecision.revision,
      },
    ],
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-09-01T15:02:00Z",
    },
    recordedAt: "2026-09-01T15:02:00Z",
  };
  const maintenanceRoot = dirname(packagePath);
  const candidateDirectory = join(maintenanceRoot, "candidates");
  const outputPath = join(maintenanceRoot, "package-v2");
  const changeSetPath = join(maintenanceRoot, "changeset.yaml");
  const revisionPath = join(maintenanceRoot, "revision.yaml");
  const decisionFileName = `${decision.id.slice("urn:uuid:".length)}.yaml`;
  await mkdir(candidateDirectory);
  await Promise.all([
    writeFile(
      join(candidateDirectory, decisionFileName),
      yaml(revisedDecision),
    ),
    writeFile(changeSetPath, yaml(changeSet)),
    writeFile(revisionPath, yaml(resultingRevision)),
  ]);

  const applied = runOffline([
    "apply",
    packagePath,
    changeSetPath,
    revisionPath,
    outputPath,
    "--candidates",
    candidateDirectory,
  ]);
  assert.equal(applied.status, 0, applied.stdout || applied.stderr);
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.valid, true);
  assert.equal(appliedResult.graphRevision, resultingRevision.id);
  assert.equal(appliedResult.rootDigest, rootDigest);

  const validatedRevision = runOffline(["validate", outputPath]);
  assert.equal(
    validatedRevision.status,
    0,
    validatedRevision.stdout || validatedRevision.stderr,
  );
  assert.equal(JSON.parse(validatedRevision.stdout).valid, true);
  const [storedRevision, storedBase] = await Promise.all(
    [outputPath, packagePath].map(async (root) =>
      parse(
        await readFile(
          join(root, ".morivyx", "graph", "entities", decisionFileName),
          "utf8",
        ),
      ),
    ),
  );
  assert.equal(
    storedRevision.attributes.rationale,
    revisedDecision.attributes.rationale,
  );
  assert.equal(storedBase.attributes.rationale, decision.attributes.rationale);
  const validatedBase = runOffline(["validate", packagePath]);
  assert.equal(
    validatedBase.status,
    0,
    validatedBase.stdout || validatedBase.stderr,
  );
  assert.equal(
    JSON.parse(validatedBase.stdout).graphRevision,
    graphRevision.id,
  );
  const diffed = runOffline([
    "diff",
    packagePath,
    outputPath,
    "--evaluated-at",
    "2026-09-01T15:03:00Z",
  ]);
  assert.equal(diffed.status, 0, diffed.stdout || diffed.stderr);
  const semanticDiff = JSON.parse(diffed.stdout);
  assert.equal(semanticDiff.valid, true);
  assert.deepEqual(
    semanticDiff.report.entries.map(({ kind, targetId }) => ({ kind, targetId })),
    [{ kind: "entity_revised", targetId: decision.id }],
  );
});

test("revises a Decision from one request file without network access", async () => {
  const { decision, graphRevision, packagePath } = await createPackage();
  const maintenanceRoot = dirname(packagePath);
  const requestPath = join(maintenanceRoot, "decision-revision-request.yaml");
  const outputPath = join(maintenanceRoot, "package-v2");
  const request = {
    format: "morivyx.decision-revision-request/0.1",
    decisionId: decision.id,
    attributes: {
      consequences: ["offline-maintenance"],
      question: decision.attributes.question,
      rationale:
        "The copied package and its Decision remain locally maintainable.",
    },
    changeSetId: stableId(12),
    resultingRevision: "graph:offline-cli-v2",
    actor: stableId(900),
    recordedAt: "2026-09-01T15:04:00Z",
  };
  await writeFile(requestPath, yaml(request));

  const revised = runOffline([
    "revise-decision",
    packagePath,
    requestPath,
    outputPath,
  ]);
  assert.equal(revised.status, 0, revised.stdout || revised.stderr);
  const result = JSON.parse(revised.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.graphRevision, request.resultingRevision);
  assert.equal(result.decisionId, decision.id);
  assert.equal(result.changeSetId, request.changeSetId);

  const decisionFileName = `${decision.id.slice("urn:uuid:".length)}.yaml`;
  const [storedDecision, storedBase, storedGraphRevision, storedChangeSet] =
    await Promise.all([
      readFile(
        join(
          outputPath,
          ".morivyx",
          "graph",
          "entities",
          decisionFileName,
        ),
        "utf8",
      ).then(parse),
      readFile(
        join(
          packagePath,
          ".morivyx",
          "graph",
          "entities",
          decisionFileName,
        ),
        "utf8",
      ).then(parse),
      readFile(join(outputPath, ".morivyx", "revision.yaml"), "utf8").then(
        parse,
      ),
      readFile(
        join(
          outputPath,
          ".morivyx",
          "ledger",
          `${request.changeSetId.slice("urn:uuid:".length)}.yaml`,
        ),
        "utf8",
      ).then(parse),
    ]);
  assert.deepEqual(storedDecision.attributes, request.attributes);
  assert.equal(storedDecision.lifecycle, decision.lifecycle);
  assert.equal(storedDecision.reviewState, "unreviewed");
  assert.deepEqual(storedDecision.provenance, {
    method: "asserted",
    actor: request.actor,
    recordedAt: request.recordedAt,
  });
  assert.equal(storedDecision.revision, result.decisionRevision);
  assert.deepEqual(storedBase, decision);
  assert.equal(storedGraphRevision.id, request.resultingRevision);
  assert.equal(storedGraphRevision.parentRevision, graphRevision.id);
  assert.equal(storedChangeSet.id, request.changeSetId);
  assert.deepEqual(storedChangeSet.operations, [
    {
      op: "revise",
      targetId: decision.id,
      beforeRevision: decision.revision,
      afterRevision: storedDecision.revision,
    },
  ]);

  const validated = runOffline(["validate", outputPath]);
  assert.equal(validated.status, 0, validated.stdout || validated.stderr);
  assert.equal(JSON.parse(validated.stdout).valid, true);
  const validatedBase = runOffline(["validate", packagePath]);
  assert.equal(
    validatedBase.status,
    0,
    validatedBase.stdout || validatedBase.stderr,
  );
  assert.equal(
    JSON.parse(validatedBase.stdout).graphRevision,
    graphRevision.id,
  );
  const invalidArguments = runOffline([
    "revise-decision",
    packagePath,
    requestPath,
  ]);
  assert.equal(invalidArguments.status, 2);
  assert.match(invalidArguments.stderr, /revise-decision/);

  const diffed = runOffline([
    "diff",
    packagePath,
    outputPath,
    "--evaluated-at",
    "2026-09-01T15:05:00Z",
  ]);
  assert.equal(diffed.status, 0, diffed.stdout || diffed.stderr);
  assert.deepEqual(
    JSON.parse(diffed.stdout).report.entries.map(({ kind, targetId }) => ({
      kind,
      targetId,
    })),
    [{ kind: "entity_revised", targetId: decision.id }],
  );
});

test("creates a draft Decision from one request file without network access", async () => {
  const { graphRevision, packagePath } = await createPackage();
  const maintenanceRoot = dirname(packagePath);
  const requestPath = join(maintenanceRoot, "decision-creation-request.yaml");
  const outputPath = join(maintenanceRoot, "package-created");
  const request = {
    format: "morivyx.decision-creation-request/0.1",
    decisionId: stableId(20),
    attributes: {
      consequences: ["Decision creation is reproducible."],
      question: "How should a new Decision be created?",
      rationale: "Use one strict request file.",
    },
    changeSetId: stableId(21),
    resultingRevision: "graph:offline-cli-created",
    actor: stableId(900),
    recordedAt: "2026-09-01T15:06:00Z",
  };
  await writeFile(requestPath, yaml(request));

  const created = runOffline([
    "create-decision",
    packagePath,
    requestPath,
    outputPath,
  ]);
  assert.equal(created.status, 0, created.stdout || created.stderr);
  const result = JSON.parse(created.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.graphRevision, request.resultingRevision);
  assert.equal(result.decisionId, request.decisionId);
  assert.equal(result.changeSetId, request.changeSetId);

  const decisionFileName = `${request.decisionId.slice("urn:uuid:".length)}.yaml`;
  const [storedDecision, storedGraphRevision, storedChangeSet] =
    await Promise.all([
      readFile(
        join(
          outputPath,
          ".morivyx",
          "graph",
          "entities",
          decisionFileName,
        ),
        "utf8",
      ).then(parse),
      readFile(join(outputPath, ".morivyx", "revision.yaml"), "utf8").then(
        parse,
      ),
      readFile(
        join(
          outputPath,
          ".morivyx",
          "ledger",
          `${request.changeSetId.slice("urn:uuid:".length)}.yaml`,
        ),
        "utf8",
      ).then(parse),
    ]);
  assert.deepEqual(storedDecision.attributes, request.attributes);
  assert.equal(storedDecision.type, "core.decision");
  assert.equal(storedDecision.lifecycle, "draft");
  assert.equal(storedDecision.reviewState, "unreviewed");
  assert.deepEqual(storedDecision.provenance, {
    method: "asserted",
    actor: request.actor,
    recordedAt: request.recordedAt,
  });
  assert.equal(storedDecision.revision, result.decisionRevision);
  assert.equal(storedGraphRevision.id, request.resultingRevision);
  assert.equal(storedGraphRevision.parentRevision, graphRevision.id);
  assert.equal(storedChangeSet.id, request.changeSetId);
  assert.deepEqual(storedChangeSet.operations, [
    {
      op: "create",
      targetId: request.decisionId,
      afterRevision: storedDecision.revision,
    },
  ]);

  await assert.rejects(
    readFile(
      join(
        packagePath,
        ".morivyx",
        "graph",
        "entities",
        decisionFileName,
      ),
      "utf8",
    ),
    { code: "ENOENT" },
  );
  const validated = runOffline(["validate", outputPath]);
  assert.equal(validated.status, 0, validated.stdout || validated.stderr);
  assert.equal(JSON.parse(validated.stdout).valid, true);
  const validatedBase = runOffline(["validate", packagePath]);
  assert.equal(
    validatedBase.status,
    0,
    validatedBase.stdout || validatedBase.stderr,
  );
  assert.equal(
    JSON.parse(validatedBase.stdout).graphRevision,
    graphRevision.id,
  );

  const diffed = runOffline([
    "diff",
    packagePath,
    outputPath,
    "--evaluated-at",
    "2026-09-01T15:07:00Z",
  ]);
  assert.equal(diffed.status, 0, diffed.stdout || diffed.stderr);
  assert.deepEqual(
    JSON.parse(diffed.stdout).report.entries.map(({ kind, targetId }) => ({
      kind,
      targetId,
    })),
    [{ kind: "entity_added", targetId: request.decisionId }],
  );

  const invalidArguments = runOffline([
    "create-decision",
    packagePath,
    requestPath,
  ]);
  assert.equal(invalidArguments.status, 2);
  assert.match(invalidArguments.stderr, /create-decision/);

  const duplicateRequestPath = join(
    maintenanceRoot,
    "duplicate-decision-request.yaml",
  );
  const duplicateRequest = {
    ...request,
    decisionId: stableId(2),
    changeSetId: stableId(22),
    resultingRevision: "graph:offline-cli-duplicate",
  };
  await writeFile(duplicateRequestPath, yaml(duplicateRequest));
  const duplicate = runOffline([
    "create-decision",
    packagePath,
    duplicateRequestPath,
    join(maintenanceRoot, "package-duplicate"),
  ]);
  assert.equal(duplicate.status, 1);
  assert.equal(
    JSON.parse(duplicate.stdout).issues[0].code,
    "DECISION_CREATION_ID_EXISTS",
  );
});
