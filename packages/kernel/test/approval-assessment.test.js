import assert from "node:assert/strict";
import test from "node:test";
import { assessApprovals } from "../src/approval-assessment.js";

const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const revision = `sha256:${"a".repeat(64)}`;
const at = "2026-09-09T12:00:00Z";
const grant = (overrides = {}) => ({
  format: "morivyx.approval/0.1", id: id(1), actor: id(2), targetId: id(3),
  targetRevision: revision, operation: "approve", scope: "single-revision",
  approvedAt: at, recordedAt: at, ...overrides,
});
const context = (overrides = {}) => ({
  targetId: id(3), targetRevision: revision, operation: "approve", scope: "single-revision",
  evaluatedAt: at, allowedActors: [id(2)], ...overrides,
});
const revoke = (overrides = {}) => grant({ id: id(4), operation: "revoke", revokes: id(1), ...overrides });

test("assesses exact matching approval without mutating inputs or asserting authenticity", () => {
  const records = [grant()], request = context(), before = structuredClone([records, request]);
  const result = assessApprovals(records, request);
  assert.equal(result.applicable, true);
  assert.deepEqual(result.approvals, [{ approvalId: id(1), actor: id(2) }]);
  assert.deepEqual(result.evaluations, [{ approvalId: id(1), actor: id(2), reason: "applicable" }]);
  assert.equal(result.targetRevision, revision);
  assert.equal(result.authenticity, "not-verified");
  assert.equal(result.persisted, false);
  assert.deepEqual([records, request], before);
  result.approvals[0].actor = id(99);
  assert.deepEqual([records, request], before);
});

test("empty records and empty actor allowlist grant nothing", () => {
  assert.equal(assessApprovals([], context()).applicable, false);
  assert.equal(assessApprovals([grant()], context({ allowedActors: [] })).applicable, false);
});

test("returns precise mismatch and time reasons", async t => {
  for (const [name, changed, expected] of [
    ["target ID", { targetId: id(8) }, "target-mismatch"],
    ["target revision", { targetRevision: `sha256:${"b".repeat(64)}` }, "target-mismatch"],
    ["operation", { operation: "execute" }, "operation-mismatch"],
    ["scope", { scope: "whole-graph" }, "scope-mismatch"],
    ["actor", { actor: id(8) }, "actor-not-allowed"],
    ["future grant", { approvedAt: "2026-09-09T12:00:01Z", recordedAt: "2026-09-09T12:00:01Z" }, "not-yet-effective"],
    ["future recording", { recordedAt: "2026-09-09T12:00:01Z" }, "not-yet-effective"],
    ["exact expiry", { approvedAt: "2026-09-09T11:00:00Z", expiresAt: at }, "expired"],
    ["past expiry", { approvedAt: "2026-09-09T11:00:00Z", expiresAt: "2026-09-09T11:59:59Z" }, "expired"],
  ]) await t.test(name, () => {
    const result = assessApprovals([grant(changed)], context());
    assert.equal(result.applicable, false);
    assert.equal(result.evaluations[0].reason, expected);
  });
});

test("compares offset timestamps and arbitrary fractional precision without rounding", () => {
  const approvedAt = "2026-09-09T21:00:00.123456789000000001+09:00";
  const expiresAt = "2026-09-09T12:00:00.123456789000000003Z";
  const records = [grant({ approvedAt, recordedAt: approvedAt, expiresAt })];
  assert.equal(assessApprovals(records, context({ evaluatedAt: "2026-09-09T12:00:00.123456789000000000Z" })).applicable, false);
  assert.equal(assessApprovals(records, context({ evaluatedAt: "2026-09-09T12:00:00.123456789000000001Z" })).applicable, true);
  assert.equal(assessApprovals(records, context({ evaluatedAt: "2026-09-09T12:00:00.123456789000000002Z" })).applicable, true);
  assert.equal(assessApprovals(records, context({ evaluatedAt: expiresAt })).applicable, false);
  assert.equal(assessApprovals([grant()], context({ evaluatedAt: "2026-09-09T21:00:00.000+09:00" })).applicable, true);
});

test("withdraws only effective revocations and never resurrects expired withdrawals", () => {
  assert.equal(assessApprovals([grant(), revoke()], context()).evaluations[0].reason, "revoked");
  assert.equal(assessApprovals([grant(), revoke({ actor: id(8) })], context()).applicable, false);
  const future = "2026-09-09T12:00:01Z";
  assert.equal(assessApprovals([grant(), revoke({ approvedAt: future, recordedAt: future })], context()).applicable, true);
  assert.equal(assessApprovals([grant(), revoke({ recordedAt: future })], context()).applicable, true);
  assert.equal(assessApprovals([grant(), revoke({ expiresAt: future })],
    context({ evaluatedAt: "2026-09-09T12:00:02Z" })).applicable, false);
});

test("a revoked grant does not invalidate a different active grant", () => {
  const result = assessApprovals([grant(), grant({ id: id(5) }), revoke()], context());
  assert.equal(result.applicable, true);
  assert.deepEqual(result.approvals, [{ approvalId: id(5), actor: id(2) }]);
});

test("rejects malformed context and non-data properties", async t => {
  for (const bad of [null, [], {}, context({ allowedActors: null }), context({ allowedActors: [id(2), id(2)] }),
    context({ allowedActors: ["unknown"] }), context({ operation: "revoke" }), context({ extra: true }),
    context({ evaluatedAt: "2026-02-30T12:00:00Z" }), context({ evaluatedAt: "tomorrow" }),
    context({ targetRevision: "unbound" })]) await t.test("invalid context", () => {
      assert.throws(() => assessApprovals([grant()], bad));
    });
  let invoked = false;
  assert.throws(() => assessApprovals([grant()], { get targetId() { invoked = true; return id(3); } }),
    { code: "APPROVAL_ASSESSMENT_INVALID" });
  assert.equal(invoked, false);
});

test("rejects inconsistent chronology and invalid revocation ledger", async t => {
  for (const records of [
    [grant({ recordedAt: "2026-09-09T11:59:59Z" })],
    [grant({ expiresAt: at })],
    [grant(), revoke({ scope: "different-scope" })],
    [grant(), revoke({ approvedAt: "2026-09-09T11:59:59Z" })],
    [revoke()],
    [grant(), revoke({ targetId: id(7) })],
    [grant(), grant()],
    null,
  ]) await t.test("invalid ledger", () => assert.throws(() => assessApprovals(records, context())));
});
