import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import { applyChangeSet } from "../src/changeset-apply.js";
import { PackageError } from "../src/errors.js";
import { readGraphPackage } from "../src/package-reader.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const schemaLockDigest =
  "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842";
const changeSetId = "urn:uuid:550e8400-e29b-41d4-a716-446655440005";

function candidateElements(base) {
  const revised = structuredClone(base.elements[0]);
  revised.attributes.stringValues[2] = "revised";
  revised.revision = revisionId(revised);
  const created = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
    type: "core.observation",
    typeVersion: "0.1",
    revision:
      "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
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
  assert.equal(
    revised.revision,
    "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
  );
  assert.equal(revisionId(created), created.revision);
  return [revised, created];
}

function vectorChangeSet() {
  return {
    format: "morivyx.changeset/0.1",
    id: changeSetId,
    baseRevision: "graph:stage-1-package-v1",
    resultingRevision: "graph:stage-1-package-v2",
    resultingRootDigest:
      "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538",
    schemaLockDigest,
    operations: [
      {
        op: "revise",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        beforeRevision:
          "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
        afterRevision:
          "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
      },
      {
        op: "create",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
        afterRevision:
          "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
      },
    ],
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-07-31T05:00:00Z",
    },
    recordedAt: "2026-07-31T05:00:00Z",
  };
}

function resultingRevision(changeSet) {
  return {
    format: "morivyx.graph-revision/0.1",
    id: changeSet.resultingRevision,
    parentRevision: changeSet.baseRevision,
    rootDigest: changeSet.resultingRootDigest,
    schemaLockDigest: changeSet.schemaLockDigest,
  };
}

async function vectorInput() {
  const base = await readGraphPackage(fixture);
  const changeSet = vectorChangeSet();
  return {
    changeSet,
    currentRevision: base.revision,
    schemaLockDigest,
    currentElements: base.elements,
    candidateElements: candidateElements(base),
    resultingRevision: resultingRevision(changeSet),
  };
}

function expectCode(action, code, path) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}

test("applies the ChangeSet validation vector", async () => {
  const input = await vectorInput();
  const result = applyChangeSet(input);

  assert.equal(result.elements.length, 3);
  assert.equal(result.rootDigest, input.changeSet.resultingRootDigest);
  assert.deepEqual(result.revision, input.resultingRevision);
  assert.deepEqual(
    result.elements.map(({ id }) => id),
    [
      "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      "urn:uuid:550e8400-e29b-41d4-a716-446655440002",
      "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
    ],
  );
});

test("applies retire and replace operations", async (t) => {
  const base = await readGraphPackage(fixture);
  await t.test("retire", () => {
    const remaining = [base.elements[1]];
    const changeSet = vectorChangeSet();
    changeSet.operations = [
      {
        op: "retire",
        targetId: base.elements[0].id,
        beforeRevision: base.elements[0].revision,
      },
    ];
    changeSet.resultingRootDigest = graphRootDigest(remaining);
    const result = applyChangeSet({
      changeSet,
      currentRevision: base.revision,
      schemaLockDigest,
      currentElements: base.elements,
      resultingRevision: resultingRevision(changeSet),
    });
    assert.deepEqual(result.elements, remaining);
  });

  await t.test("replace", () => {
    const replacement = structuredClone(base.elements[0]);
    replacement.id = "urn:uuid:550e8400-e29b-41d4-a716-446655440004";
    replacement.revision = revisionId(replacement);
    const expected = [base.elements[1], replacement];
    const changeSet = vectorChangeSet();
    changeSet.operations = [
      {
        op: "replace",
        targetId: base.elements[0].id,
        beforeRevision: base.elements[0].revision,
        afterRevision: replacement.revision,
        replacementId: replacement.id,
      },
    ];
    changeSet.resultingRootDigest = graphRootDigest(expected);
    const result = applyChangeSet({
      changeSet,
      currentRevision: base.revision,
      schemaLockDigest,
      currentElements: base.elements,
      candidateElements: [replacement],
      resultingRevision: resultingRevision(changeSet),
    });
    assert.deepEqual(result.elements, expected);
  });
});

test("applies operations in their listed order", async () => {
  const base = await readGraphPackage(fixture);
  const created = candidateElements(base)[1];
  const revised = structuredClone(created);
  revised.attributes.stringValues[0] = "revised-third";
  revised.revision = revisionId(revised);
  const changeSet = vectorChangeSet();
  changeSet.operations = [
    {
      op: "create",
      targetId: created.id,
      afterRevision: created.revision,
    },
    {
      op: "revise",
      targetId: created.id,
      beforeRevision: created.revision,
      afterRevision: revised.revision,
    },
  ];
  changeSet.resultingRootDigest = graphRootDigest([...base.elements, revised]);
  const input = {
    changeSet,
    currentRevision: base.revision,
    schemaLockDigest,
    currentElements: base.elements,
    candidateElements: [created, revised],
    resultingRevision: resultingRevision(changeSet),
  };

  assert.equal(applyChangeSet(input).elements.at(-1).revision, revised.revision);
  const reversed = structuredClone(input);
  reversed.changeSet.operations.reverse();
  expectCode(
    () => applyChangeSet(reversed),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/0/targetId",
  );
});

test("accepts only a known and unapplied revoke target", async () => {
  const base = await readGraphPackage(fixture);
  const changeSet = vectorChangeSet();
  const revokedId = "urn:uuid:550e8400-e29b-41d4-a716-446655440006";
  changeSet.operations = [{ op: "revoke", targetId: revokedId }];
  changeSet.resultingRootDigest = base.revision.rootDigest;
  const input = {
    changeSet,
    currentRevision: base.revision,
    schemaLockDigest,
    currentElements: base.elements,
    resultingRevision: resultingRevision(changeSet),
    knownChangeSetIds: [revokedId],
  };

  assert.deepEqual(applyChangeSet(input).elements, base.elements);
  expectCode(
    () => applyChangeSet({ ...input, knownChangeSetIds: [] }),
    "CHANGESET_REVOKE_INVALID",
    "/operations/0/targetId",
  );
  expectCode(
    () => applyChangeSet({ ...input, appliedChangeSetIds: [revokedId] }),
    "CHANGESET_REVOKE_INVALID",
    "/operations/0/targetId",
  );
  expectCode(
    () => applyChangeSet({ ...input, knownChangeSetIds: null }),
    "CHANGESET_APPLY_INVALID",
    "/knownChangeSetIds",
  );
  expectCode(
    () => applyChangeSet({ ...input, knownChangeSetIds: ["invalid"] }),
    "CHANGESET_APPLY_INVALID",
    "/knownChangeSetIds/0",
  );
  expectCode(
    () =>
      applyChangeSet({
        ...input,
        appliedChangeSetIds: [revokedId, revokedId],
      }),
    "CHANGESET_APPLY_INVALID",
    "/appliedChangeSetIds/1",
  );
  expectCode(
    () =>
      applyChangeSet({
        ...input,
        changeSet: {
          ...changeSet,
          operations: [{ op: "revoke", targetId: changeSetId }],
        },
        knownChangeSetIds: [changeSetId],
      }),
    "CHANGESET_REVOKE_INVALID",
    "/operations/0/targetId",
  );
});

test("rejects base, Schema, and operation precondition mismatches", async () => {
  const input = await vectorInput();
  const baseMismatch = structuredClone(input);
  baseMismatch.changeSet.baseRevision = "graph:other";
  const schemaMismatch = structuredClone(input);
  schemaMismatch.changeSet.schemaLockDigest = `sha256:${"0".repeat(64)}`;
  const beforeMismatch = structuredClone(input);
  beforeMismatch.changeSet.operations[0].beforeRevision = `sha256:${"0".repeat(64)}`;
  const createExisting = structuredClone(input);
  createExisting.changeSet.operations[1].targetId = input.currentElements[1].id;
  const missingTarget = structuredClone(input);
  missingTarget.changeSet.operations[0].targetId =
    "urn:uuid:550e8400-e29b-41d4-a716-446655440099";
  const replacementExists = structuredClone(input);
  replacementExists.changeSet.operations = [
    {
      op: "replace",
      targetId: input.currentElements[0].id,
      beforeRevision: input.currentElements[0].revision,
      afterRevision: input.candidateElements[0].revision,
      replacementId: input.currentElements[1].id,
    },
  ];

  expectCode(
    () => applyChangeSet(baseMismatch),
    "CHANGESET_BASE_REVISION_MISMATCH",
    "/baseRevision",
  );
  expectCode(
    () => applyChangeSet(schemaMismatch),
    "CHANGESET_SCHEMA_LOCK_MISMATCH",
    "/schemaLockDigest",
  );
  expectCode(
    () => applyChangeSet(beforeMismatch),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/0/beforeRevision",
  );
  expectCode(
    () => applyChangeSet(createExisting),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/1/targetId",
  );
  expectCode(
    () => applyChangeSet(missingTarget),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/0/targetId",
  );
  expectCode(
    () => applyChangeSet(replacementExists),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/0/replacementId",
  );
});

test("rejects missing, invalid, and unreferenced candidates", async () => {
  const input = await vectorInput();
  const missing = { ...input, candidateElements: input.candidateElements.slice(0, 1) };
  const invalid = structuredClone(input);
  invalid.candidateElements[0].attributes.stringValues[0] = "tampered";
  const unreferenced = structuredClone(input);
  const extra = structuredClone(input.candidateElements[1]);
  extra.id = "urn:uuid:550e8400-e29b-41d4-a716-446655440006";
  extra.revision = revisionId(extra);
  unreferenced.candidateElements.push(extra);

  expectCode(
    () => applyChangeSet(missing),
    "CHANGESET_PRECONDITION_FAILED",
    "/operations/1/afterRevision",
  );
  expectCode(
    () => applyChangeSet(invalid),
    "CHANGESET_CANDIDATE_REVISION_MISMATCH",
    "/candidateElements/0/revision",
  );
  expectCode(
    () => applyChangeSet(unreferenced),
    "CHANGESET_PRECONDITION_FAILED",
    "/candidateElements/2",
  );
});

test("rejects invalid current and candidate GraphElement envelopes", async () => {
  const input = await vectorInput();
  const invalidCurrent = structuredClone(input);
  invalidCurrent.currentElements[0].extra = true;
  invalidCurrent.currentElements[0].revision = revisionId(
    invalidCurrent.currentElements[0],
  );
  const invalidCandidate = structuredClone(input);
  invalidCandidate.candidateElements[0].extra = true;
  invalidCandidate.candidateElements[0].revision = revisionId(
    invalidCandidate.candidateElements[0],
  );

  expectCode(
    () => applyChangeSet(invalidCurrent),
    "CHANGESET_APPLY_INVALID",
    "/currentElements/0/extra",
  );
  expectCode(
    () => applyChangeSet(invalidCandidate),
    "CHANGESET_APPLY_INVALID",
    "/candidateElements/0/extra",
  );
});

test("rejects malformed ChangeSet application collections", async () => {
  for (const input of [null, undefined]) {
    expectCode(() => applyChangeSet(input), "CHANGESET_INVALID", "");
  }
  const input = await vectorInput();
  const duplicateCurrent = structuredClone(input);
  duplicateCurrent.currentElements.push(
    structuredClone(duplicateCurrent.currentElements[0]),
  );
  const duplicateCandidate = structuredClone(input);
  duplicateCandidate.candidateElements.push(
    structuredClone(duplicateCandidate.candidateElements[0]),
  );
  const cases = [
    [{ ...input, currentElements: null }, "/currentElements"],
    [{ ...input, currentElements: [null] }, "/currentElements/0"],
    [{ ...input, currentElements: [{}] }, "/currentElements/0"],
    [duplicateCurrent, "/currentElements/2/id"],
    [{ ...input, candidateElements: null }, "/candidateElements"],
    [{ ...input, candidateElements: [null] }, "/candidateElements/0"],
    [{ ...input, candidateElements: [{}] }, "/candidateElements/0"],
    [duplicateCandidate, "/candidateElements/2"],
    [{ ...input, currentRevision: undefined }, "/currentRevision"],
  ];

  for (const [candidate, path] of cases) {
    expectCode(
      () => applyChangeSet(candidate),
      "CHANGESET_APPLY_INVALID",
      path,
    );
  }
});

test("rejects resulting digest and GraphRevision mismatches atomically", async () => {
  const input = await vectorInput();
  const snapshot = structuredClone(input);
  const rootMismatch = structuredClone(input);
  rootMismatch.changeSet.resultingRootDigest = `sha256:${"0".repeat(64)}`;
  rootMismatch.resultingRevision.rootDigest = rootMismatch.changeSet.resultingRootDigest;
  const revisionMismatch = structuredClone(input);
  revisionMismatch.resultingRevision.parentRevision = "graph:other";
  const currentContentMismatch = structuredClone(input);
  currentContentMismatch.currentElements[0].attributes.stringValues[0] = "tampered";
  const currentRootMismatch = structuredClone(input);
  currentRootMismatch.currentRevision.rootDigest = `sha256:${"0".repeat(64)}`;
  const missingResult = { ...input, resultingRevision: undefined };
  const invalidCurrentRevision = structuredClone(input);
  invalidCurrentRevision.currentRevision.extra = true;
  const invalidResultingRevision = structuredClone(input);
  invalidResultingRevision.resultingRevision.extra = true;
  const selfParent = structuredClone(input);
  selfParent.changeSet.resultingRevision = selfParent.changeSet.baseRevision;
  selfParent.resultingRevision.id = selfParent.changeSet.baseRevision;

  expectCode(
    () => applyChangeSet(rootMismatch),
    "CHANGESET_RESULT_MISMATCH",
    "/resultingRootDigest",
  );
  expectCode(
    () => applyChangeSet(revisionMismatch),
    "CHANGESET_RESULT_MISMATCH",
    "/resultingRevisionRecord/parentRevision",
  );
  expectCode(
    () => applyChangeSet(currentContentMismatch),
    "CHANGESET_APPLY_INVALID",
    "/currentElements/0/revision",
  );
  expectCode(
    () => applyChangeSet(currentRootMismatch),
    "CHANGESET_APPLY_INVALID",
    "/currentRevision/rootDigest",
  );
  expectCode(
    () => applyChangeSet(missingResult),
    "CHANGESET_RESULT_MISMATCH",
    "/resultingRevisionRecord",
  );
  expectCode(
    () => applyChangeSet(invalidCurrentRevision),
    "CHANGESET_APPLY_INVALID",
    "/currentRevision/extra",
  );
  expectCode(
    () => applyChangeSet(invalidResultingRevision),
    "CHANGESET_RESULT_MISMATCH",
    "/resultingRevisionRecord/extra",
  );
  expectCode(
    () => applyChangeSet(selfParent),
    "CHANGESET_RESULT_MISMATCH",
    "/resultingRevisionRecord/parentRevision",
  );
  assert.deepEqual(input, snapshot);
});
