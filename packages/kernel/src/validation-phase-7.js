const LIFECYCLE_TRANSITIONS = new Map([
  [
    "core.criterion",
    new Set([
      "draft:active",
      "draft:retracted",
      "active:deprecated",
      "active:superseded",
      "active:retracted",
    ]),
  ],
  [
    "core.learning",
    new Set([
      "draft:active",
      "draft:retracted",
      "active:superseded",
      "active:retracted",
    ]),
  ],
]);
const PROVENANCE_FIELDS = ["method", "actor", "recordedAt"];
const APPROVAL_FIELDS = [
  "actor",
  "targetId",
  "targetRevision",
  "operation",
  "scope",
  "approvedAt",
  "recordedAt",
];

function issue(code, elementId, path, relatedId = "") {
  return { code, phase: 7, elementId, path, relatedId };
}

function text(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

function singleElementsById(elements) {
  const groups = new Map();
  for (const element of elements) {
    if (typeof element.id !== "string") {
      continue;
    }
    const id = text(element.id);
    const group = groups.get(id) ?? [];
    group.push(element);
    groups.set(id, group);
  }
  return new Map(
    Array.from(groups)
      .filter(([, group]) => group.length === 1)
      .map(([id, group]) => [id, group[0]]),
  );
}

function validateLifecycle(elements, previousElements) {
  const issues = [];
  const previousById = singleElementsById(previousElements);
  for (const element of elements) {
    const allowed = LIFECYCLE_TRANSITIONS.get(element.type);
    const previous = previousById.get(text(element.id));
    if (
      !allowed ||
      !previous ||
      previous.type !== element.type ||
      previous.lifecycle === element.lifecycle ||
      typeof previous.lifecycle !== "string" ||
      typeof element.lifecycle !== "string"
    ) {
      continue;
    }
    if (!allowed.has(`${previous.lifecycle}:${element.lifecycle}`)) {
      issues.push(
        issue("LIFECYCLE_TRANSITION", text(element.id), "/lifecycle"),
      );
    }
  }
  return issues;
}

function validateElementProvenance(elements) {
  const issues = [];
  for (const element of elements) {
    if (
      !element.provenance ||
      typeof element.provenance !== "object" ||
      Array.isArray(element.provenance)
    ) {
      issues.push(
        issue("PROVENANCE_REQUIRED", text(element.id), "/provenance"),
      );
      continue;
    }
    for (const field of PROVENANCE_FIELDS) {
      if (
        typeof element.provenance[field] !== "string" ||
        element.provenance[field].length === 0
      ) {
        issues.push(
          issue(
            "PROVENANCE_REQUIRED",
            text(element.id),
            `/provenance/${field}`,
          ),
        );
      }
    }
  }
  return issues;
}

function approvalMissingFields(approval) {
  return APPROVAL_FIELDS.filter(
    (field) =>
      typeof approval[field] !== "string" || approval[field].length === 0,
  );
}

function validateApprovalProvenance(approvals) {
  const issues = [];
  for (const approval of approvals) {
    for (const field of approvalMissingFields(approval)) {
      issues.push(
        issue(
          "PROVENANCE_REQUIRED",
          text(approval.targetId),
          `/approvals/${text(approval.id)}/${field}`,
          text(approval.id),
        ),
      );
    }
  }
  return issues;
}

function applicableApprovals(approvals) {
  const valid = approvals.filter(
    (approval) => approvalMissingFields(approval).length === 0,
  );
  const byId = new Map(valid.map((approval) => [text(approval.id), approval]));
  const revoked = new Set();
  for (const revocation of valid) {
    if (
      revocation.operation !== "revoke" ||
      typeof revocation.revokes !== "string"
    ) {
      continue;
    }
    const granted = byId.get(text(revocation.revokes));
    if (
      granted &&
      text(granted.targetId) === text(revocation.targetId) &&
      text(granted.targetRevision) === text(revocation.targetRevision)
    ) {
      revoked.add(text(granted.id));
    }
  }
  return valid.filter(
    (approval) =>
      !revoked.has(text(approval.id)) &&
      approval.operation === "approve" &&
      approval.scope === "single-revision",
  );
}

function applicableApprovalTargets(approvals) {
  const targets = new Map();
  for (const approval of applicableApprovals(approvals)) {
    const targetId = text(approval.targetId);
    const revisions = targets.get(targetId) ?? new Set();
    revisions.add(text(approval.targetRevision));
    targets.set(targetId, revisions);
  }
  return targets;
}

function validateRequiredApprovals(elements, approvals) {
  const issues = [];
  const applicable = applicableApprovalTargets(approvals);
  for (const element of elements) {
    if (element.reviewState !== "approved") {
      continue;
    }
    const found =
      applicable.get(text(element.id))?.has(text(element.revision)) === true;
    if (!found) {
      issues.push(issue("APPROVAL_REQUIRED", text(element.id), "/reviewState"));
    }
  }
  return issues;
}

export function validatePhase7(
  elements,
  { previousElements = [], approvals = [] } = {},
) {
  return [
    ...validateLifecycle(elements, previousElements),
    ...validateElementProvenance(elements),
    ...validateApprovalProvenance(approvals),
    ...validateRequiredApprovals(elements, approvals),
  ];
}
