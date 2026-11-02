import { canonicalJson, graphRootDigest, revisionId } from "./canonical.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { importAdapter } from "./import-adapters.js";
import { restoreImportBaseline } from "./import-baseline.js";
import { IMPORT_SNAPSHOT_CREATION_FORMAT, IMPORT_SNAPSHOT_EXTENSION,
  validateImportSnapshotCreationRequest } from "./import-snapshot-creation.js";
import { compareImportTimes, describeImportSnapshot, hasRecordedImportRun, importFollowsObservations } from "./import-snapshot-record.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { writeAppliedPackage } from "./package-writer.js";

export const IMPORT_SNAPSHOT_REVISION_FORMAT = "morivyx.import-snapshot-revision/0.1";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function fail(code) {
  throw new PackageError(`IMPORT_REVISION_${code}`, "/reimport", "再取込結果の保存条件を確認できません。");
}
function check(value, code) { if (!value) fail(code); }
function creationInput(input) {
  const { baselineArtifactRevision, ...creation } = input;
  return { ...creation, format: IMPORT_SNAPSHOT_CREATION_FORMAT };
}

export function validateImportSnapshotRevisionRequest(input) {
  try {
    check(Buffer.byteLength(canonicalJson(input)) <= 1048576, "INPUT_LIMIT");
    check(input?.format === IMPORT_SNAPSHOT_REVISION_FORMAT &&
      typeof input.baselineArtifactRevision === "string" && DIGEST.test(input.baselineArtifactRevision), "REQUEST_INVALID");
    validateImportSnapshotCreationRequest(creationInput(input));
  } catch (error) {
    if (error?.code === "IMPORT_REVISION_INPUT_LIMIT") throw error;
    fail("REQUEST_INVALID");
  }
  return input;
}

function restoreBaseline(base, artifact, request) {
  let restored;
  try {
    restored = restoreImportBaseline(base, { ...creationInput(request), baselineArtifactRevision: request.baselineArtifactRevision });
  } catch (error) { fail(error.code === "IMPORT_BASELINE_UNRECORDED" ? "BASELINE_UNRECORDED" : "BASELINE_INVALID"); }
  const { saved, provenance, uri, externalVersion, artifactKind } = restored;
  try {
    const snapshot = saved.snapshot;
    check(canonicalJson(artifact.extensions?.[IMPORT_SNAPSHOT_EXTENSION]) === canonicalJson(saved) &&
      artifact.attributes.artifactKind === artifactKind && artifact.attributes.uri === uri && artifact.attributes.digest === snapshot.digest &&
      artifact.attributes.externalVersion === externalVersion && artifact.provenance.method === "imported" &&
      artifact.provenance.actor === provenance.actor &&
      compareImportTimes(artifact.provenance.recordedAt, provenance.recordedAt) === 0 &&
      compareImportTimes(request.recordedAt, provenance.recordedAt) >= 0 &&
      compareImportTimes(request.runResult.output.retrievedAt, snapshot.retrievedAt) >= 0, "BASELINE_INVALID");
    return restored;
  } catch { fail("BASELINE_INVALID"); }
}

export function prepareImportSnapshotRevision(base, input) {
  validateImportSnapshotRevisionRequest(input);
  const request = structuredClone(input);
  check(base && Array.isArray(base.elements) && Array.isArray(base.changeSets), "PACKAGE_INVALID");
  check(base.revision?.id === request.baseRevision && base.revision.rootDigest === request.baseRootDigest, "BASE_MISMATCH");
  check(!packageRecords(base).some(record => record?.id === request.changeSetId), "CHANGESET_EXISTS");
  const targets = base.elements.filter(element => element.id === request.artifactId);
  check(targets.length === 1 && targets[0].kind === "entity" && targets[0].type === "core.artifact", "TARGET_INVALID");
  const artifact = targets[0];
  check(artifact.revision === request.baselineArtifactRevision, "LOCAL_CONFLICT");
  check(!hasRecordedImportRun(base, request.runResult), "RUN_ALREADY_RECORDED");
  try { check(importFollowsObservations(base, artifact.id, request.runResult.output.retrievedAt, request.recordedAt), "TIME_REGRESSION"); }
  catch { fail("TIME_REGRESSION"); }
  const { previousResult, saved } = restoreBaseline(base, artifact, request);
  const comparison = importAdapter(request.runResult).compare({ previousResult, currentRequest: request.runRequest, currentResult: request.runResult });
  check(comparison.status !== "current", "UNCHANGED");
  check(comparison.status === "stale", "COMPARISON_INVALID");
  const { record, uri, externalVersion } = describeImportSnapshot(request);
  const candidateElement = structuredClone(artifact);
  Object.assign(candidateElement.attributes, { uri, digest: record.snapshot.digest, externalVersion });
  candidateElement.lifecycle = "draft";
  candidateElement.reviewState = "unreviewed";
  candidateElement.provenance = { method: "imported", actor: request.actor, recordedAt: request.recordedAt };
  candidateElement.extensions[IMPORT_SNAPSHOT_EXTENSION] = record;
  candidateElement.revision = revisionId(candidateElement);
  const rootDigest = graphRootDigest(base.elements.map(element => element.id === artifact.id ? candidateElement : element));
  const changeSet = {
    format: "morivyx.changeset/0.1", id: request.changeSetId, baseRevision: request.baseRevision,
    resultingRevision: request.resultingRevision, resultingRootDigest: rootDigest,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    operations: [{ op: "revise", targetId: artifact.id, beforeRevision: request.baselineArtifactRevision,
      afterRevision: candidateElement.revision }],
    provenance: { ...candidateElement.provenance, importSnapshot: structuredClone(record),
      previousImportSnapshot: saved, baselineArtifactRevision: request.baselineArtifactRevision },
    recordedAt: request.recordedAt,
  };
  const resultingRevision = {
    format: "morivyx.graph-revision/0.1", id: request.resultingRevision, parentRevision: request.baseRevision,
    rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
  };
  applyChangeSet({ changeSet, currentRevision: base.revision, currentElements: base.elements,
    schemaLockDigest: base.calculatedSchemaLockDigest, candidateElements: [candidateElement], resultingRevision });
  return { comparison, candidateElement, changeSet, resultingRevision };
}

export async function writeReimportedSnapshotPackage(input) {
  validateImportSnapshotRevisionRequest(input?.request);
  const { basePath, outputPath } = input;
  const request = structuredClone(input.request);
  const base = await readGraphPackage(basePath);
  const prepared = prepareImportSnapshotRevision(base, request);
  const result = await writeAppliedPackage({ basePath, outputPath, changeSet: prepared.changeSet,
    candidateElements: [prepared.candidateElement], resultingRevision: prepared.resultingRevision });
  return { ...result, artifactId: request.artifactId, artifactRevision: prepared.candidateElement.revision };
}
