import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROOT_FIELDS = new Set([
  "format",
  "id",
  "actor",
  "targetId",
  "targetRevision",
  "operation",
  "scope",
  "approvedAt",
  "recordedAt",
  "expiresAt",
  "revokes",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(filePath, path, message) {
  throw new PackageError(
    "APPROVAL_INVALID",
    filePath && path ? `${filePath}#${path}` : filePath || path,
    message,
  );
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

export function validateApproval(approval, filePath = "") {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    invalid(filePath, "", "approvalは対応表でなければなりません。");
  }
  for (const key of Object.keys(approval)) {
    if (!ROOT_FIELDS.has(key)) {
      invalid(
        filePath,
        pointerChild("", key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
  if (approval.format !== "morivyx.approval/0.1") {
    invalid(filePath, "/format", "対応していないapproval形式です。");
  }
  for (const field of ["id", "actor", "targetId"]) {
    assertStableId(approval[field], filePath, pointerChild("", field));
  }
  if (
    typeof approval.targetRevision !== "string" ||
    !REVISION_PATTERN.test(approval.targetRevision)
  ) {
    invalid(
      filePath,
      "/targetRevision",
      "小文字のSHA-256 Revision IDが必要です。",
    );
  }
  for (const field of ["operation", "scope"]) {
    assertString(approval[field], filePath, pointerChild("", field));
  }
  for (const field of ["approvedAt", "recordedAt"]) {
    assertTimestamp(approval[field], filePath, pointerChild("", field));
  }
  if (Object.hasOwn(approval, "expiresAt")) {
    assertTimestamp(approval.expiresAt, filePath, "/expiresAt");
  }
  if (approval.operation === "revoke") {
    if (!Object.hasOwn(approval, "revokes")) {
      invalid(
        filePath,
        "/revokes",
        "revoke操作には撤回対象のapproval stable IDが必要です。",
      );
    }
    assertStableId(approval.revokes, filePath, "/revokes");
    if (approval.revokes === approval.id) {
      invalid(filePath, "/revokes", "approvalは自分自身を撤回できません。");
    }
  } else if (Object.hasOwn(approval, "revokes")) {
    invalid(filePath, "/revokes", "revoke以外の操作にrevokesは置けません。");
  }
  return approval;
}

function ledgerPointer(filePaths, index, field) {
  return filePaths[index]
    ? { filePath: filePaths[index], pointer: `/${field}` }
    : { filePath: "", pointer: `/approvals/${index}/${field}` };
}

function invalidLedger(filePaths, index, field, message) {
  const { filePath, pointer } = ledgerPointer(filePaths, index, field);
  invalid(filePath, pointer, message);
}

export function validateApprovalLedger(approvals, filePaths = []) {
  if (!Array.isArray(approvals)) {
    invalid("", "/approvals", "approval ledgerは一覧でなければなりません。");
  }
  if (!Array.isArray(filePaths) || filePaths.length > approvals.length) {
    invalid("", "/filePaths", "file pathはapprovalに対応する一覧にします。");
  }

  const byId = new Map();
  approvals.forEach((approval, index) => {
    try {
      validateApproval(approval, filePaths[index]);
    } catch (error) {
      if (
        error instanceof PackageError &&
        !filePaths[index] &&
        typeof error.path === "string"
      ) {
        const pointer = error.path ? `/approvals/${index}${error.path}` : `/approvals/${index}`;
        throw new PackageError(error.code, pointer, error.message);
      }
      throw error;
    }
    if (byId.has(approval.id)) {
      invalidLedger(
        filePaths,
        index,
        "id",
        "approval ledger内のstable IDは重複できません。",
      );
    }
    byId.set(approval.id, approval);
  });

  approvals.forEach((approval, index) => {
    if (approval.operation !== "revoke") {
      return;
    }
    const revoked = byId.get(approval.revokes);
    if (!revoked) {
      invalidLedger(
        filePaths,
        index,
        "revokes",
        "撤回対象のapprovalがledger内にありません。",
      );
    }
    if (revoked.operation === "revoke") {
      invalidLedger(
        filePaths,
        index,
        "revokes",
        "revoke記録を別のrevoke記録で撤回できません。",
      );
    }
    if (
      revoked.targetId !== approval.targetId ||
      revoked.targetRevision !== approval.targetRevision
    ) {
      invalidLedger(
        filePaths,
        index,
        "revokes",
        "撤回記録の対象IDとRevisionは撤回対象approvalに一致させます。",
      );
    }
  });
  return approvals;
}
