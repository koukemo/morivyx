import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";
import { importAdapter } from "./import-adapters.js";
import { IMPORT_SNAPSHOT_CREATION_FORMAT, validateImportSnapshotCreationRequest } from "./import-snapshot-creation.js";
import { compareImportTimes, describeImportSnapshot } from "./import-snapshot-record.js";
import { getDeclaredPluginCapability } from "./plugin-manifest.js";

function fail(code) {
  throw new PackageError(`IMPORT_BASELINE_${code}`, "/baseline", "以前の取込記録を確認できません。");
}

// Internal: request contains creation authoring fields and baselineArtifactRevision.
export function restoreImportBaseline(base, request) {
  const matches = base.changeSets.filter(record => record.provenance?.importSnapshot &&
    Array.isArray(record.operations) && record.operations.some(operation => ["create", "revise"].includes(operation.op) &&
      operation.targetId === request.artifactId && operation.afterRevision === request.baselineArtifactRevision));
  if (matches.length !== 1) fail("UNRECORDED");
  const ledger = matches[0]; const saved = ledger.provenance.importSnapshot;
  try {
    const previousResult = {
      format: "morivyx.plugin-run-result/0.1", runId: saved.runId,
      plugin: { id: saved.plugin.id, version: saved.plugin.version },
      capabilityId: saved.capabilityId, status: "success", output: structuredClone(saved.snapshot),
    };
    if (saved.plugin.id !== request.runResult.plugin.id || saved.capabilityId !== request.runResult.capabilityId) fail("INVALID");
    if (["openapi", "figma"].includes(saved.snapshot.externalIdentity.system)) {
      // No old document or old RunRequest is synthesized: only persisted snapshot metadata can be checked.
      const adapter = importAdapter(previousResult);
      adapter.validateResult(previousResult);
      const manifest = structuredClone(request.manifest); Object.assign(manifest.identity, saved.plugin);
      const capability = getDeclaredPluginCapability(manifest, saved.capabilityId);
      if (capability.effect !== adapter.effect || capability.inputFormat !== adapter.inputFormat ||
        capability.outputFormat !== adapter.outputFormat ||
        typeof ledger.provenance.actor !== "string" ||
        !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ledger.provenance.actor) ||
        [request.artifactId, request.changeSetId].includes(ledger.provenance.actor) ||
        typeof ledger.provenance.recordedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(ledger.provenance.recordedAt) ||
        compareImportTimes(ledger.provenance.recordedAt, saved.snapshot.retrievedAt) < 0) fail("INVALID");
      const described = describeImportSnapshot({ manifest, runResult: previousResult });
      if (canonicalJson(saved) !== canonicalJson(described.record) || ledger.provenance.method !== "imported") fail("INVALID");
      return { previousResult, saved: structuredClone(saved), uri: described.uri, externalVersion: described.externalVersion,
        artifactKind: described.artifactKind, provenance: structuredClone(ledger.provenance) };
    }
    const { baselineArtifactRevision, ...previous } = structuredClone(request);
    previous.format = IMPORT_SNAPSHOT_CREATION_FORMAT;
    previous.recordedAt = ledger.provenance.recordedAt;
    previous.actor = ledger.provenance.actor;
    previous.runResult = previousResult;
    Object.assign(previous.manifest.identity, saved.plugin);
    previous.runRequest.runId = saved.runId;
    previous.runRequest.plugin = { ...previousResult.plugin };
    const snapshot = saved.snapshot;
    if (snapshot.externalIdentity.system === "github") {
      previous.runRequest.input = { owner: snapshot.source.owner, repository: snapshot.source.repository,
        repositoryId: snapshot.externalIdentity.repositoryId, commit: snapshot.source.commit, locator: snapshot.locator };
    } else {
      previous.runRequest.input.externalId = snapshot.externalIdentity.externalId;
      previous.runRequest.input.locator = snapshot.locator;
    }
    validateImportSnapshotCreationRequest(previous);
    const described = describeImportSnapshot(previous);
    if (canonicalJson(saved) !== canonicalJson(described.record) || ledger.provenance.method !== "imported") fail("INVALID");
    return { previousResult, saved: structuredClone(saved), uri: described.uri,
      externalVersion: described.externalVersion, artifactKind: described.artifactKind, provenance: structuredClone(ledger.provenance) };
  } catch { fail("INVALID"); }
}
