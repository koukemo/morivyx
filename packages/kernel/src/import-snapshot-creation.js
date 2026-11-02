import { canonicalJson, graphRootDigest, revisionId } from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { validateGraphRevision } from "./graph-revision.js";
import { importAdapter } from "./import-adapters.js";
import { compareImportTimes, describeImportSnapshot, hasRecordedImportRun } from "./import-snapshot-record.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { writeAppliedPackage } from "./package-writer.js";
import { getDeclaredPluginCapability } from "./plugin-manifest.js";

export const IMPORT_SNAPSHOT_CREATION_FORMAT = "morivyx.import-snapshot-creation/0.1";
export const IMPORT_SNAPSHOT_EXTENSION = "morivyx.import/snapshot";
const ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRAPH = /^graph:\S+$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEYS = ["format", "artifactId", "changeSetId", "baseRevision", "baseRootDigest",
  "resultingRevision", "actor", "recordedAt", "manifest", "runRequest", "runResult"];

function fail(code) {
  throw new PackageError(`IMPORT_SNAPSHOT_${code}`, "/import", "取込結果の保存条件を確認できません。");
}
function check(condition, code) { if (!condition) fail(code); }
function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }
function logical(value) {
  try { return canonicalJson(value); } catch { fail("REQUEST_INVALID"); }
}
function map(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function validateImportSnapshotCreationRequest(request) {
  // Canonical validation rejects proxies, accessors, non-JSON values and invalid timestamps.
  const text = logical(request);
  check(Buffer.byteLength(text) <= 1048576, "INPUT_LIMIT");
  check(map(request) && Object.keys(request).length === KEYS.length &&
    KEYS.every(key => Object.hasOwn(request, key)), "REQUEST_INVALID");
  check(request.format === IMPORT_SNAPSHOT_CREATION_FORMAT &&
    [request.artifactId, request.changeSetId, request.actor].every(value => matches(value, ID)) &&
    new Set([request.artifactId, request.changeSetId, request.actor]).size === 3 &&
    matches(request.baseRevision, GRAPH) && matches(request.resultingRevision, GRAPH) &&
    request.baseRevision !== request.resultingRevision && matches(request.baseRootDigest, DIGEST) &&
    matches(request.recordedAt, TIME), "REQUEST_INVALID");
  try {
    const result = request.runResult;
    const adapter = importAdapter(result);
    adapter.validateRequest(request.runRequest);
    adapter.validateResult(result, request.runRequest);
    if (adapter.system === "repository") {
      const input = request.runRequest.input;
      check(map(input) && Object.keys(input).length === 3 &&
        ["repositoryRoot", "externalId", "locator"].every(key =>
          typeof input[key] === "string" && input[key].length > 0) &&
        !/[\\\x00-\x1f\x7f]/.test(input.locator) &&
        input.locator.split("/").every(part => part && part !== "." && part !== ".."), "RESULT_INVALID");
    }
    const capability = getDeclaredPluginCapability(request.manifest, result.capabilityId);
    check(result.status === "success" && capability.effect === adapter.effect &&
      request.runRequest.capability.effect === adapter.effect &&
      request.manifest.identity.id === result.plugin.id &&
      request.manifest.identity.version === result.plugin.version, "RESULT_INVALID");
    check(capability.inputFormat === adapter.inputFormat && capability.outputFormat === adapter.outputFormat &&
      compareImportTimes(request.recordedAt, result.output.retrievedAt) >= 0, "RESULT_INVALID");
  } catch { fail("RESULT_INVALID"); }
  return request;
}

function externalKey(record) {
  const snapshot = record?.snapshot;
  if (!snapshot?.externalIdentity || typeof snapshot.locator !== "string") return null;
  return canonicalJson({ externalIdentity: snapshot.externalIdentity, locator: snapshot.locator });
}

export function prepareImportSnapshotCreation(packageContents, input) {
  validateImportSnapshotCreationRequest(input);
  const request = structuredClone(input);
  check(packageContents && Array.isArray(packageContents.elements), "PACKAGE_INVALID");
  const base = packageContents;
  check(base.revision?.id === request.baseRevision &&
    base.revision.rootDigest === request.baseRootDigest, "BASE_MISMATCH");
  const { record, uri, externalVersion, artifactKind } = describeImportSnapshot(request);
  const records = packageRecords(base);
  check(!records.some(value => [request.artifactId, request.changeSetId].includes(value?.id)), "ID_EXISTS");
  const key = externalKey(record);
  check(!records.some(value =>
    externalKey(value?.extensions?.[IMPORT_SNAPSHOT_EXTENSION]) === key ||
    externalKey(value?.provenance?.importSnapshot) === key ||
    (value?.type === "core.artifact" && value.attributes?.uri === uri)), "TARGET_EXISTS");
  check(Array.isArray(base.changeSets), "PACKAGE_INVALID");
  check(!hasRecordedImportRun(base, request.runResult), "RUN_ALREADY_RECORDED");
  const schema = base.schemaLock?.schemas?.find(value => value.schemaId === "morivyx.core");
  check(schema && typeof schema.version === "string", "SCHEMA_MISSING");
  const provenance = { method: "imported", actor: request.actor, recordedAt: request.recordedAt };
  const candidateElement = {
    format: "morivyx.git-graph/0.1", kind: "entity", id: request.artifactId,
    type: "core.artifact", typeVersion: schema.version, lifecycle: "draft", reviewState: "unreviewed",
    attributes: { artifactKind, uri, digest: record.snapshot.digest, externalVersion },
    provenance: structuredClone(provenance), extensions: { [IMPORT_SNAPSHOT_EXTENSION]: record },
  };
  candidateElement.revision = revisionId(candidateElement);
  validateGraphElement(candidateElement);
  const rootDigest = graphRootDigest([...base.elements, candidateElement]);
  const changeSet = {
    format: "morivyx.changeset/0.1", id: request.changeSetId,
    baseRevision: request.baseRevision, resultingRevision: request.resultingRevision,
    resultingRootDigest: rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
    operations: [{ op: "create", targetId: candidateElement.id, afterRevision: candidateElement.revision }],
    // Keep the external identity in the ledger even if later human edits remove the extension.
    provenance: { ...provenance, importSnapshot: structuredClone(record) }, recordedAt: request.recordedAt,
  };
  const resultingRevision = {
    format: "morivyx.graph-revision/0.1", id: request.resultingRevision,
    parentRevision: request.baseRevision, rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
  };
  validateChangeSet(changeSet); validateGraphRevision(resultingRevision);
  // Check current revisions and root as well as the candidate; never trust a forged base digest.
  applyChangeSet({ changeSet, currentRevision: base.revision, currentElements: base.elements,
    schemaLockDigest: base.calculatedSchemaLockDigest, candidateElements: [candidateElement], resultingRevision });
  return { candidateElement, changeSet, resultingRevision };
}

export async function writeImportedSnapshotPackage(input) {
  check(map(input), "REQUEST_INVALID");
  const { basePath, outputPath } = input;
  validateImportSnapshotCreationRequest(input.request);
  const request = structuredClone(input.request); // No caller-owned state is used after the first await.
  const base = await readGraphPackage(basePath);
  const prepared = prepareImportSnapshotCreation(base, request);
  const result = await writeAppliedPackage({ basePath, outputPath, changeSet: prepared.changeSet,
    candidateElements: [prepared.candidateElement], resultingRevision: prepared.resultingRevision });
  return { ...result, artifactId: request.artifactId, artifactRevision: prepared.candidateElement.revision };
}
