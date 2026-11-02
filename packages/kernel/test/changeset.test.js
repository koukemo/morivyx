import assert from "node:assert/strict";
import test from "node:test";
import { changeSetDigest, validateChangeSet } from "../src/changeset.js";
import { PackageError } from "../src/errors.js";

const revision = (digit) => `sha256:${digit.repeat(64)}`;
const stableId = (suffix) =>
  `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function changeSet(operations) {
  return {
    format: "morivyx.changeset/0.1",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440005",
    baseRevision: "graph:stage-1-package-v1",
    resultingRevision: "graph:stage-1-package-v2",
    resultingRootDigest:
      "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    operations,
    provenance: {
      method: "generated",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-07-31T05:00:00Z",
    },
    recordedAt: "2026-07-31T05:00:00Z",
  };
}

function expectInvalid(value, pathSuffix) {
  assert.throws(
    () => validateChangeSet(value, "changeset.yaml"),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "CHANGESET_INVALID");
      assert.ok(error.path.endsWith(pathSuffix), error.path);
      return true;
    },
  );
}

test("matches the ChangeSet digest validation vector", () => {
  const value = changeSet([
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
  ]);

  assert.equal(
    changeSetDigest(validateChangeSet(value)),
    "sha256:3ecdeb55f19558e7e9b4a6745f2786a725105cb4c2c51daf02892dffa5fe1ba4",
  );
});

test("accepts every ChangeSet operation shape", () => {
  const cases = [
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
    {
      op: "revise",
      targetId: stableId(1),
      beforeRevision: revision("1"),
      afterRevision: revision("2"),
    },
    { op: "retire", targetId: stableId(1), beforeRevision: revision("1") },
    {
      op: "replace",
      targetId: stableId(1),
      beforeRevision: revision("1"),
      afterRevision: revision("2"),
      replacementId: stableId(2),
    },
    { op: "revoke", targetId: stableId(1) },
  ];

  for (const operation of cases) {
    assert.equal(validateChangeSet(changeSet([operation])).operations[0].op, operation.op);
  }
});

test("rejects invalid ChangeSet value forms with precise paths", () => {
  const operation = {
    op: "create",
    targetId: stableId(1),
    afterRevision: revision("1"),
  };
  const wrongFormat = changeSet([operation]);
  wrongFormat.format = "morivyx.changeset/unknown";
  const missingProvenance = changeSet([operation]);
  missingProvenance.provenance = null;
  const emptyMethod = changeSet([operation]);
  emptyMethod.provenance.method = "";
  const badTimestamp = changeSet([operation]);
  badTimestamp.recordedAt = "2026-07-31T05:00:00";
  const cases = [
    [null, "changeset.yaml"],
    [wrongFormat, "#/format"],
    [changeSet([null]), "#/operations/0"],
    [missingProvenance, "#/provenance"],
    [emptyMethod, "#/provenance/method"],
    [badTimestamp, "#/recordedAt"],
  ];

  for (const [value, pathSuffix] of cases) {
    expectInvalid(value, pathSuffix);
  }
});

test("rejects incomplete and conflicting ChangeSet operations", () => {
  const cases = [
    [changeSet([]), "#/operations"],
    [changeSet([{ op: "unknown", targetId: stableId(1) }]), "#/operations/0/op"],
    [
      changeSet([{ op: "revise", targetId: stableId(1), afterRevision: revision("2") }]),
      "#/operations/0/beforeRevision",
    ],
    [
      changeSet([
        {
          op: "create",
          targetId: stableId(1),
          beforeRevision: revision("1"),
          afterRevision: revision("2"),
        },
      ]),
      "#/operations/0/beforeRevision",
    ],
    [
      changeSet([
        {
          op: "replace",
          targetId: stableId(1),
          beforeRevision: revision("1"),
          afterRevision: revision("2"),
        },
      ]),
      "#/operations/0/replacementId",
    ],
    [
      changeSet([
        { op: "revoke", targetId: stableId(1) },
        { op: "retire", targetId: stableId(2), beforeRevision: revision("1") },
      ]),
      "#/operations",
    ],
  ];

  for (const [value, pathSuffix] of cases) {
    expectInvalid(value, pathSuffix);
  }
});

test("rejects invalid ChangeSet fields and identifiers", () => {
  const unknownField = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  unknownField.extra = "value";
  const badTarget = changeSet([
    { op: "create", targetId: "not-an-id", afterRevision: revision("1") },
  ]);
  const badDigest = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: "sha256:bad" },
  ]);
  const sameReplacement = changeSet([
    {
      op: "replace",
      targetId: stableId(1),
      beforeRevision: revision("1"),
      afterRevision: revision("2"),
      replacementId: stableId(1),
    },
  ]);
  const badBase = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  badBase.baseRevision = "revision";
  const badRecordedAt = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  badRecordedAt.recordedAt = "2026-02-30T00:00:00Z";
  const badProvenanceTime = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  badProvenanceTime.provenance.recordedAt = "2026-08-03T00:00:00+14:01";
  const badUtcYear = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  badUtcYear.recordedAt = "9999-12-31T23:59:59-14:00";
  const offsetTime = changeSet([
    { op: "create", targetId: stableId(1), afterRevision: revision("1") },
  ]);
  offsetTime.recordedAt = "2026-08-03T09:00:00+09:00";
  offsetTime.provenance.recordedAt = "2026-08-03T09:00:00+09:00";

  expectInvalid(unknownField, "#/extra");
  expectInvalid(badTarget, "#/operations/0/targetId");
  expectInvalid(badDigest, "#/operations/0/afterRevision");
  expectInvalid(sameReplacement, "#/operations/0/replacementId");
  expectInvalid(badBase, "#/baseRevision");
  expectInvalid(badRecordedAt, "#/recordedAt");
  expectInvalid(badProvenanceTime, "#/provenance/recordedAt");
  expectInvalid(badUtcYear, "#/recordedAt");
  assert.equal(validateChangeSet(offsetTime), offsetTime);
});
