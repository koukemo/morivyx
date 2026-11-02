import { canonicalJson } from "./canonical.js";

// Internal mapping shared by initial import and explicit reimport proposals.
// Callers validate the authoring request before using this pure mapping.
const REPOSITORY_LOSS = ["file-content-not-retained", "non-file-metadata-not-imported",
  "rename-history-not-tracked", "repository-commit-not-recorded"];

export function hasRecordedImportRun(base, result) {
  return base.changeSets.some(value => ["importSnapshot", "importAvailability", "importPresence"].some(key => {
    const recorded = value.provenance?.[key];
    return recorded?.plugin?.id === result.plugin.id &&
      recorded.plugin.version === result.plugin.version && recorded.runId === result.runId;
  }));
}

export function compareImportTimes(left, right) {
  const first = JSON.parse(canonicalJson(left)); const second = JSON.parse(canonicalJson(right));
  const firstSeconds = first.slice(0, 19); const secondSeconds = second.slice(0, 19);
  if (firstSeconds !== secondSeconds) return firstSeconds < secondSeconds ? -1 : 1;
  const a = first.slice(19, -1).replace(/^\./, ""); const b = second.slice(19, -1).replace(/^\./, "");
  const width = Math.max(a.length, b.length); const x = a.padEnd(width, "0"); const y = b.padEnd(width, "0");
  return x === y ? 0 : x < y ? -1 : 1;
}

export function importFollowsObservations(base, artifactId, observedAt, recordedAt) {
  return base.changeSets.every(value => ["importAvailability", "importPresence"].every(key => {
    const previous = value.provenance?.[key];
    return previous?.artifactId !== artifactId ||
      ([previous.observedAt, value.provenance.recordedAt].every(time => typeof time === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) &&
        compareImportTimes(observedAt, previous.observedAt) >= 0 &&
        compareImportTimes(recordedAt, value.provenance.recordedAt) >= 0);
  }));
}

export function describeImportSnapshot(request) {
  const result = request.runResult;
  const snapshot = structuredClone(result.output);
  const github = snapshot.externalIdentity.system === "github";
  const openapi = snapshot.externalIdentity.system === "openapi";
  const figma = snapshot.externalIdentity.system === "figma";
  const uri = figma
    ? `urn:morivyx:figma-node:${encodeURIComponent(snapshot.externalIdentity.fileKey)}:${encodeURIComponent(snapshot.locator)}`
    : github
    ? `https://github.com/${snapshot.source.owner}/${snapshot.source.repository}/blob/${snapshot.source.commit}/${snapshot.locator.split("/").map(encodeURIComponent).join("/")}`
    : `urn:morivyx:${openapi ? "openapi-operation" : "repository-file"}:${encodeURIComponent(snapshot.externalIdentity.externalId)}:${encodeURIComponent(snapshot.locator)}`;
  const record = {
    format: "morivyx.import-snapshot-record/0.1",
    plugin: { id: result.plugin.id, version: result.plugin.version,
      packageDigest: request.manifest.identity.packageDigest },
    runId: result.runId,
    capabilityId: result.capabilityId,
    snapshot,
    informationLoss: github || openapi || figma ? [...snapshot.informationLoss] : [...REPOSITORY_LOSS],
    executionBinding: "not-verified",
  };
  return { record, uri, externalVersion: figma ? snapshot.source.version : github ? snapshot.source.commit : snapshot.digest,
    artifactKind: figma ? "design-node" : openapi ? "api-operation" : "file" };
}
