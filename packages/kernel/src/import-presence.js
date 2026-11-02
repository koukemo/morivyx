import { canonicalJson, graphRootDigest, revisionId } from "./canonical.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { importAdapter } from "./import-adapters.js";
import { restoreImportBaseline } from "./import-baseline.js";
import { validateImportSnapshotCreationRequest } from "./import-snapshot-creation.js";
import { compareImportTimes, describeImportSnapshot, hasRecordedImportRun, importFollowsObservations } from "./import-snapshot-record.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { writeAppliedPackage } from "./package-writer.js";

export const IMPORT_PRESENCE_FORMAT = "morivyx.import-presence/0.1";
export const IMPORT_PRESENCE_EXTENSION = "morivyx.import/presence";
const ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEYS = ["format", "artifactId", "observationId", "relationId", "changeSetId", "actor", "baseRevision",
  "baseRootDigest", "baselineArtifactRevision", "resultingRevision", "observedAt", "recordedAt", "manifest", "runRequest", "runResult"];
function fail(code) { throw new PackageError(`IMPORT_PRESENCE_${code}`, "/presence", "取得成功の記録条件を確認できません。"); }
function check(value, code) { if (!value) fail(code); }
function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }
function creationInput(request) {
  const { observationId, relationId, baselineArtifactRevision, observedAt, ...result } = request;
  result.format = "morivyx.import-snapshot-creation/0.1"; return result;
}

export function validateImportPresenceRequest(input) {
  try {
    check(Buffer.byteLength(canonicalJson(input)) <= 1048576, "INPUT_LIMIT");
    check(input && Object.keys(input).length === KEYS.length && KEYS.every(key => Object.hasOwn(input, key)), "REQUEST_INVALID");
    const ids = [input.artifactId, input.observationId, input.relationId, input.changeSetId, input.actor];
    check(input.format === IMPORT_PRESENCE_FORMAT && ids.every(value => matches(value, ID)) && new Set(ids).size === 5 &&
      matches(input.baselineArtifactRevision, DIGEST) && matches(input.observedAt, TIME), "REQUEST_INVALID");
    validateImportSnapshotCreationRequest(creationInput(input));
    check(compareImportTimes(input.observedAt, input.runResult.output.retrievedAt) >= 0 &&
      compareImportTimes(input.recordedAt, input.observedAt) >= 0, "REQUEST_INVALID");
  } catch (error) {
    if (error?.code === "IMPORT_PRESENCE_INPUT_LIMIT") throw error;
    fail("REQUEST_INVALID");
  }
  return input;
}

export function prepareImportPresence(base, input) {
  validateImportPresenceRequest(input); const request = structuredClone(input);
  check(base && Array.isArray(base.elements) && Array.isArray(base.changeSets), "PACKAGE_INVALID");
  check(base.revision?.id === request.baseRevision && base.revision.rootDigest === request.baseRootDigest, "BASE_MISMATCH");
  const ids = [request.observationId, request.relationId, request.changeSetId];
  check(!packageRecords(base).some(value => ids.includes(value?.id)), "ID_EXISTS");
  check(!hasRecordedImportRun(base, request.runResult), "RUN_ALREADY_RECORDED");
  const targets = base.elements.filter(value => value.id === request.artifactId);
  check(targets.length === 1 && targets[0].kind === "entity" && targets[0].type === "core.artifact", "TARGET_INVALID");
  const artifact = targets[0]; let baseline;
  try { baseline = restoreImportBaseline(base, { ...creationInput(request), baselineArtifactRevision: request.baselineArtifactRevision }); }
  catch (error) { fail(error.code === "IMPORT_BASELINE_UNRECORDED" ? "BASELINE_UNRECORDED" : "BASELINE_INVALID"); }
  check(!base.changeSets.some(value => value.provenance?.importSnapshot && value.operations?.some(operation =>
    operation.op === "revise" && operation.targetId === artifact.id &&
      operation.beforeRevision === request.baselineArtifactRevision)), "BASELINE_SUPERSEDED");
  const retrievedAt = request.runResult.output.retrievedAt;
  try {
    check(compareImportTimes(retrievedAt, baseline.saved.snapshot.retrievedAt) >= 0 &&
      compareImportTimes(retrievedAt, baseline.provenance.recordedAt) >= 0 &&
      importFollowsObservations(base, artifact.id, retrievedAt, request.recordedAt), "TIME_REGRESSION");
  } catch { fail("TIME_REGRESSION"); }
  const comparison = importAdapter(request.runResult).compare({
    previousResult: baseline.previousResult, currentRequest: request.runRequest, currentResult: request.runResult });
  check(["current", "stale"].includes(comparison.status), "COMPARISON_INVALID");
  const schema = base.schemaLock?.schemas?.find(value => value.schemaId === "morivyx.core");
  check(schema && typeof schema.version === "string", "SCHEMA_MISSING");
  const imported = describeImportSnapshot(request).record;
  const record = { format: "morivyx.import-presence-record/0.1", status: "available", comparison: comparison.status,
    artifactId: artifact.id, baselineArtifactRevision: request.baselineArtifactRevision, currentArtifactRevision: artifact.revision,
    localStatus: artifact.revision === request.baselineArtifactRevision ? "baseline" : "changed",
    externalIdentity: structuredClone(imported.snapshot.externalIdentity), locator: imported.snapshot.locator,
    observedAt: request.observedAt, plugin: structuredClone(imported.plugin), capabilityId: imported.capabilityId, runId: imported.runId,
    previousImportSnapshot: baseline.saved, currentImportSnapshot: imported, executionBinding: "not-verified" };
  const provenance = { method: "imported", actor: request.actor, recordedAt: request.recordedAt };
  const shared = { format: "morivyx.git-graph/0.1", typeVersion: schema.version, lifecycle: "draft", reviewState: "unreviewed" };
  const observation = { ...shared, kind: "entity", id: request.observationId, type: "core.observation",
    attributes: { method: "plugin-read-success", observedAt: request.observedAt,
      value: { status: record.status, comparison: record.comparison, artifactId: artifact.id,
        baselineArtifactRevision: record.baselineArtifactRevision, currentArtifactRevision: artifact.revision, localStatus: record.localStatus } },
    provenance: { ...provenance }, extensions: { [IMPORT_PRESENCE_EXTENSION]: record } };
  observation.revision = revisionId(observation);
  const relation = { ...shared, kind: "relation", id: request.relationId, type: "core.observes",
    attributes: { predicate: "observes", source: observation.id, target: artifact.id }, provenance: { ...provenance } };
  relation.revision = revisionId(relation);
  const candidateElements = [observation, relation]; const rootDigest = graphRootDigest([...base.elements, ...candidateElements]);
  const changeSet = { format: "morivyx.changeset/0.1", id: request.changeSetId, baseRevision: request.baseRevision,
    resultingRevision: request.resultingRevision, resultingRootDigest: rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
    operations: candidateElements.map(value => ({ op: "create", targetId: value.id, afterRevision: value.revision })),
    provenance: { ...provenance, importPresence: structuredClone(record) }, recordedAt: request.recordedAt };
  const resultingRevision = { format: "morivyx.graph-revision/0.1", id: request.resultingRevision,
    parentRevision: request.baseRevision, rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest };
  applyChangeSet({ changeSet, currentRevision: base.revision, currentElements: base.elements,
    schemaLockDigest: base.calculatedSchemaLockDigest, candidateElements, resultingRevision });
  return { comparison, candidateElements, changeSet, resultingRevision };
}

export async function writeImportPresencePackage(input) {
  validateImportPresenceRequest(input?.request);
  const { basePath, outputPath } = input; const request = structuredClone(input.request);
  const base = await readGraphPackage(basePath); const prepared = prepareImportPresence(base, request);
  const result = await writeAppliedPackage({ basePath, outputPath, changeSet: prepared.changeSet,
    candidateElements: prepared.candidateElements, resultingRevision: prepared.resultingRevision });
  return { ...result, observationId: request.observationId, relationId: request.relationId, status: "available", comparison: prepared.comparison.status };
}
