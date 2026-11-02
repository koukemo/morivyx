import { compareUnicode, graphRootDigest, revisionId } from "./canonical.js";
import { validateChangeSet } from "./changeset.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { validateGraphRevision } from "./graph-revision.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failure(code, path, message) {
  throw new PackageError(code, path, message);
}

function validateRevisionRecord(revision, path, code) {
  try {
    validateGraphRevision(revision);
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    failure(code, `${path}${error.path}`, error.message);
  }
}

function validateElementRecord(element, path) {
  try {
    validateGraphElement(element);
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    failure("CHANGESET_APPLY_INVALID", `${path}${error.path}`, error.message);
  }
}

function stableIdSet(values, path) {
  if (!Array.isArray(values)) {
    failure("CHANGESET_APPLY_INVALID", path, "ChangeSet IDの一覧が必要です。");
  }
  const result = new Set();
  values.forEach((value, index) => {
    if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
      failure(
        "CHANGESET_APPLY_INVALID",
        `${path}/${index}`,
        "小文字のUUID版4 ChangeSet IDが必要です。",
      );
    }
    if (result.has(value)) {
      failure(
        "CHANGESET_APPLY_INVALID",
        `${path}/${index}`,
        "ChangeSet IDが重複しています。",
      );
    }
    result.add(value);
  });
  return result;
}

function elementMap(elements, inputName) {
  if (!Array.isArray(elements)) {
    failure("CHANGESET_APPLY_INVALID", `/${inputName}`, "GraphElementの一覧が必要です。");
  }
  const result = new Map();
  elements.forEach((element, index) => {
    const path = `/${inputName}/${index}`;
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      failure(
        "CHANGESET_APPLY_INVALID",
        path,
        "GraphElementは対応表でなければなりません。",
      );
    }
    if (typeof element.id !== "string" || typeof element.revision !== "string") {
      failure("CHANGESET_APPLY_INVALID", path, "GraphElementのidとrevisionが必要です。");
    }
    validateElementRecord(element, path);
    if (revisionId(element) !== element.revision) {
      failure(
        "CHANGESET_APPLY_INVALID",
        `${path}/revision`,
        "現在のGraphElementのRevision IDが内容と一致しません。",
      );
    }
    if (result.has(element.id)) {
      failure("CHANGESET_APPLY_INVALID", `${path}/id`, "stable IDが重複しています。");
    }
    result.set(element.id, structuredClone(element));
  });
  return result;
}

function candidateMap(elements) {
  if (!Array.isArray(elements)) {
    failure(
      "CHANGESET_APPLY_INVALID",
      "/candidateElements",
      "候補GraphElementの一覧が必要です。",
    );
  }
  const result = new Map();
  elements.forEach((element, index) => {
    const path = `/candidateElements/${index}`;
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      failure("CHANGESET_APPLY_INVALID", path, "候補GraphElementは対応表にします。");
    }
    if (typeof element.id !== "string" || typeof element.revision !== "string") {
      failure("CHANGESET_APPLY_INVALID", path, "候補のidとrevisionが必要です。");
    }
    validateElementRecord(element, path);
    if (revisionId(element) !== element.revision) {
      failure(
        "CHANGESET_CANDIDATE_REVISION_MISMATCH",
        `${path}/revision`,
        "候補のRevision IDが内容の再計算値と一致しません。",
      );
    }
    const key = `${element.id}\0${element.revision}`;
    if (result.has(key)) {
      failure("CHANGESET_APPLY_INVALID", path, "同じ候補Revisionが重複しています。");
    }
    result.set(key, { element: structuredClone(element), index });
  });
  return result;
}

function assertCurrentElement(elements, operation, path) {
  const current = elements.get(operation.targetId);
  if (!current) {
    failure(
      "CHANGESET_PRECONDITION_FAILED",
      `${path}/targetId`,
      "操作対象が現在のGraphにありません。",
    );
  }
  if (current.revision !== operation.beforeRevision) {
    failure(
      "CHANGESET_PRECONDITION_FAILED",
      `${path}/beforeRevision`,
      "beforeRevisionが現在のRevision IDと一致しません。",
    );
  }
  return current;
}

function takeCandidate(candidates, consumed, id, revision, path) {
  const candidate = candidates.get(`${id}\0${revision}`);
  if (!candidate) {
    failure(
      "CHANGESET_PRECONDITION_FAILED",
      `${path}/afterRevision`,
      "afterRevisionに対応する候補GraphElementがありません。",
    );
  }
  consumed.add(candidate.index);
  return structuredClone(candidate.element);
}

function applyGraphOperation(elements, candidates, consumed, operation, index) {
  const path = `/operations/${index}`;
  if (operation.op === "create") {
    if (elements.has(operation.targetId)) {
      failure(
        "CHANGESET_PRECONDITION_FAILED",
        `${path}/targetId`,
        "createのstable IDが現在のGraphに存在します。",
      );
    }
    elements.set(
      operation.targetId,
      takeCandidate(candidates, consumed, operation.targetId, operation.afterRevision, path),
    );
    return;
  }
  if (operation.op === "revise") {
    assertCurrentElement(elements, operation, path);
    elements.set(
      operation.targetId,
      takeCandidate(candidates, consumed, operation.targetId, operation.afterRevision, path),
    );
    return;
  }
  if (operation.op === "retire") {
    assertCurrentElement(elements, operation, path);
    elements.delete(operation.targetId);
    return;
  }
  if (operation.op === "replace") {
    assertCurrentElement(elements, operation, path);
    if (elements.has(operation.replacementId)) {
      failure(
        "CHANGESET_PRECONDITION_FAILED",
        `${path}/replacementId`,
        "replacementIdが現在のGraphに存在します。",
      );
    }
    const replacement = takeCandidate(
      candidates,
      consumed,
      operation.replacementId,
      operation.afterRevision,
      path,
    );
    elements.delete(operation.targetId);
    elements.set(operation.replacementId, replacement);
  }
}

function applyRevoke(operation, changeSetId, knownChangeSetIds, appliedChangeSetIds) {
  if (operation.targetId === changeSetId) {
    failure(
      "CHANGESET_REVOKE_INVALID",
      "/operations/0/targetId",
      "ChangeSetは自分自身をrevokeできません。",
    );
  }
  if (!knownChangeSetIds.has(operation.targetId)) {
    failure(
      "CHANGESET_REVOKE_INVALID",
      "/operations/0/targetId",
      "撤回対象のChangeSetがありません。",
    );
  }
  if (appliedChangeSetIds.has(operation.targetId)) {
    failure(
      "CHANGESET_REVOKE_INVALID",
      "/operations/0/targetId",
      "適用済みのChangeSetはrevokeできません。",
    );
  }
}

function validateRevisionBoundary(
  resultingRevision,
  changeSet,
  schemaLockDigest,
  rootDigest,
) {
  if (!resultingRevision || typeof resultingRevision !== "object") {
    failure(
      "CHANGESET_RESULT_MISMATCH",
      "/resultingRevisionRecord",
      "適用後のGraphRevision記録が必要です。",
    );
  }
  const expected = {
    format: "morivyx.graph-revision/0.1",
    id: changeSet.resultingRevision,
    parentRevision: changeSet.baseRevision,
    rootDigest,
    schemaLockDigest,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (resultingRevision[field] !== value) {
      failure(
        "CHANGESET_RESULT_MISMATCH",
        `/resultingRevisionRecord/${field}`,
        `適用後のGraphRevisionがChangeSetと一致しません: ${field}`,
      );
    }
  }
  validateRevisionRecord(
    resultingRevision,
    "/resultingRevisionRecord",
    "CHANGESET_RESULT_MISMATCH",
  );
}

export function applyChangeSet(input) {
  const {
    changeSet,
    currentRevision,
    schemaLockDigest,
    sourceSchemaLockDigest = schemaLockDigest,
    targetSchemaLockDigest = schemaLockDigest,
    currentElements,
    candidateElements = [],
    resultingRevision,
    knownChangeSetIds = [],
    appliedChangeSetIds = [],
  } = input ?? {};
  validateChangeSet(changeSet);
  const elements = elementMap(currentElements, "currentElements");
  if (!currentRevision || typeof currentRevision !== "object") {
    failure(
      "CHANGESET_APPLY_INVALID",
      "/currentRevision",
      "現在のGraphRevisionが必要です。",
    );
  }
  validateRevisionRecord(
    currentRevision,
    "/currentRevision",
    "CHANGESET_APPLY_INVALID",
  );
  if (currentRevision.id !== changeSet.baseRevision) {
    failure(
      "CHANGESET_BASE_REVISION_MISMATCH",
      "/baseRevision",
      "ChangeSetのbaseRevisionが現在のGraphRevisionと一致しません。",
    );
  }
  if (
    currentRevision.schemaLockDigest !== sourceSchemaLockDigest ||
    changeSet.schemaLockDigest !== targetSchemaLockDigest
  ) {
    failure(
      "CHANGESET_SCHEMA_LOCK_MISMATCH",
      "/schemaLockDigest",
      "ChangeSetと現在のSchema lock digestが一致しません。",
    );
  }
  if (graphRootDigest([...elements.values()]) !== currentRevision.rootDigest) {
    failure(
      "CHANGESET_APPLY_INVALID",
      "/currentRevision/rootDigest",
      "現在のGraphRevisionとGraphElementのroot digestが一致しません。",
    );
  }

  const candidates = candidateMap(candidateElements);
  const consumed = new Set();
  if (changeSet.operations[0].op === "revoke") {
    applyRevoke(
      changeSet.operations[0],
      changeSet.id,
      stableIdSet(knownChangeSetIds, "/knownChangeSetIds"),
      stableIdSet(appliedChangeSetIds, "/appliedChangeSetIds"),
    );
  } else {
    changeSet.operations.forEach((operation, index) =>
      applyGraphOperation(elements, candidates, consumed, operation, index),
    );
  }
  for (const { index } of candidates.values()) {
    if (!consumed.has(index)) {
      failure(
        "CHANGESET_PRECONDITION_FAILED",
        `/candidateElements/${index}`,
        "操作から参照されない候補GraphElementがあります。",
      );
    }
  }

  const resultingElements = [...elements.values()].sort((left, right) =>
    compareUnicode(left.id, right.id),
  );
  const rootDigest = graphRootDigest(resultingElements);
  if (rootDigest !== changeSet.resultingRootDigest) {
    failure(
      "CHANGESET_RESULT_MISMATCH",
      "/resultingRootDigest",
      "適用結果のroot digestがChangeSetと一致しません。",
    );
  }
  validateRevisionBoundary(
    resultingRevision,
    changeSet,
    targetSchemaLockDigest,
    rootDigest,
  );

  return {
    elements: resultingElements.map((element) => structuredClone(element)),
    revision: structuredClone(resultingRevision),
    rootDigest,
  };
}
