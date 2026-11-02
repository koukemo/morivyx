import { canonicalJson } from "./canonical.js";
import { validateApproval, validateApprovalLedger } from "./approval.js";
import { PackageError } from "./errors.js";

const CONTEXT_FIELDS = ["targetId", "targetRevision", "operation", "scope", "evaluatedAt", "allowedActors"];
const ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(path) {
  throw new PackageError("APPROVAL_ASSESSMENT_INVALID", path, "承認の評価条件または時刻の順序が不正です。");
}

function time(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) invalid("/time");
  let normalized;
  try { normalized = JSON.parse(canonicalJson(value)); } catch { invalid("/time"); }
  return { seconds: normalized.slice(0, 19), fraction: normalized.slice(19, -1).replace(/^\./, "") };
}

function compare(left, right) {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  const length = Math.max(left.fraction.length, right.fraction.length);
  const a = left.fraction.padEnd(length, "0"), b = right.fraction.padEnd(length, "0");
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Evaluate existing records; does not authenticate the actor or authorize a write. */
export function assessApprovals(approvals, context) {
  let records, request;
  try {
    canonicalJson(approvals);
    canonicalJson(context);
    records = structuredClone(approvals);
    request = structuredClone(context);
  } catch { invalid("/"); }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).length !== CONTEXT_FIELDS.length ||
      CONTEXT_FIELDS.some(field => !Object.hasOwn(request, field)) ||
      !Array.isArray(request.allowedActors) ||
      request.allowedActors.some(actor => typeof actor !== "string" || !ID.test(actor)) ||
      new Set(request.allowedActors).size !== request.allowedActors.length ||
      request.operation === "revoke") invalid("/context");
  // Use the existing target, operation, scope, and timestamp structural contract.
  validateApproval({
    format: "morivyx.approval/0.1", id: "urn:uuid:00000000-0000-4000-8000-000000000001",
    actor: "urn:uuid:00000000-0000-4000-8000-000000000001",
    targetId: request.targetId, targetRevision: request.targetRevision,
    operation: request.operation, scope: request.scope,
    approvedAt: request.evaluatedAt, recordedAt: request.evaluatedAt,
  });
  validateApprovalLedger(records);
  const now = time(request.evaluatedAt);
  const times = new Map(records.map(record => {
    const approved = time(record.approvedAt), recorded = time(record.recordedAt);
    const expires = Object.hasOwn(record, "expiresAt") ? time(record.expiresAt) : null;
    if (compare(approved, recorded) > 0 || (expires && compare(expires, approved) <= 0)) invalid("/approvals/time");
    return [record.id, { approved, recorded, expires }];
  }));
  const byId = new Map(records.map(record => [record.id, record]));
  const trusted = new Set(request.allowedActors);
  const revoked = new Set();
  for (const record of records.filter(value => value.operation === "revoke")) {
    const granted = byId.get(record.revokes);
    const at = times.get(record.id);
    if (record.scope !== granted.scope || compare(at.approved, times.get(granted.id).approved) < 0) {
      invalid("/approvals/revokes");
    }
    // An effective withdrawal stays effective; expiration never resurrects a grant.
    // Eligibility changes must not resurrect a recorded withdrawal.
    if (compare(at.approved, now) <= 0 && compare(at.recorded, now) <= 0) {
      revoked.add(record.revokes);
    }
  }
  const evaluations = records.filter(record => record.operation !== "revoke").map(record => {
    const at = times.get(record.id);
    let reason = "applicable";
    if (record.targetId !== request.targetId || record.targetRevision !== request.targetRevision) reason = "target-mismatch";
    else if (record.operation !== request.operation) reason = "operation-mismatch";
    else if (record.scope !== request.scope) reason = "scope-mismatch";
    else if (!trusted.has(record.actor)) reason = "actor-not-allowed";
    else if (compare(at.approved, now) > 0 || compare(at.recorded, now) > 0) reason = "not-yet-effective";
    else if (at.expires && compare(at.expires, now) <= 0) reason = "expired";
    else if (revoked.has(record.id)) reason = "revoked";
    return { approvalId: record.id, actor: record.actor, reason };
  });
  const applicable = evaluations.filter(value => value.reason === "applicable");
  return {
    applicable: applicable.length > 0,
    targetId: request.targetId, targetRevision: request.targetRevision,
    operation: request.operation, scope: request.scope, evaluatedAt: request.evaluatedAt,
    approvals: applicable.map(({ approvalId, actor }) => ({ approvalId, actor })),
    evaluations, authenticity: "not-verified", persisted: false,
  };
}
