import { canonicalJson, graphRootDigest, revisionId } from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { validateGraphRevision } from "./graph-revision.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { writeAppliedPackage } from "./package-writer.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROOT_FIELDS = new Set([
  "format",
  "decisionId",
  "attributes",
  "changeSetId",
  "resultingRevision",
  "actor",
  "recordedAt",
]);
const REVISABLE_LIFECYCLES = new Set(["draft", "active"]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function issuePath(filePath, path) {
  return filePath && path ? `${filePath}#${path}` : filePath || path;
}

function invalid(filePath, path, message) {
  throw new PackageError(
    "DECISION_REVISION_REQUEST_INVALID",
    issuePath(filePath, path),
    message,
  );
}

function assertMap(value, filePath, path, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(filePath, path, `${name}は対応表でなければなりません。`);
  }
}

function assertStableId(value, filePath, path) {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    invalid(filePath, path, "小文字のUUID版4 stable IDが必要です。");
  }
}

function assertGraphRevisionId(value, filePath, path) {
  if (typeof value !== "string" || !GRAPH_REVISION_PATTERN.test(value)) {
    invalid(filePath, path, "graph:で始まるGraphRevision IDが必要です。");
  }
}

function assertTimestamp(value, filePath, path) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    invalid(filePath, path, "RFC 3339形式の時刻が必要です。");
  }
  try {
    canonicalJson(value);
  } catch {
    invalid(filePath, path, "実在する日時と時間帯が必要です。");
  }
}

export function validateDecisionRevisionRequest(request, filePath = "") {
  assertMap(request, filePath, "", "Decision更新要求");
  for (const key of Object.keys(request)) {
    if (!ROOT_FIELDS.has(key)) {
      invalid(
        filePath,
        pointerChild("", key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
  if (request.format !== "morivyx.decision-revision-request/0.1") {
    invalid(
      filePath,
      "/format",
      "対応していないDecision更新要求形式です。",
    );
  }
  assertStableId(request.decisionId, filePath, "/decisionId");
  assertMap(request.attributes, filePath, "/attributes", "attributes");
  try {
    canonicalJson(request.attributes);
  } catch (error) {
    invalid(
      filePath,
      "/attributes",
      `attributesを正規化できません: ${error.message}`,
    );
  }
  assertStableId(request.changeSetId, filePath, "/changeSetId");
  if (request.decisionId === request.changeSetId) {
    invalid(
      filePath,
      "/changeSetId",
      "DecisionとChangeSetには異なるstable IDが必要です。",
    );
  }
  assertGraphRevisionId(
    request.resultingRevision,
    filePath,
    "/resultingRevision",
  );
  assertStableId(request.actor, filePath, "/actor");
  assertTimestamp(request.recordedAt, filePath, "/recordedAt");
  return request;
}

function targetError(requestPath, path, code, message) {
  throw new PackageError(code, issuePath(requestPath, path), message);
}

export function prepareDecisionRevision(packageContents, request, requestPath = "") {
  validateDecisionRevisionRequest(request, requestPath);
  if (!packageContents || !Array.isArray(packageContents.elements)) {
    throw new PackageError(
      "DECISION_REVISION_PACKAGE_INVALID",
      "/package",
      "検証済みのGraph packageが必要です。",
    );
  }
  const decision = packageContents.elements.find(
    (element) => element.id === request.decisionId,
  );
  if (!decision) {
    targetError(
      requestPath,
      "/decisionId",
      "DECISION_REVISION_TARGET_MISSING",
      "更新対象のDecisionがGraph packageにありません。",
    );
  }
  if (decision.kind !== "entity" || decision.type !== "core.decision") {
    targetError(
      requestPath,
      "/decisionId",
      "DECISION_REVISION_TARGET_INVALID",
      "更新対象はcore.decision Entityでなければなりません。",
    );
  }
  if (!REVISABLE_LIFECYCLES.has(decision.lifecycle)) {
    targetError(
      requestPath,
      "/decisionId",
      "DECISION_REVISION_LIFECYCLE_INVALID",
      "revise-decisionで更新できるのはdraftまたはactiveの" +
        "Decisionだけです。",
    );
  }
  if (
    packageRecords(packageContents).some(
      (record) => record?.id === request.changeSetId,
    )
  ) {
    targetError(
      requestPath,
      "/changeSetId",
      "DECISION_REVISION_CHANGESET_ID_EXISTS",
      "同じstable IDの記録がGraph packageにあります。",
    );
  }
  if (request.resultingRevision === packageContents.revision.id) {
    targetError(
      requestPath,
      "/resultingRevision",
      "DECISION_REVISION_RESULT_INVALID",
      "更新後のGraphRevision IDは現在のIDと異なる値にします。",
    );
  }

  const candidateElement = structuredClone(decision);
  candidateElement.attributes = structuredClone(request.attributes);
  candidateElement.reviewState = "unreviewed";
  candidateElement.provenance = {
    method: "asserted",
    actor: request.actor,
    recordedAt: request.recordedAt,
  };
  candidateElement.revision = revisionId(candidateElement);
  validateGraphElement(candidateElement, "/candidateElement");

  const elements = packageContents.elements.map((element) =>
    element.id === decision.id ? candidateElement : element,
  );
  const resultingRootDigest = graphRootDigest(elements);
  const changeSet = {
    format: "morivyx.changeset/0.1",
    id: request.changeSetId,
    baseRevision: packageContents.revision.id,
    resultingRevision: request.resultingRevision,
    resultingRootDigest,
    schemaLockDigest: packageContents.calculatedSchemaLockDigest,
    operations: [
      {
        op: "revise",
        targetId: decision.id,
        beforeRevision: decision.revision,
        afterRevision: candidateElement.revision,
      },
    ],
    provenance: {
      method: "asserted",
      actor: request.actor,
      recordedAt: request.recordedAt,
    },
    recordedAt: request.recordedAt,
  };
  const resultingRevision = {
    format: "morivyx.graph-revision/0.1",
    id: request.resultingRevision,
    parentRevision: packageContents.revision.id,
    rootDigest: resultingRootDigest,
    schemaLockDigest: packageContents.calculatedSchemaLockDigest,
  };
  validateChangeSet(changeSet, "/changeSet");
  validateGraphRevision(resultingRevision, "/resultingRevision");

  return { candidateElement, changeSet, resultingRevision };
}

export async function writeRevisedDecisionPackage(input) {
  const { basePath, outputPath, request, requestPath = "" } = input ?? {};
  validateDecisionRevisionRequest(request, requestPath);
  const packageContents = await readGraphPackage(basePath);
  const prepared = prepareDecisionRevision(
    packageContents,
    request,
    requestPath,
  );
  const result = await writeAppliedPackage({
    basePath,
    outputPath,
    changeSet: prepared.changeSet,
    candidateElements: [prepared.candidateElement],
    resultingRevision: prepared.resultingRevision,
  });
  return {
    ...result,
    decisionId: request.decisionId,
    decisionRevision: prepared.candidateElement.revision,
    changeSetId: request.changeSetId,
  };
}
