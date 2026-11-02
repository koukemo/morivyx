import { canonicalJson } from "./canonical.js";
import {
  GITHUB_API_ORIGIN,
  validateGitHubImportRequest,
  validateGitHubImportResult,
} from "./github-importer.js";

export const GITHUB_IMPORT_COMPARISON_FORMAT = "morivyx.github-import-comparison/0.1";
export const GITHUB_REIMPORT_ASSESSMENT_FORMAT = "morivyx.github-reimport-assessment/0.1";

const COMPARISON_KEYS = ["previousResult", "currentRequest", "currentResult"];
const UNAVAILABLE_CODES = new Set([
  "GITHUB_IMPORT_SOURCE_UNAVAILABLE", "GITHUB_IMPORT_FAILED", "GITHUB_IMPORT_TIMEOUT",
  "GITHUB_IMPORT_RESPONSE_LIMIT", "GITHUB_IMPORT_REQUEST_LIMIT", "GITHUB_IMPORT_FILE_LIMIT",
]);
const INVALID_CODES = new Set([
  "GITHUB_IMPORT_REQUEST_INVALID", "GITHUB_IMPORT_RESULT_INVALID", "GITHUB_IMPORT_RESULT_MISMATCH",
  "GITHUB_IMPORT_PERMISSION_DENIED", "GITHUB_IMPORT_LIMITS_INVALID", "GITHUB_IMPORT_OPTIONS_INVALID",
  "GITHUB_IMPORT_RESPONSE_INVALID", "GITHUB_IMPORT_REDIRECT_DENIED", "GITHUB_IMPORT_IDENTITY_MISMATCH",
  "GITHUB_IMPORT_TREE_INVALID", "GITHUB_IMPORT_KIND_UNSUPPORTED", "GITHUB_IMPORT_BLOB_INVALID",
  "GITHUB_IMPORT_DIGEST_MISMATCH",
]);

function logicalRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try { canonicalJson(value); return true; } catch { return false; }
}

function exactKeys(value, keys) {
  return logicalRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function descriptor(output) {
  return {
    source: { ...output.source },
    digest: output.digest,
    digestRule: output.digestRule,
    byteLength: output.byteLength,
    retrievedAt: output.retrievedAt,
  };
}

function comparison(status, issue = null, previous = null, current = null) {
  return {
    format: GITHUB_IMPORT_COMPARISON_FORMAT,
    externalIdentity: previous === null ? null : { ...previous.externalIdentity },
    locator: previous?.locator ?? null,
    previous: previous === null ? null : descriptor(previous),
    current,
    status,
    issues: issue === null ? [] : [{ code: issue }],
  };
}

function failedCurrent(result, request) {
  const code = result.failure.code;
  const status = code === "GITHUB_IMPORT_TARGET_MISSING" ? "missing" :
    UNAVAILABLE_CODES.has(code) ? "unavailable" : "invalid";
  return {
    status,
    source: {
      apiOrigin: GITHUB_API_ORIGIN,
      owner: request.input.owner,
      repository: request.input.repository,
      commit: request.input.commit,
    },
    failureCode: status !== "invalid" || INVALID_CODES.has(code)
      ? code : "GITHUB_REIMPORT_UNRECOGNIZED_FAILURE",
  };
}

export function compareGitHubImportSnapshots(input) {
  if (!exactKeys(input, COMPARISON_KEYS)) {
    return comparison("invalid", "GITHUB_REIMPORT_INPUT_INVALID");
  }
  const { previousResult, currentRequest, currentResult } = input;
  try {
    validateGitHubImportResult(previousResult);
    if (previousResult.status !== "success") {
      return comparison("invalid", "GITHUB_REIMPORT_PREVIOUS_INVALID");
    }
  } catch {
    return comparison("invalid", "GITHUB_REIMPORT_PREVIOUS_INVALID");
  }
  const previous = previousResult.output;
  try {
    validateGitHubImportRequest(currentRequest);
    validateGitHubImportResult(currentResult, currentRequest);
  } catch {
    return comparison("invalid", "GITHUB_REIMPORT_CURRENT_INVALID", previous);
  }
  if (previous.externalIdentity.repositoryId !== currentRequest.input.repositoryId ||
      previous.locator !== currentRequest.input.locator) {
    return comparison("invalid", "GITHUB_REIMPORT_IDENTITY_MISMATCH", previous);
  }
  if (currentResult.status === "failure") {
    const current = failedCurrent(currentResult, currentRequest);
    if (current.status === "missing" && previous.source.commit === currentRequest.input.commit) {
      return comparison("invalid", "GITHUB_REIMPORT_SNAPSHOT_CONTRADICTION", previous, current);
    }
    const issue = current.status === "missing" ? "GITHUB_REIMPORT_TARGET_MISSING" :
      current.status === "unavailable" ? "GITHUB_REIMPORT_SOURCE_UNAVAILABLE" : "GITHUB_REIMPORT_CURRENT_INVALID";
    return comparison(current.status, issue, previous, current);
  }
  const output = currentResult.output;
  const current = { status: "resolved", ...descriptor(output) };
  const digestEqual = previous.digest === output.digest;
  const blobEqual = previous.source.blobSha === output.source.blobSha;
  const sizeEqual = previous.byteLength === output.byteLength;
  const modeEqual = previous.source.mode === output.source.mode;
  if (digestEqual !== blobEqual || (digestEqual && !sizeEqual) ||
      (previous.source.commit === output.source.commit && (!digestEqual || !modeEqual))) {
    return comparison("invalid", "GITHUB_REIMPORT_SNAPSHOT_CONTRADICTION", previous, current);
  }
  if (!digestEqual || !modeEqual) {
    return comparison("stale", "GITHUB_REIMPORT_FILE_CHANGED", previous, current);
  }
  return comparison("current", null, previous, current);
}

function target(value, allowDeletion = false) {
  if (!exactKeys(value, ["id", "revision"]) || typeof value.id !== "string" || value.id.length === 0 ||
      !(typeof value.revision === "string" && value.revision.length > 0 ||
        allowDeletion && value.revision === null)) return null;
  return { id: value.id, revision: value.revision };
}

function assessment(comparison, baselineTarget, currentTarget, localStatus, status, issue) {
  return {
    format: GITHUB_REIMPORT_ASSESSMENT_FORMAT,
    comparison,
    baselineTarget,
    currentTarget,
    localStatus,
    status,
    issues: issue === null ? [] : [{ code: issue }],
  };
}

const CLASSIFICATIONS = {
  current: {
    baseline: ["unchanged", null],
    changed: ["local-changed", "GITHUB_REIMPORT_LOCAL_CHANGED"],
    deleted: ["local-deleted", "GITHUB_REIMPORT_LOCAL_DELETED"],
  },
  stale: {
    baseline: ["external-changed", "GITHUB_REIMPORT_EXTERNAL_CHANGED"],
    changed: ["conflict", "GITHUB_REIMPORT_CONFLICT"],
    deleted: ["delete-conflict", "GITHUB_REIMPORT_DELETE_CONFLICT"],
  },
  missing: {
    baseline: ["external-missing", "GITHUB_REIMPORT_EXTERNAL_MISSING"],
    changed: ["missing-conflict", "GITHUB_REIMPORT_MISSING_CONFLICT"],
    deleted: ["both-missing", "GITHUB_REIMPORT_BOTH_MISSING"],
  },
};

export function assessGitHubReimport(input) {
  if (!exactKeys(input, [...COMPARISON_KEYS, "baselineTarget", "currentTarget"])) {
    return assessment(comparison("invalid", "GITHUB_REIMPORT_INPUT_INVALID"), null, null, null,
      "blocked-invalid", "GITHUB_REIMPORT_ASSESSMENT_INPUT_INVALID");
  }
  // Recompute from validated request/results rather than trusting a supplied status.
  const compared = compareGitHubImportSnapshots({ previousResult: input.previousResult,
    currentRequest: input.currentRequest, currentResult: input.currentResult });
  const baseline = target(input.baselineTarget);
  const current = target(input.currentTarget, true);
  if (baseline === null || current === null) {
    return assessment(compared, baseline, current, null, "blocked-invalid", "GITHUB_REIMPORT_TARGET_STATE_INVALID");
  }
  if (baseline.id !== current.id) {
    return assessment(compared, baseline, current, null, "blocked-invalid", "GITHUB_REIMPORT_TARGET_ID_MISMATCH");
  }
  const localStatus = current.revision === null ? "deleted" :
    baseline.revision === current.revision ? "baseline" : "changed";
  if (compared.status === "invalid" || compared.status === "unavailable") {
    return assessment(compared, baseline, current, localStatus,
      compared.status === "invalid" ? "blocked-invalid" : "blocked-unavailable",
      compared.status === "invalid" ? "GITHUB_REIMPORT_EXTERNAL_INVALID" : "GITHUB_REIMPORT_SOURCE_UNAVAILABLE");
  }
  const [status, issue] = CLASSIFICATIONS[compared.status][localStatus];
  return assessment(compared, baseline, current, localStatus, status, issue);
}
