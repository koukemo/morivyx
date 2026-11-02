import { canonicalJson, graphRootDigest, revisionId } from "./canonical.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { importAdapter } from "./import-adapters.js";
import { restoreImportBaseline } from "./import-baseline.js";
import { compareImportTimes, hasRecordedImportRun, importFollowsObservations } from "./import-snapshot-record.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { writeAppliedPackage } from "./package-writer.js";
import { getDeclaredPluginCapability } from "./plugin-manifest.js";

export const IMPORT_AVAILABILITY_FORMAT = "morivyx.import-availability/0.1";
export const IMPORT_AVAILABILITY_EXTENSION = "morivyx.import/availability";
const ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRAPH = /^graph:\S+$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEYS = ["format", "artifactId", "observationId", "relationId", "changeSetId", "actor", "baseRevision",
  "baseRootDigest", "baselineArtifactRevision", "resultingRevision", "observedAt", "recordedAt", "manifest", "runRequest", "runResult"];
function fail(code) {
  throw new PackageError(`IMPORT_AVAILABILITY_${code}`, "/availability", "外部状態の記録条件を確認できません。");
}
function check(value, code) { if (!value) fail(code); }
function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }

export function validateImportAvailabilityRequest(input) {
  try {
    check(Buffer.byteLength(canonicalJson(input)) <= 1048576, "INPUT_LIMIT");
    check(input && Object.keys(input).length === KEYS.length && KEYS.every(key => Object.hasOwn(input, key)), "REQUEST_INVALID");
    const ids = [input.artifactId, input.observationId, input.relationId, input.changeSetId, input.actor];
    check(input.format === IMPORT_AVAILABILITY_FORMAT && ids.every(value => matches(value, ID)) &&
      new Set(ids).size === 5 && matches(input.baseRevision, GRAPH) && matches(input.resultingRevision, GRAPH) &&
      input.baseRevision !== input.resultingRevision && matches(input.baseRootDigest, DIGEST) &&
      matches(input.baselineArtifactRevision, DIGEST) && matches(input.observedAt, TIME) && matches(input.recordedAt, TIME) &&
      compareImportTimes(input.recordedAt, input.observedAt) >= 0, "REQUEST_INVALID");
    const result = input.runResult; const request = input.runRequest;
    const adapter = importAdapter(result);
    adapter.validateRequest(request); adapter.validateResult(result, request);
    const capability = getDeclaredPluginCapability(input.manifest, result.capabilityId);
    check(result.status === "failure" && input.manifest.identity.id === result.plugin.id &&
      input.manifest.identity.version === result.plugin.version && capability.effect === adapter.effect &&
      capability.inputFormat === adapter.inputFormat && capability.outputFormat === adapter.outputFormat, "REQUEST_INVALID");
  } catch (error) {
    if (error?.code === "IMPORT_AVAILABILITY_INPUT_LIMIT") throw error;
    fail("REQUEST_INVALID");
  }
  return input;
}

function baselineRequest(request) {
  const result = { format: "morivyx.import-snapshot-creation/0.1" };
  for (const key of ["artifactId", "changeSetId", "actor", "baseRevision", "baseRootDigest",
    "baselineArtifactRevision", "resultingRevision", "recordedAt", "manifest", "runRequest", "runResult"]) result[key] = request[key];
  return result;
}

export function prepareImportAvailability(base, input) {
  validateImportAvailabilityRequest(input);
  const request = structuredClone(input);
  check(base && Array.isArray(base.elements) && Array.isArray(base.changeSets), "PACKAGE_INVALID");
  check(base.revision?.id === request.baseRevision && base.revision.rootDigest === request.baseRootDigest, "BASE_MISMATCH");
  const ids = [request.observationId, request.relationId, request.changeSetId];
  check(!packageRecords(base).some(value => ids.includes(value?.id)), "ID_EXISTS");
  check(!hasRecordedImportRun(base, request.runResult), "RUN_ALREADY_RECORDED");
  const targets = base.elements.filter(value => value.id === request.artifactId);
  check(targets.length === 1 && targets[0].kind === "entity" && targets[0].type === "core.artifact", "TARGET_INVALID");
  const artifact = targets[0]; let baseline;
  try { baseline = restoreImportBaseline(base, baselineRequest(request)); }
  catch (error) { fail(error.code === "IMPORT_BASELINE_UNRECORDED" ? "BASELINE_UNRECORDED" : "BASELINE_INVALID"); }
  check(!base.changeSets.some(value => value.provenance?.importSnapshot && value.operations?.some(operation =>
    operation.op === "revise" && operation.targetId === artifact.id &&
      operation.beforeRevision === request.baselineArtifactRevision)), "BASELINE_SUPERSEDED");
  check(compareImportTimes(request.observedAt, baseline.saved.snapshot.retrievedAt) >= 0 &&
    compareImportTimes(request.observedAt, baseline.provenance.recordedAt) >= 0, "TIME_REGRESSION");
  try {
    check(importFollowsObservations(base, artifact.id, request.observedAt, request.recordedAt), "TIME_REGRESSION");
  } catch { fail("TIME_REGRESSION"); }
  const adapter = importAdapter(request.runResult);
  const comparison = adapter.compare({
    previousResult: baseline.previousResult, currentRequest: request.runRequest, currentResult: request.runResult });
  check(["missing", "unavailable"].includes(comparison.status), "COMPARISON_INVALID");
  const schema = base.schemaLock?.schemas?.find(value => value.schemaId === "morivyx.core");
  check(schema && typeof schema.version === "string", "SCHEMA_MISSING");
  const snapshot = baseline.saved.snapshot;
  const attemptedSource = adapter.system === "openapi"
    ? { system: "openapi", externalId: request.runRequest.input.externalId, path: request.runRequest.input.path,
      method: request.runRequest.input.method, documentDigest: comparison.current.documentDigest, digestRule: comparison.current.digestRule }
    : adapter.system === "figma"
    ? { system: "figma", apiOrigin: "https://api.figma.com", ...request.runRequest.input }
    : adapter.system === "github"
    ? { system: "github", apiOrigin: "https://api.github.com", ...request.runRequest.input }
    : { system: "repository", externalId: request.runRequest.input.externalId, locator: request.runRequest.input.locator };
  const record = {
    format: "morivyx.import-availability-record/0.1", status: comparison.status,
    artifactId: artifact.id, baselineArtifactRevision: request.baselineArtifactRevision,
    currentArtifactRevision: artifact.revision,
    localStatus: artifact.revision === request.baselineArtifactRevision ? "baseline" : "changed",
    externalIdentity: structuredClone(snapshot.externalIdentity), locator: snapshot.locator,
    attemptedSource, observedAt: request.observedAt, failureCode: comparison.current.failureCode,
    plugin: { ...request.runResult.plugin, packageDigest: request.manifest.identity.packageDigest },
    capabilityId: request.runResult.capabilityId, runId: request.runResult.runId,
    previousImportSnapshot: baseline.saved, executionBinding: "not-verified",
  };
  const provenance = { method: "imported", actor: request.actor, recordedAt: request.recordedAt };
  const shared = { format: "morivyx.git-graph/0.1", typeVersion: schema.version,
    lifecycle: "draft", reviewState: "unreviewed" };
  const observation = { ...shared, kind: "entity", id: request.observationId, type: "core.observation",
    attributes: { method: "plugin-read-attempt", observedAt: request.observedAt,
      value: { status: record.status, artifactId: artifact.id, baselineArtifactRevision: record.baselineArtifactRevision,
        currentArtifactRevision: artifact.revision, localStatus: record.localStatus, failureCode: record.failureCode } },
    provenance: { ...provenance }, extensions: { [IMPORT_AVAILABILITY_EXTENSION]: record } };
  observation.revision = revisionId(observation);
  const relation = { ...shared, kind: "relation", id: request.relationId, type: "core.observes",
    attributes: { predicate: "observes", source: observation.id, target: artifact.id }, provenance: { ...provenance } };
  relation.revision = revisionId(relation);
  const candidateElements = [observation, relation];
  const rootDigest = graphRootDigest([...base.elements, ...candidateElements]);
  const changeSet = {
    format: "morivyx.changeset/0.1", id: request.changeSetId, baseRevision: request.baseRevision,
    resultingRevision: request.resultingRevision, resultingRootDigest: rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
    operations: candidateElements.map(value => ({ op: "create", targetId: value.id, afterRevision: value.revision })),
    provenance: { ...provenance, importAvailability: structuredClone(record) }, recordedAt: request.recordedAt,
  };
  const resultingRevision = { format: "morivyx.graph-revision/0.1", id: request.resultingRevision,
    parentRevision: request.baseRevision, rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest };
  applyChangeSet({ changeSet, currentRevision: base.revision, currentElements: base.elements,
    schemaLockDigest: base.calculatedSchemaLockDigest, candidateElements, resultingRevision });
  return { comparison, candidateElements, changeSet, resultingRevision };
}

export async function writeImportAvailabilityPackage(input) {
  validateImportAvailabilityRequest(input?.request);
  const { basePath, outputPath } = input; const request = structuredClone(input.request);
  const base = await readGraphPackage(basePath);
  const prepared = prepareImportAvailability(base, request);
  const result = await writeAppliedPackage({ basePath, outputPath, changeSet: prepared.changeSet,
    candidateElements: prepared.candidateElements, resultingRevision: prepared.resultingRevision });
  return { ...result, observationId: request.observationId, relationId: request.relationId, status: prepared.comparison.status };
}
