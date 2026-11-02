import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { compareImportTimes } from "./import-snapshot-record.js";
import { importOpenApiOperation, validateOpenApiImportRequest, validateOpenApiImportResult } from "./openapi-importer.js";

export const OPENAPI_IMPORT_COMPARISON_FORMAT = "morivyx.openapi-import-comparison/0.1";
function descriptor(snapshot) {
  return { digest: snapshot.digest, digestRule: snapshot.digestRule, retrievedAt: snapshot.retrievedAt };
}
function report(status, codes, previous = null, current = null) {
  return { format: OPENAPI_IMPORT_COMPARISON_FORMAT,
    externalIdentity: previous ? { ...previous.externalIdentity } : null, locator: previous?.locator ?? null,
    previous: previous ? descriptor(previous) : null, current, status,
    issues: codes.map(code => ({ code: `OPENAPI_REIMPORT_${code}` })) };
}

export function compareOpenApiImportSnapshots(input) {
  try {
    if (Buffer.byteLength(canonicalJson(input)) > 2097152 || !input ||
      Object.keys(input).length !== 3 || !["previousResult", "currentRequest", "currentResult"].every(key => Object.hasOwn(input, key))) {
      return report("invalid", ["INPUT_INVALID"]);
    }
  } catch { return report("invalid", ["INPUT_INVALID"]); }
  const { previousResult, currentRequest, currentResult } = input;
  try {
    validateOpenApiImportResult(previousResult);
    if (previousResult.status !== "success") return report("invalid", ["PREVIOUS_INVALID"]);
  } catch { return report("invalid", ["PREVIOUS_INVALID"]); }
  const previous = previousResult.output;
  try { validateOpenApiImportRequest(currentRequest); validateOpenApiImportResult(currentResult, currentRequest); }
  catch { return report("invalid", ["CURRENT_INVALID"], previous); }
  if (previous.externalIdentity.externalId !== currentRequest.input.externalId ||
    previous.operation.path !== currentRequest.input.path || previous.operation.method !== currentRequest.input.method) {
    return report("invalid", ["IDENTITY_MISMATCH"], previous);
  }
  if (currentResult.status === "failure") {
    if (currentResult.failure.code !== "OPENAPI_IMPORT_TARGET_MISSING") return report("invalid", ["FAILURE_UNSUPPORTED"], previous);
    const recomputed = importOpenApiOperation(currentRequest, { now: () => previous.retrievedAt });
    if (recomputed.status !== "failure" || recomputed.failure.code !== "OPENAPI_IMPORT_TARGET_MISSING") {
      return report("invalid", ["CURRENT_NOT_MISSING"], previous);
    }
    return report("missing", [], previous, { status: "missing", failureCode: "OPENAPI_IMPORT_TARGET_MISSING",
      documentDigest: `sha256:${createHash("sha256").update(currentRequest.input.documentText, "utf8").digest("hex")}`,
      digestRule: "sha256-utf8-document" });
  }
  const snapshot = currentResult.output; const current = { status: "resolved", ...descriptor(snapshot) };
  if (compareImportTimes(snapshot.retrievedAt, previous.retrievedAt) < 0) return report("invalid", ["TIME_REGRESSION"], previous, current);
  if (snapshot.digest !== previous.digest) return report("stale", [], previous, current);
  const { retrievedAt: previousTime, ...before } = previous;
  const { retrievedAt: currentTime, ...after } = snapshot;
  if (canonicalJson(before) !== canonicalJson(after)) return report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current);
  return report("current", [], previous, current);
}
