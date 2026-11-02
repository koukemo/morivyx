import { canonicalJson } from "./canonical.js";
import { validateFigmaImportRequest, validateFigmaImportResult } from "./figma-importer.js";
import { compareImportTimes } from "./import-snapshot-record.js";

export const FIGMA_IMPORT_COMPARISON_FORMAT = "morivyx.figma-import-comparison/0.1";
function descriptor(snapshot) {
  return { version: snapshot.source.version, digest: snapshot.digest, digestRule: snapshot.digestRule, retrievedAt: snapshot.retrievedAt };
}
function report(status, codes, previous = null, current = null) {
  return { format: FIGMA_IMPORT_COMPARISON_FORMAT, externalIdentity: previous ? { ...previous.externalIdentity } : null,
    locator: previous?.locator ?? null, previous: previous ? descriptor(previous) : null, current, status,
    issues: codes.map(code => ({ code: `FIGMA_REIMPORT_${code}` })) };
}
export function compareFigmaImportSnapshots(input) {
  try {
    if (Buffer.byteLength(canonicalJson(input)) > 2097152 || !input || Object.keys(input).length !== 3 ||
      !["previousResult", "currentRequest", "currentResult"].every(key => Object.hasOwn(input, key))) return report("invalid", ["INPUT_INVALID"]);
  } catch { return report("invalid", ["INPUT_INVALID"]); }
  const { previousResult, currentRequest, currentResult } = input;
  try {
    validateFigmaImportResult(previousResult);
    if (previousResult.status !== "success") return report("invalid", ["PREVIOUS_INVALID"]);
  } catch { return report("invalid", ["PREVIOUS_INVALID"]); }
  const previous = previousResult.output;
  try { validateFigmaImportRequest(currentRequest); validateFigmaImportResult(currentResult, currentRequest); }
  catch { return report("invalid", ["CURRENT_INVALID"], previous); }
  if (previous.externalIdentity.fileKey !== currentRequest.input.fileKey || previous.locator !== currentRequest.input.nodeId)
    return report("invalid", ["IDENTITY_MISMATCH"], previous);
  const sameVersion = previous.source.version === currentRequest.input.version;
  if (currentResult.status === "failure") {
    const code = currentResult.failure.code;
    if (!["FIGMA_IMPORT_TARGET_MISSING", "FIGMA_IMPORT_SOURCE_UNAVAILABLE", "FIGMA_IMPORT_TIMEOUT"].includes(code))
      return report("invalid", ["FAILURE_UNSUPPORTED"], previous);
    const status = code === "FIGMA_IMPORT_TARGET_MISSING" ? "missing" : "unavailable";
    const current = { status, failureCode: code, requestedVersion: currentRequest.input.version };
    if (status === "missing" && sameVersion) return report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current);
    return report(status, [], previous, current);
  }
  const snapshot = currentResult.output; const current = { status: "resolved", ...descriptor(snapshot) };
  if (compareImportTimes(snapshot.retrievedAt, previous.retrievedAt) < 0) return report("invalid", ["TIME_REGRESSION"], previous, current);
  if ((sameVersion && snapshot.digest !== previous.digest) ||
    (snapshot.digest === previous.digest && canonicalJson(snapshot.node) !== canonicalJson(previous.node)))
    return report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current);
  return report(snapshot.digest === previous.digest ? "current" : "stale", [], previous, current);
}
