import assert from "node:assert/strict";
import test from "node:test";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import {
  prepareDecisionCreation,
  validateDecisionCreationRequest,
  writeCreatedDecisionPackage,
} from "../src/decision-creation.js";
import { PackageError } from "../src/errors.js";

const schemaLockDigest = `sha256:${"1".repeat(64)}`;

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(suffix, type = "core.artifact") {
  const element = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "approved",
    attributes: {
      artifactKind: "document",
      uri: "urn:morivyx:test:existing",
    },
    provenance: {
      method: "generated",
      actor: stableId(900),
      recordedAt: "2026-09-01T15:00:00Z",
    },
  };
  element.revision = revisionId(element);
  return element;
}

function packageContents(elements = [entity(1)]) {
  return {
    elements,
    approvals: [],
    changeSets: [],
    migrations: [],
    reports: [],
    schemaLock: {
      schemas: [{ schemaId: "morivyx.core", version: "0.1" }],
    },
    revision: {
      format: "morivyx.graph-revision/0.1",
      id: "graph:decision-base",
      parentRevision: null,
      rootDigest: graphRootDigest(elements),
      schemaLockDigest,
    },
    calculatedSchemaLockDigest: schemaLockDigest,
  };
}

function request() {
  return {
    format: "morivyx.decision-creation-request/0.1",
    decisionId: stableId(2),
    attributes: {
      consequences: ["Creation becomes reproducible."],
      question: "How should a Decision be created?",
      rationale: "Use one strict request.",
    },
    changeSetId: stableId(3),
    resultingRevision: "graph:decision-created",
    actor: stableId(900),
    recordedAt: "2026-09-01T15:05:00Z",
  };
}

function expectError(callback, code, path) {
  assert.throws(
    callback,
    (error) =>
      error instanceof PackageError &&
      error.code === code &&
      error.path === path,
  );
}

test("derives a deterministic draft Decision, ChangeSet, and Graph Revision", () => {
  const base = packageContents();
  const input = request();
  const baseSnapshot = structuredClone(base);
  const inputSnapshot = structuredClone(input);

  const prepared = prepareDecisionCreation(base, input);

  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(prepared.candidateElement, {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: input.decisionId,
    type: "core.decision",
    typeVersion: "0.1",
    revision: prepared.candidateElement.revision,
    lifecycle: "draft",
    reviewState: "unreviewed",
    attributes: input.attributes,
    provenance: {
      method: "asserted",
      actor: input.actor,
      recordedAt: input.recordedAt,
    },
  });
  assert.equal(
    prepared.candidateElement.revision,
    revisionId(prepared.candidateElement),
  );
  assert.deepEqual(prepared.changeSet.operations, [
    {
      op: "create",
      targetId: input.decisionId,
      afterRevision: prepared.candidateElement.revision,
    },
  ]);
  assert.equal(prepared.changeSet.id, input.changeSetId);
  assert.equal(prepared.changeSet.baseRevision, base.revision.id);
  assert.equal(
    prepared.changeSet.resultingRootDigest,
    graphRootDigest([...base.elements, prepared.candidateElement]),
  );
  assert.deepEqual(prepared.resultingRevision, {
    format: "morivyx.graph-revision/0.1",
    id: input.resultingRevision,
    parentRevision: base.revision.id,
    rootDigest: prepared.changeSet.resultingRootDigest,
    schemaLockDigest,
  });

  const reordered = request();
  reordered.attributes = {
    rationale: reordered.attributes.rationale,
    question: reordered.attributes.question,
    consequences: reordered.attributes.consequences,
  };
  const repeated = prepareDecisionCreation(base, reordered);
  assert.equal(
    repeated.candidateElement.revision,
    prepared.candidateElement.revision,
  );
  assert.deepEqual(repeated.changeSet, prepared.changeSet);
  assert.deepEqual(repeated.resultingRevision, prepared.resultingRevision);
});

test("rejects malformed Decision creation requests", async () => {
  for (const invalidInput of [undefined, null]) {
    await assert.rejects(
      writeCreatedDecisionPackage(invalidInput),
      (error) =>
        error instanceof PackageError &&
        error.code === "DECISION_CREATION_REQUEST_INVALID" &&
        error.path === "",
    );
  }
  const valid = request();
  const cases = [
    [{ ...valid, extra: true }, "/request.yaml#/extra"],
    [{ ...valid, format: "unknown" }, "/request.yaml#/format"],
    [{ ...valid, decisionId: "invalid" }, "/request.yaml#/decisionId"],
    [{ ...valid, attributes: [] }, "/request.yaml#/attributes"],
    [{ ...valid, attributes: { invalid: "\ud800" } }, "/request.yaml#/attributes"],
    [{ ...valid, changeSetId: "invalid" }, "/request.yaml#/changeSetId"],
    [
      { ...valid, changeSetId: valid.decisionId },
      "/request.yaml#/changeSetId",
    ],
    [
      { ...valid, resultingRevision: "invalid" },
      "/request.yaml#/resultingRevision",
    ],
    [{ ...valid, actor: "invalid" }, "/request.yaml#/actor"],
    [{ ...valid, recordedAt: "invalid" }, "/request.yaml#/recordedAt"],
    [
      { ...valid, recordedAt: "2026-02-30T00:00:00Z" },
      "/request.yaml#/recordedAt",
    ],
  ];
  for (const [input, path] of cases) {
    expectError(
      () => validateDecisionCreationRequest(input, "/request.yaml"),
      "DECISION_CREATION_REQUEST_INVALID",
      path,
    );
  }
});

test("rejects invalid packages and identifier collisions", () => {
  const input = request();
  expectError(
    () => prepareDecisionCreation(null, input),
    "DECISION_CREATION_PACKAGE_INVALID",
    "/package",
  );

  const existingDecision = entity(2, "core.decision");
  expectError(
    () =>
      prepareDecisionCreation(
        packageContents([existingDecision]),
        input,
        "/request.yaml",
      ),
    "DECISION_CREATION_ID_EXISTS",
    "/request.yaml#/decisionId",
  );

  const existingChangeSet = packageContents();
  existingChangeSet.changeSets.push({ id: input.changeSetId });
  existingChangeSet.approvals.push({ id: stableId(40) });
  existingChangeSet.migrations.push({ id: stableId(41) });
  existingChangeSet.reports.push({ report: { id: stableId(42) } });
  expectError(
    () =>
      prepareDecisionCreation(existingChangeSet, input, "/request.yaml"),
    "DECISION_CREATION_CHANGESET_ID_EXISTS",
    "/request.yaml#/changeSetId",
  );

  const existingReport = packageContents();
  existingReport.reports.push({ id: input.decisionId });
  expectError(
    () => prepareDecisionCreation(existingReport, input, "/request.yaml"),
    "DECISION_CREATION_ID_EXISTS",
    "/request.yaml#/decisionId",
  );

  expectError(
    () =>
      prepareDecisionCreation(
        packageContents(),
        { ...input, resultingRevision: "graph:decision-base" },
        "/request.yaml",
      ),
    "DECISION_CREATION_RESULT_INVALID",
    "/request.yaml#/resultingRevision",
  );

  const missingSchema = packageContents();
  missingSchema.schemaLock.schemas = [];
  expectError(
    () => prepareDecisionCreation(missingSchema, input),
    "DECISION_CREATION_SCHEMA_MISSING",
    "/package/schema.lock.yaml#/schemas",
  );
});
