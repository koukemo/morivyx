import { canonicalJson, changeSetDigest } from "./canonical.js";
import { PackageError } from "./errors.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROOT_FIELDS = new Set([
  "format",
  "id",
  "baseRevision",
  "resultingRevision",
  "resultingRootDigest",
  "schemaLockDigest",
  "operations",
  "provenance",
  "recordedAt",
]);
const OPERATION_FIELDS = new Set([
  "op",
  "targetId",
  "beforeRevision",
  "afterRevision",
  "replacementId",
]);
const OPERATION_RULES = {
  create: { required: ["afterRevision"], forbidden: ["beforeRevision", "replacementId"] },
  revise: {
    required: ["beforeRevision", "afterRevision"],
    forbidden: ["replacementId"],
  },
  retire: { required: ["beforeRevision"], forbidden: ["afterRevision", "replacementId"] },
  replace: {
    required: ["beforeRevision", "afterRevision", "replacementId"],
    forbidden: [],
  },
  revoke: {
    required: [],
    forbidden: ["beforeRevision", "afterRevision", "replacementId"],
  },
};

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(filePath, path, message) {
  throw new PackageError(
    "CHANGESET_INVALID",
    filePath && path ? `${filePath}#${path}` : filePath || path,
    message,
  );
}

function assertFields(value, allowed, filePath, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(filePath, pointerChild(path, key), `定義されていない項目です: ${key}`);
    }
  }
}

function assertString(value, filePath, path) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(filePath, path, "空でない文字列が必要です。");
  }
}

function assertStableId(value, filePath, path) {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    invalid(filePath, path, "小文字のUUID版4 stable IDが必要です。");
  }
}

function assertRevision(value, filePath, path) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    invalid(filePath, path, "小文字のSHA-256 digestが必要です。");
  }
}

function assertGraphRevision(value, filePath, path) {
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

function validateOperation(operation, index, filePath) {
  const path = `/operations/${index}`;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    invalid(filePath, path, "ChangeSetの操作は対応表でなければなりません。");
  }
  assertFields(operation, OPERATION_FIELDS, filePath, path);
  const rules = typeof operation.op === "string" && Object.hasOwn(OPERATION_RULES, operation.op)
    ? OPERATION_RULES[operation.op]
    : undefined;
  if (!rules) {
    invalid(filePath, `${path}/op`, `未知の操作です: ${String(operation.op)}`);
  }
  assertStableId(operation.targetId, filePath, `${path}/targetId`);
  for (const field of rules.required) {
    if (!Object.hasOwn(operation, field)) {
      invalid(
        filePath,
        pointerChild(path, field),
        `操作に必須の項目がありません: ${field}`,
      );
    }
  }
  for (const field of rules.forbidden) {
    if (Object.hasOwn(operation, field)) {
      invalid(filePath, pointerChild(path, field), `操作に置けない項目です: ${field}`);
    }
  }
  for (const field of ["beforeRevision", "afterRevision"]) {
    if (Object.hasOwn(operation, field)) {
      assertRevision(operation[field], filePath, pointerChild(path, field));
    }
  }
  if (Object.hasOwn(operation, "replacementId")) {
    assertStableId(operation.replacementId, filePath, `${path}/replacementId`);
    if (operation.replacementId === operation.targetId) {
      invalid(
        filePath,
        `${path}/replacementId`,
        "replacementIdはtargetIdと異なるstable IDにします。",
      );
    }
  }
}

export function validateChangeSet(changeSet, filePath = "") {
  if (!changeSet || typeof changeSet !== "object" || Array.isArray(changeSet)) {
    invalid(filePath, "", "ChangeSetは対応表でなければなりません。");
  }
  assertFields(changeSet, ROOT_FIELDS, filePath, "");
  if (changeSet.format !== "morivyx.changeset/0.1") {
    invalid(filePath, "/format", "対応していないChangeSet形式です。");
  }
  assertStableId(changeSet.id, filePath, "/id");
  assertGraphRevision(changeSet.baseRevision, filePath, "/baseRevision");
  assertGraphRevision(changeSet.resultingRevision, filePath, "/resultingRevision");
  assertRevision(changeSet.resultingRootDigest, filePath, "/resultingRootDigest");
  assertRevision(changeSet.schemaLockDigest, filePath, "/schemaLockDigest");
  if (!Array.isArray(changeSet.operations) || changeSet.operations.length === 0) {
    invalid(filePath, "/operations", "ChangeSetには一件以上の操作が必要です。");
  }
  changeSet.operations.forEach((operation, index) =>
    validateOperation(operation, index, filePath),
  );
  if (
    changeSet.operations.some(({ op }) => op === "revoke") &&
    changeSet.operations.length !== 1
  ) {
    invalid(filePath, "/operations", "revokeを他の操作と混在させられません。");
  }
  if (
    !changeSet.provenance ||
    typeof changeSet.provenance !== "object" ||
    Array.isArray(changeSet.provenance)
  ) {
    invalid(filePath, "/provenance", "ProvenanceRecordが必要です。");
  }
  assertString(changeSet.provenance.method, filePath, "/provenance/method");
  assertStableId(changeSet.provenance.actor, filePath, "/provenance/actor");
  assertTimestamp(
    changeSet.provenance.recordedAt,
    filePath,
    "/provenance/recordedAt",
  );
  assertTimestamp(changeSet.recordedAt, filePath, "/recordedAt");
  return changeSet;
}

export { changeSetDigest };
