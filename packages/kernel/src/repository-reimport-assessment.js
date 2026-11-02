import { canonicalJson } from "./canonical.js";

export const REPOSITORY_REIMPORT_ASSESSMENT_FORMAT =
  "morivyx.repository-reimport-assessment/0.1";

const EXTERNAL_STATUSES = new Set([
  "current",
  "stale",
  "missing",
  "unavailable",
  "invalid",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLogicalRecord(value) {
  try {
    if (!isRecord(value)) return false;
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function isText(value) {
  return typeof value === "string" && value.length > 0;
}

function targetDescriptor(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["id", "revision"].includes(key)) ||
    !isText(value.id) ||
    !isText(value.revision)
  ) {
    return null;
  }
  return { id: value.id, revision: value.revision };
}

function report({
  comparison,
  baselineTarget = null,
  currentTarget = null,
  localStatus = null,
  status,
  issue = null,
}) {
  return {
    format: REPOSITORY_REIMPORT_ASSESSMENT_FORMAT,
    externalStatus:
      isRecord(comparison) && EXTERNAL_STATUSES.has(comparison.status)
        ? comparison.status
        : null,
    baselineTarget,
    currentTarget,
    localStatus,
    status,
    issues: issue === null ? [] : [{ code: issue }],
  };
}

export function assessRepositoryReimport(input = {}) {
  if (!isLogicalRecord(input)) {
    return report({
      comparison: null,
      status: "blocked-invalid",
      issue: "REPOSITORY_REIMPORT_ASSESSMENT_INPUT_INVALID",
    });
  }
  const { comparison, baselineTarget, currentTarget } = input;
  if (
    !isRecord(comparison) ||
    comparison.format !== "morivyx.repository-import-comparison/0.1" ||
    !EXTERNAL_STATUSES.has(comparison.status)
  ) {
    return report({
      comparison,
      status: "blocked-invalid",
      issue: "REPOSITORY_REIMPORT_ASSESSMENT_INPUT_INVALID",
    });
  }

  const baseline = targetDescriptor(baselineTarget);
  const current = targetDescriptor(currentTarget);
  if (baseline === null || current === null) {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      status: "blocked-invalid",
      issue: "REPOSITORY_REIMPORT_TARGET_STATE_INVALID",
    });
  }
  if (baseline.id !== current.id) {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      status: "blocked-invalid",
      issue: "REPOSITORY_REIMPORT_TARGET_ID_MISMATCH",
    });
  }

  const localChanged = baseline.revision !== current.revision;
  const localStatus = localChanged ? "changed" : "baseline";

  if (comparison.status === "invalid") {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      localStatus,
      status: "blocked-invalid",
      issue: "REPOSITORY_REIMPORT_EXTERNAL_INVALID",
    });
  }
  if (comparison.status === "unavailable") {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      localStatus,
      status: "blocked-unavailable",
      issue: "REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE",
    });
  }
  if (comparison.status === "current") {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      localStatus,
      status: localChanged ? "local-changed" : "unchanged",
      issue: localChanged ? "REPOSITORY_REIMPORT_LOCAL_CHANGED" : null,
    });
  }
  if (comparison.status === "stale") {
    return report({
      comparison,
      baselineTarget: baseline,
      currentTarget: current,
      localStatus,
      status: localChanged ? "conflict" : "external-changed",
      issue: localChanged
        ? "REPOSITORY_REIMPORT_CONFLICT"
        : "REPOSITORY_REIMPORT_EXTERNAL_CHANGED",
    });
  }
  return report({
    comparison,
    baselineTarget: baseline,
    currentTarget: current,
    localStatus,
    status: localChanged ? "missing-conflict" : "external-missing",
    issue: localChanged
      ? "REPOSITORY_REIMPORT_MISSING_CONFLICT"
      : "REPOSITORY_REIMPORT_EXTERNAL_MISSING",
  });
}
