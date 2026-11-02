import assert from "node:assert/strict";
import test from "node:test";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import {
  prepareDecisionRevision,
  validateDecisionRevisionRequest,
  writeRevisedDecisionPackage,
} from "../src/decision-revision.js";
import { PackageError } from "../src/errors.js";

const schemaLockDigest = `sha256:${"1".repeat(64)}`;

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(suffix, type, lifecycle = "active") {
  const element = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle,
    reviewState: "approved",
    attributes: {
      consequences: ["existing"],
      question: "What should remain stable?",
      rationale: "The original rationale.",
    },
    provenance: {
      method: "generated",
      actor: stableId(900),
      recordedAt: "2026-09-01T15:00:00Z",
    },
    extensions: {
      "example.test/context": { preserved: true },
    },
  };
  element.revision = revisionId(element);
  return element;
}

function packageContents(element) {
  return {
    elements: [element],
    approvals: [],
    changeSets: [],
    migrations: [],
    reports: [],
    revision: {
      format: "morivyx.graph-revision/0.1",
      id: "graph:decision-v1",
      parentRevision: null,
      rootDigest: graphRootDigest([element]),
      schemaLockDigest,
    },
    calculatedSchemaLockDigest: schemaLockDigest,
  };
}

function request() {
  return {
    format: "morivyx.decision-revision-request/0.1",
    decisionId: stableId(1),
    attributes: {
      consequences: ["updated"],
      question: "What should remain stable?",
      rationale: "The revised rationale.",
    },
    changeSetId: stableId(2),
    resultingRevision: "graph:decision-v2",
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

test("derives a deterministic Decision revision, ChangeSet, and Graph Revision", () => {
  const current = entity(1, "core.decision");
  const base = packageContents(current);
  const input = request();
  const baseSnapshot = structuredClone(base);
  const inputSnapshot = structuredClone(input);

  const prepared = prepareDecisionRevision(base, input);

  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(prepared.candidateElement.attributes, input.attributes);
  assert.equal(prepared.candidateElement.lifecycle, "active");
  assert.equal(prepared.candidateElement.reviewState, "unreviewed");
  assert.deepEqual(prepared.candidateElement.provenance, {
    method: "asserted",
    actor: input.actor,
    recordedAt: input.recordedAt,
  });
  assert.deepEqual(
    prepared.candidateElement.extensions,
    current.extensions,
  );
  assert.equal(
    prepared.candidateElement.revision,
    revisionId(prepared.candidateElement),
  );
  assert.deepEqual(prepared.changeSet.operations, [
    {
      op: "revise",
      targetId: current.id,
      beforeRevision: current.revision,
      afterRevision: prepared.candidateElement.revision,
    },
  ]);
  assert.equal(prepared.changeSet.id, input.changeSetId);
  assert.equal(prepared.changeSet.baseRevision, base.revision.id);
  assert.equal(
    prepared.changeSet.resultingRootDigest,
    graphRootDigest([prepared.candidateElement]),
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
  const repeated = prepareDecisionRevision(base, reordered);
  assert.equal(
    repeated.candidateElement.revision,
    prepared.candidateElement.revision,
  );
  assert.deepEqual(repeated.changeSet, prepared.changeSet);
  assert.deepEqual(repeated.resultingRevision, prepared.resultingRevision);
});

test("rejects malformed Decision revision requests", async () => {
  for (const invalidInput of [undefined, null]) {
    await assert.rejects(
      writeRevisedDecisionPackage(invalidInput),
      (error) =>
        error instanceof PackageError &&
        error.code === "DECISION_REVISION_REQUEST_INVALID" &&
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
    [{ ...valid, changeSetId: valid.decisionId }, "/request.yaml#/changeSetId"],
    [{ ...valid, resultingRevision: "invalid" }, "/request.yaml#/resultingRevision"],
    [{ ...valid, actor: "invalid" }, "/request.yaml#/actor"],
    [{ ...valid, recordedAt: "invalid" }, "/request.yaml#/recordedAt"],
    [{ ...valid, recordedAt: "2026-02-30T00:00:00Z" }, "/request.yaml#/recordedAt"],
  ];
  for (const [input, path] of cases) {
    expectError(
      () => validateDecisionRevisionRequest(input, "/request.yaml"),
      "DECISION_REVISION_REQUEST_INVALID",
      path,
    );
  }
});

test("accepts only an existing draft or active core.decision", () => {
  const input = request();
  expectError(
    () => prepareDecisionRevision(null, input),
    "DECISION_REVISION_PACKAGE_INVALID",
    "/package",
  );
  expectError(
    () =>
      prepareDecisionRevision(
        packageContents(entity(3, "core.decision")),
        input,
        "/request.yaml",
      ),
    "DECISION_REVISION_TARGET_MISSING",
    "/request.yaml#/decisionId",
  );
  expectError(
    () =>
      prepareDecisionRevision(
        packageContents(entity(1, "core.artifact")),
        input,
        "/request.yaml",
      ),
    "DECISION_REVISION_TARGET_INVALID",
    "/request.yaml#/decisionId",
  );
  for (const lifecycle of [
    "accepted",
    "deprecated",
    "retracted",
    "superseded",
  ]) {
    expectError(
      () =>
        prepareDecisionRevision(
          packageContents(entity(1, "core.decision", lifecycle)),
          input,
          "/request.yaml",
        ),
      "DECISION_REVISION_LIFECYCLE_INVALID",
      "/request.yaml#/decisionId",
    );
  }
  expectError(
    () =>
      prepareDecisionRevision(
        packageContents(entity(1, "core.decision")),
        { ...input, resultingRevision: "graph:decision-v1" },
        "/request.yaml",
      ),
    "DECISION_REVISION_RESULT_INVALID",
    "/request.yaml#/resultingRevision",
  );

  for (const addCollision of [
    (base) => base.elements.push({ id: input.changeSetId }),
    (base) => base.approvals.push({ id: input.changeSetId }),
    (base) => base.changeSets.push({ id: input.changeSetId }),
    (base) => base.migrations.push({ id: input.changeSetId }),
    (base) =>
      base.reports.push({ report: { id: input.changeSetId } }),
    (base) => base.reports.push({ id: input.changeSetId }),
  ]) {
    const base = packageContents(entity(1, "core.decision"));
    addCollision(base);
    expectError(
      () => prepareDecisionRevision(base, input, "/request.yaml"),
      "DECISION_REVISION_CHANGESET_ID_EXISTS",
      "/request.yaml#/changeSetId",
    );
  }
});
