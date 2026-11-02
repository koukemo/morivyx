import { normalizeNfc } from "./unicode-nfc.js";
import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { canonicalJson, compareUnicode } from "./canonical.js";
import { PackageError } from "./errors.js";
import { externalArtifactReportDigest } from "./external-artifact.js";
import {
  assertPackageRecordIdAvailable,
  ensurePackageRecordDirectory,
  withPackageRecordIdLock,
} from "./package-record-id.js";
import { readYamlRecord } from "./yaml-reader.js";
import {
  compareSemanticDiffEntries,
  migrationSemanticDiffDigest,
  semanticDiffDigest,
} from "./semantic-diff.js";
import { traceReportDigest } from "./trace-query.js";
import {
  EXTERNAL_ARTIFACT_IDENTITY_ORDER,
  EXTERNAL_ARTIFACT_ISSUE_ORDER,
  EXTERNAL_ARTIFACT_REPORT_ORDER,
  EXTERNAL_ARTIFACT_RETRIEVAL_ORDER,
  MIGRATION_SEMANTIC_DIFF_ORDER,
  SEMANTIC_DIFF_ORDER,
  TRACE_REPORT_ORDER,
} from "./yaml-record-order.js";
import { serializeYamlRecord } from "./yaml-writer.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TRACE_QUERY_IDS = new Set([
  "why-artifact-exists",
  "governing-decision",
  "decision-evidence",
  "goal-achievement-evidence",
  "observation-triggered-change",
]);
const TRACE_STATUSES = new Set([
  "complete",
  "partial",
  "waived",
  "stale",
  "broken",
]);
const TRACE_REPORT_FIELDS = new Set(TRACE_REPORT_ORDER);
const TRACE_REPORT_REQUIRED = [
  "format",
  "queryId",
  "graphRevision",
  "schemaLockDigest",
  "focusId",
  "evaluatedAt",
  "status",
  "paths",
  "missing",
];
const SEMANTIC_DIFF_FIELDS = new Set(SEMANTIC_DIFF_ORDER);
const SEMANTIC_DIFF_REQUIRED = [
  "format",
  "baseRevision",
  "targetRevision",
  "schemaLockDigest",
  "evaluatedAt",
  "entries",
];
const MIGRATION_SEMANTIC_DIFF_FIELDS = new Set(
  MIGRATION_SEMANTIC_DIFF_ORDER,
);
const MIGRATION_SEMANTIC_DIFF_REQUIRED = [
  "format",
  "baseRevision",
  "targetRevision",
  "sourceSchemaLockDigest",
  "targetSchemaLockDigest",
  "evaluatedAt",
  "entries",
];
const EXTERNAL_ARTIFACT_REPORT_FIELDS = new Set(
  EXTERNAL_ARTIFACT_REPORT_ORDER,
);
const EXTERNAL_ARTIFACT_REPORT_REQUIRED = [
  "format",
  "graphRevision",
  "artifact",
  "externalSource",
  "relation",
  "retrieval",
  "comparedAt",
  "status",
  "issues",
];
const EXTERNAL_ARTIFACT_STATUSES = new Set([
  "current",
  "stale",
  "missing",
  "unavailable",
  "invalid",
]);
const EXTERNAL_RETRIEVAL_STATUSES = new Set([
  "resolved",
  "missing",
  "unavailable",
]);
const EXTERNAL_ISSUE_ORDER = [
  "EXTERNAL_REFERENCE_INCOMPLETE",
  "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
  "EXTERNAL_SOURCE_UNAVAILABLE",
  "EXTERNAL_TARGET_MISSING",
  "EXTERNAL_VERSION_CHANGED",
  "EXTERNAL_DIGEST_CHANGED",
];
const EXTERNAL_ISSUES = new Set(EXTERNAL_ISSUE_ORDER);
const DIFF_ENTRY_FIELDS = new Map([
  ["entity_added", ["afterRevision"]],
  ["entity_revised", ["beforeRevision", "afterRevision"]],
  ["entity_retired", ["beforeRevision"]],
  [
    "entity_replaced",
    ["beforeRevision", "afterRevision", "replacementId"],
  ],
  ["relation_added", ["afterRevision"]],
  ["relation_revised", ["beforeRevision", "afterRevision"]],
  ["relation_retired", ["beforeRevision"]],
  ["decision_changed", ["beforeRevision", "afterRevision", "aspect"]],
  ["goal_changed", ["beforeRevision", "afterRevision", "aspect"]],
  [
    "trace_quality_changed",
    ["queryId", "beforeStatus", "afterStatus"],
  ],
  ["provenance_changed", ["beforeRevision", "afterRevision"]],
  ["external_digest_changed", ["beforeRevision", "afterRevision"]],
  ["schema_changed", []],
  ["unknown_extension_changed", ["beforeRevision", "afterRevision"]],
]);
function location(path, pointer) {
  return path ? `${path}#${pointer}` : pointer;
}

function invalid(path, pointer, message, code = "REPORT_STRUCTURE_INVALID") {
  throw new PackageError(code, location(path, pointer), message);
}

function pointerChild(pointer, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${segment}`;
}

function validateFields(record, allowed, required, path, pointer) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    invalid(path, pointer, "Reportの記録は対応表でなければなりません。");
  }
  for (const field of required) {
    if (!Object.hasOwn(record, field)) {
      invalid(
        path,
        pointerChild(pointer, field),
        `Reportの必須項目がありません: ${field}`,
      );
    }
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      invalid(
        path,
        pointerChild(pointer, field),
        `Reportに未知の項目があります: ${field}`,
      );
    }
  }
}

function requireString(record, field, path, pointer) {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    invalid(
      path,
      pointerChild(pointer, field),
      `Reportの文字列項目が不正です: ${field}`,
    );
  }
  return normalizeNfc(value);
}

function requireStableId(record, field, path, pointer) {
  const value = requireString(record, field, path, pointer);
  if (!STABLE_ID_PATTERN.test(value)) {
    invalid(
      path,
      pointerChild(pointer, field),
      `Reportのstable IDが不正です: ${field}`,
    );
  }
  return value;
}

function requireGraphRevision(record, field, path, pointer) {
  const value = requireString(record, field, path, pointer);
  if (!GRAPH_REVISION_PATTERN.test(value)) {
    invalid(
      path,
      pointerChild(pointer, field),
      `ReportのGraphRevision IDが不正です: ${field}`,
    );
  }
  return value;
}

function requireDigest(record, field, path, pointer) {
  const value = requireString(record, field, path, pointer);
  if (!DIGEST_PATTERN.test(value)) {
    invalid(
      path,
      pointerChild(pointer, field),
      `Reportのdigestが不正です: ${field}`,
    );
  }
  return value;
}

function requireTimestamp(record, field, path, pointer) {
  const value = requireString(record, field, path, pointer);
  if (!TIMESTAMP_PATTERN.test(value)) {
    invalid(
      path,
      pointerChild(pointer, field),
      `Reportの評価時刻が不正です: ${field}`,
    );
  }
  try {
    canonicalJson(value);
  } catch {
    invalid(
      path,
      pointerChild(pointer, field),
      `Reportの評価時刻が不正です: ${field}`,
    );
  }
}

function sharesTraceEndpoint(left, right) {
  const leftEndpoints = [
    [left.fromId, left.fromRevision],
    [left.toId, left.toRevision],
  ];
  const rightEndpoints = [
    [right.fromId, right.fromRevision],
    [right.toId, right.toRevision],
  ];
  return leftEndpoints.some(([leftId, leftRevision]) =>
    rightEndpoints.some(
      ([rightId, rightRevision]) =>
        leftId === rightId && leftRevision === rightRevision,
    ),
  );
}

function validateTracePaths(paths, focusId, path) {
  if (!Array.isArray(paths)) {
    invalid(path, "/paths", "Trace Reportのpathsは一覧でなければなりません。");
  }
  let previous;
  paths.forEach((tracePath, pathIndex) => {
    const pathPointer = `/paths/${pathIndex}`;
    validateFields(tracePath, new Set(["hops"]), ["hops"], path, pathPointer);
    if (!Array.isArray(tracePath.hops) || tracePath.hops.length === 0) {
      invalid(
        path,
        `${pathPointer}/hops`,
        "Trace Reportの経路には一件以上のhopが必要です。",
      );
    }
    tracePath.hops.forEach((hop, hopIndex) => {
      const hopPointer = `${pathPointer}/hops/${hopIndex}`;
      const fields = [
        "fromId",
        "predicate",
        "toId",
        "fromRevision",
        "toRevision",
      ];
      validateFields(hop, new Set(fields), fields, path, hopPointer);
      requireStableId(hop, "fromId", path, hopPointer);
      requireString(hop, "predicate", path, hopPointer);
      requireStableId(hop, "toId", path, hopPointer);
      requireDigest(hop, "fromRevision", path, hopPointer);
      requireDigest(hop, "toRevision", path, hopPointer);
      if (hopIndex === 0 && hop.fromId !== focusId && hop.toId !== focusId) {
        invalid(
          path,
          hopPointer,
          "Trace Reportの先頭hopはfocusIdを端点に持たなければなりません。",
        );
      }
      if (
        hopIndex > 0 &&
        !sharesTraceEndpoint(tracePath.hops[hopIndex - 1], hop)
      ) {
        invalid(
          path,
          hopPointer,
          "Trace Reportの隣接hopは同じGraphElement Revisionを共有しなければなりません。",
        );
      }
    });
    const current = canonicalJson(tracePath);
    if (previous !== undefined && compareUnicode(previous, current) > 0) {
      invalid(
        path,
        pathPointer,
        "Trace Reportのpathsがcanonical form順ではありません。",
        "REPORT_ORDER_INVALID",
      );
    }
    previous = current;
  });
}

function validateMissing(missing, path) {
  if (!Array.isArray(missing)) {
    invalid(path, "/missing", "Trace Reportのmissingは一覧でなければなりません。");
  }
  let previous;
  missing.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      invalid(path, `/missing/${index}`, "Trace Reportのmissing項目が不正です。");
    }
    const current = normalizeNfc(value);
    if (previous !== undefined && compareUnicode(previous, current) >= 0) {
      invalid(
        path,
        `/missing/${index}`,
        "Trace Reportのmissingが昇順でないか重複しています。",
        "REPORT_ORDER_INVALID",
      );
    }
    previous = current;
  });
}

export function validateTraceReport(report, path = "") {
  validateFields(
    report,
    TRACE_REPORT_FIELDS,
    TRACE_REPORT_REQUIRED,
    path,
    "",
  );
  if (report.format !== "morivyx.trace-report/0.1") {
    invalid(path, "/format", "Trace Reportの保存形式が不正です。");
  }
  if (Object.hasOwn(report, "id")) {
    requireStableId(report, "id", path, "");
  }
  const queryId = requireString(report, "queryId", path, "");
  if (!TRACE_QUERY_IDS.has(queryId)) {
    invalid(path, "/queryId", `未知のTrace Queryです: ${queryId}`);
  }
  requireGraphRevision(report, "graphRevision", path, "");
  requireDigest(report, "schemaLockDigest", path, "");
  requireStableId(report, "focusId", path, "");
  requireTimestamp(report, "evaluatedAt", path, "");
  const status = requireString(report, "status", path, "");
  if (!TRACE_STATUSES.has(status)) {
    invalid(path, "/status", `未知のTrace Report状態です: ${status}`);
  }
  if (status === "waived") {
    if (!Object.hasOwn(report, "waiverDecisionId")) {
      invalid(
        path,
        "/waiverDecisionId",
        "waivedのTrace Reportには免除Decisionが必要です。",
      );
    }
    requireStableId(report, "waiverDecisionId", path, "");
  } else if (Object.hasOwn(report, "waiverDecisionId")) {
    invalid(
      path,
      "/waiverDecisionId",
      "waived以外のTrace Reportに免除Decisionは指定できません。",
    );
  }
  validateTracePaths(report.paths, report.focusId, path);
  validateMissing(report.missing, path);
  if (status === "complete") {
    if (report.paths.length === 0) {
      invalid(path, "/paths", "completeのTrace Reportには経路が必要です。");
    }
    if (report.missing.length > 0) {
      invalid(path, "/missing", "completeのTrace Reportに欠落は置けません。");
    }
  }
  if (
    (status === "partial" || status === "waived") &&
    report.missing.length === 0
  ) {
    invalid(path, "/missing", `${status}のTrace Reportには欠落が必要です。`);
  }
  return report;
}

function validateDiffEntry(entry, index, path) {
  const pointer = `/entries/${index}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    invalid(path, pointer, "semantic diffのentryは対応表でなければなりません。");
  }
  const kind = requireString(entry, "kind", path, pointer);
  const specificFields = DIFF_ENTRY_FIELDS.get(kind);
  if (!specificFields) {
    invalid(path, `${pointer}/kind`, `未知のsemantic diff種別です: ${kind}`);
  }
  const required = ["kind", "targetId", ...specificFields];
  validateFields(entry, new Set(required), required, path, pointer);
  const targetId = requireString(entry, "targetId", path, pointer);
  if (kind === "schema_changed" && !SCHEMA_ID_PATTERN.test(targetId)) {
    invalid(path, `${pointer}/targetId`, "semantic diffのSchema IDが不正です。");
  }
  if (kind !== "schema_changed" && !STABLE_ID_PATTERN.test(targetId)) {
    invalid(path, `${pointer}/targetId`, "semantic diffの対象stable IDが不正です。");
  }
  for (const field of ["beforeRevision", "afterRevision"]) {
    if (Object.hasOwn(entry, field)) {
      requireDigest(entry, field, path, pointer);
    }
  }
  if (
    Object.hasOwn(entry, "beforeRevision") &&
    Object.hasOwn(entry, "afterRevision") &&
    entry.beforeRevision === entry.afterRevision
  ) {
    invalid(
      path,
      `${pointer}/afterRevision`,
      "semantic diffの前後Revisionは異なる値にしなければなりません。",
    );
  }
  if (Object.hasOwn(entry, "replacementId")) {
    requireStableId(entry, "replacementId", path, pointer);
    if (entry.replacementId === targetId) {
      invalid(
        path,
        `${pointer}/replacementId`,
        "semantic diffの置換先は主対象と異なるstable IDにします。",
      );
    }
  }
  if (kind === "decision_changed") {
    const aspect = requireString(entry, "aspect", path, pointer);
    if (!new Set(["selection", "evidence", "scope"]).has(aspect)) {
      invalid(path, `${pointer}/aspect`, `Decision差分の側面が不正です: ${aspect}`);
    }
  }
  if (kind === "goal_changed") {
    const aspect = requireString(entry, "aspect", path, pointer);
    if (!new Set(["criterion", "achievement"]).has(aspect)) {
      invalid(path, `${pointer}/aspect`, `Goal差分の側面が不正です: ${aspect}`);
    }
  }
  if (kind === "trace_quality_changed") {
    const queryId = requireString(entry, "queryId", path, pointer);
    const beforeStatus = requireString(entry, "beforeStatus", path, pointer);
    const afterStatus = requireString(entry, "afterStatus", path, pointer);
    if (!TRACE_QUERY_IDS.has(queryId)) {
      invalid(path, `${pointer}/queryId`, `未知のTrace Queryです: ${queryId}`);
    }
    if (!TRACE_STATUSES.has(beforeStatus) || !TRACE_STATUSES.has(afterStatus)) {
      invalid(path, pointer, "Trace品質差分の状態が不正です。");
    }
    if (beforeStatus === afterStatus) {
      invalid(
        path,
        `${pointer}/afterStatus`,
        "Trace品質差分の前後状態は異なる値にします。",
      );
    }
  }
}

function validateSemanticDiffEntries(report, path) {
  if (!Array.isArray(report.entries)) {
    invalid(path, "/entries", "semantic diffのentriesは一覧でなければなりません。");
  }
  let previous;
  report.entries.forEach((entry, index) => {
    validateDiffEntry(entry, index, path);
    if (previous !== undefined) {
      const comparison = compareSemanticDiffEntries(previous, entry);
      if (comparison >= 0) {
        invalid(
          path,
          `/entries/${index}`,
          "semantic diffのentriesが昇順でないか、同じ論理順序キーで重複しています。",
          "REPORT_ORDER_INVALID",
        );
      }
    }
    previous = entry;
  });
}

export function validateSemanticDiffReport(report, path = "") {
  validateFields(
    report,
    SEMANTIC_DIFF_FIELDS,
    SEMANTIC_DIFF_REQUIRED,
    path,
    "",
  );
  if (report.format !== "morivyx.semantic-diff/0.1") {
    invalid(path, "/format", "semantic diffの保存形式が不正です。");
  }
  if (Object.hasOwn(report, "id")) {
    requireStableId(report, "id", path, "");
  }
  requireGraphRevision(report, "baseRevision", path, "");
  requireGraphRevision(report, "targetRevision", path, "");
  requireDigest(report, "schemaLockDigest", path, "");
  requireTimestamp(report, "evaluatedAt", path, "");
  validateSemanticDiffEntries(report, path);
  return report;
}

export function validateMigrationSemanticDiffReport(report, path = "") {
  validateFields(
    report,
    MIGRATION_SEMANTIC_DIFF_FIELDS,
    MIGRATION_SEMANTIC_DIFF_REQUIRED,
    path,
    "",
  );
  if (report.format !== "morivyx.migration-semantic-diff/0.1") {
    invalid(path, "/format", "Migration計画差分の保存形式が不正です。");
  }
  if (Object.hasOwn(report, "id")) {
    requireStableId(report, "id", path, "");
  }
  requireGraphRevision(report, "baseRevision", path, "");
  requireGraphRevision(report, "targetRevision", path, "");
  const sourceDigest = requireDigest(
    report,
    "sourceSchemaLockDigest",
    path,
    "",
  );
  const targetDigest = requireDigest(
    report,
    "targetSchemaLockDigest",
    path,
    "",
  );
  if (sourceDigest === targetDigest) {
    invalid(
      path,
      "/targetSchemaLockDigest",
      "Migration計画差分の変換元と変換先のSchema固定情報は異なる値にします。",
    );
  }
  requireTimestamp(report, "evaluatedAt", path, "");
  validateSemanticDiffEntries(report, path);
  if (!report.entries.some(({ kind }) => kind === "schema_changed")) {
    invalid(
      path,
      "/entries",
      "Migration計画差分にはSchema切替を示すentryが必要です。",
      "MIGRATION_SEMANTIC_DIFF_MISMATCH",
    );
  }
  return report;
}

function requireStringOrNull(record, field, path, pointer) {
  if (record[field] === null) {
    return null;
  }
  return requireString(record, field, path, pointer);
}

function validateExternalIdentity(
  identity,
  pointer,
  path,
  { includeLifecycle, allowInvalidValues },
) {
  const fields = includeLifecycle
    ? EXTERNAL_ARTIFACT_IDENTITY_ORDER
    : EXTERNAL_ARTIFACT_IDENTITY_ORDER.filter(
        (field) => field !== "lifecycle",
      );
  validateFields(identity, new Set(fields), fields, path, pointer);
  if (allowInvalidValues) {
    for (const field of fields) {
      requireStringOrNull(identity, field, path, pointer);
    }
    return;
  }
  requireStableId(identity, "id", path, pointer);
  requireDigest(identity, "revision", path, pointer);
  if (includeLifecycle) {
    requireString(identity, "lifecycle", path, pointer);
  }
}

function validateExternalRetrieval(retrieval, reportStatus, path) {
  if (retrieval === null) {
    if (reportStatus !== "invalid") {
      invalid(
        path,
        "/retrieval",
        "invalid以外のexternal Artifact Reportには取得結果が必要です。",
      );
    }
    return;
  }

  if (reportStatus === "invalid") {
    validateFields(
      retrieval,
      new Set(EXTERNAL_ARTIFACT_RETRIEVAL_ORDER),
      ["status", "comparedAt"],
      path,
      "/retrieval",
    );
    for (const field of Object.keys(retrieval)) {
      requireStringOrNull(retrieval, field, path, "/retrieval");
    }
    return;
  }

  const expectedRetrievalStatus =
    reportStatus === "current" || reportStatus === "stale"
      ? "resolved"
      : reportStatus;
  const required = ["status", "comparedAt"];
  const allowed = ["status", "comparedAt"];
  if (expectedRetrievalStatus === "resolved") {
    required.push("digest", "digestRule");
    allowed.push("digest", "digestRule", "externalVersion");
  } else if (expectedRetrievalStatus === "missing") {
    required.push("method");
    allowed.push("method");
  } else if (expectedRetrievalStatus === "unavailable") {
    required.push("reason");
    allowed.push("reason");
  }
  validateFields(
    retrieval,
    new Set(allowed),
    required,
    path,
    "/retrieval",
  );
  const retrievalStatus = requireString(
    retrieval,
    "status",
    path,
    "/retrieval",
  );
  if (
    !EXTERNAL_RETRIEVAL_STATUSES.has(retrievalStatus) ||
    retrievalStatus !== expectedRetrievalStatus
  ) {
    invalid(
      path,
      "/retrieval/status",
      "external Artifact Reportの判定と取得状態が一致しません。",
    );
  }
  requireTimestamp(retrieval, "comparedAt", path, "/retrieval");
  if (retrievalStatus === "resolved") {
    requireDigest(retrieval, "digest", path, "/retrieval");
    requireString(retrieval, "digestRule", path, "/retrieval");
    if (Object.hasOwn(retrieval, "externalVersion")) {
      requireString(retrieval, "externalVersion", path, "/retrieval");
    }
  } else if (retrievalStatus === "missing") {
    requireString(retrieval, "method", path, "/retrieval");
  } else {
    requireString(retrieval, "reason", path, "/retrieval");
  }
}

function validateExternalIssues(issues, reportStatus, path) {
  if (!Array.isArray(issues)) {
    invalid(
      path,
      "/issues",
      "external Artifact Reportのissuesは一覧でなければなりません。",
    );
  }
  let previous = -1;
  const codes = [];
  issues.forEach((issue, index) => {
    const pointer = `/issues/${index}`;
    validateFields(
      issue,
      new Set(EXTERNAL_ARTIFACT_ISSUE_ORDER),
      EXTERNAL_ARTIFACT_ISSUE_ORDER,
      path,
      pointer,
    );
    const code = requireString(issue, "code", path, pointer);
    const position = EXTERNAL_ISSUE_ORDER.indexOf(code);
    if (!EXTERNAL_ISSUES.has(code)) {
      invalid(path, `${pointer}/code`, `未知の外部参照問題コードです: ${code}`);
    }
    if (position <= previous) {
      invalid(
        path,
        pointer,
        "external Artifact Reportのissuesが規定順でないか重複しています。",
        "REPORT_ORDER_INVALID",
      );
    }
    previous = position;
    codes.push(code);
  });

  const allowedByStatus = new Map([
    ["current", new Set()],
    [
      "stale",
      new Set(["EXTERNAL_VERSION_CHANGED", "EXTERNAL_DIGEST_CHANGED"]),
    ],
    ["missing", new Set(["EXTERNAL_TARGET_MISSING"])],
    ["unavailable", new Set(["EXTERNAL_SOURCE_UNAVAILABLE"])],
    [
      "invalid",
      new Set([
        "EXTERNAL_REFERENCE_INCOMPLETE",
        "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
      ]),
    ],
  ]);
  const allowed = allowedByStatus.get(reportStatus);
  if (
    codes.some((code) => !allowed.has(code)) ||
    (reportStatus === "current" && codes.length !== 0) ||
    (reportStatus !== "current" && codes.length === 0)
  ) {
    invalid(
      path,
      "/issues",
      "external Artifact Reportの判定と問題一覧が一致しません。",
    );
  }
}

export function validateExternalArtifactReport(report, path = "") {
  validateFields(
    report,
    EXTERNAL_ARTIFACT_REPORT_FIELDS,
    EXTERNAL_ARTIFACT_REPORT_REQUIRED,
    path,
    "",
  );
  if (report.format !== "morivyx.external-artifact-report/0.1") {
    invalid(
      path,
      "/format",
      "external Artifact Reportの保存形式が不正です。",
    );
  }
  if (Object.hasOwn(report, "id")) {
    requireStableId(report, "id", path, "");
  }
  const status = requireString(report, "status", path, "");
  if (!EXTERNAL_ARTIFACT_STATUSES.has(status)) {
    invalid(path, "/status", `未知の外部参照判定です: ${status}`);
  }
  const allowInvalidValues = status === "invalid";
  if (allowInvalidValues) {
    requireStringOrNull(report, "graphRevision", path, "");
    requireStringOrNull(report, "comparedAt", path, "");
  } else {
    requireGraphRevision(report, "graphRevision", path, "");
    requireTimestamp(report, "comparedAt", path, "");
  }
  validateExternalIdentity(report.artifact, "/artifact", path, {
    includeLifecycle: true,
    allowInvalidValues,
  });
  validateExternalIdentity(report.externalSource, "/externalSource", path, {
    includeLifecycle: false,
    allowInvalidValues,
  });
  validateExternalIdentity(report.relation, "/relation", path, {
    includeLifecycle: false,
    allowInvalidValues,
  });
  validateExternalRetrieval(report.retrieval, status, path);
  if (report.comparedAt !== (report.retrieval?.comparedAt ?? null)) {
    invalid(
      path,
      "/comparedAt",
      "external Artifact Reportの比較時刻が取得結果と一致しません。",
    );
  }
  validateExternalIssues(report.issues, status, path);
  return report;
}

export function validateReport(report, path = "") {
  if (report?.format === "morivyx.trace-report/0.1") {
    return { type: "trace-report", report: validateTraceReport(report, path) };
  }
  if (report?.format === "morivyx.semantic-diff/0.1") {
    return {
      type: "semantic-diff",
      report: validateSemanticDiffReport(report, path),
    };
  }
  if (report?.format === "morivyx.migration-semantic-diff/0.1") {
    return {
      type: "migration-semantic-diff",
      report: validateMigrationSemanticDiffReport(report, path),
    };
  }
  if (report?.format === "morivyx.external-artifact-report/0.1") {
    return {
      type: "external-artifact-report",
      report: validateExternalArtifactReport(report, path),
    };
  }
  invalid(
    path,
    "/format",
    `対応していないReport形式です: ${String(report?.format)}`,
    "REPORT_FORMAT_UNSUPPORTED",
  );
}

function prepareReport(report, idRequired) {
  const validated = validateReport(report);
  if (idRequired && !Object.hasOwn(report, "id")) {
    invalid(
      "",
      "/id",
      "保存するReportにはstable IDが必要です。",
      "REPORT_ID_REQUIRED",
    );
  }
  return {
    ...validated,
    digest: reportDigest(validated.type, validated.report),
    source: serializeYamlRecord(validated.report),
  };
}

function reportDigest(type, report) {
  if (type === "trace-report") {
    return traceReportDigest(report);
  }
  if (type === "semantic-diff") {
    return semanticDiffDigest(report);
  }
  if (type === "migration-semantic-diff") {
    return migrationSemanticDiffDigest(report);
  }
  return externalArtifactReportDigest(report);
}

export function serializeReportYaml(report) {
  return prepareReport(report, false).source;
}

async function metadataDirectory(path) {
  const absolute = resolve(path);
  const directory =
    basename(absolute) === ".morivyx" ? absolute : join(absolute, ".morivyx");
  let information;
  try {
    information = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PackageError(
        "REPORT_PACKAGE_MISSING",
        directory,
        "Reportの保存先となる.morivyxディレクトリがありません。",
      );
    }
    throw error;
  }
  if (!information.isDirectory()) {
    throw new PackageError(
      "REPORT_PACKAGE_MISSING",
      directory,
      "Reportの保存先.morivyxがディレクトリではありません。",
    );
  }
  return directory;
}

async function removeTemporaryFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeReport(path, report) {
  const prepared = prepareReport(report, true);
  const directory = await metadataDirectory(path);
  const reportsDirectory = join(directory, "reports");
  const filename = `${report.id.slice("urn:uuid:".length)}.yaml`;
  const targetPath = join(reportsDirectory, filename);
  return withPackageRecordIdLock(directory, report.id, async () => {
    await assertPackageRecordIdAvailable({
      directory,
      recordType: "report",
      id: report.id,
      targetPath,
      alreadyExistsCode: "REPORT_ALREADY_EXISTS",
      alreadyExistsMessage: "同じstable IDのReportが既に存在します。",
    });
    await ensurePackageRecordDirectory(reportsDirectory);
    const temporaryPath = join(
      reportsDirectory,
      `.report-${process.pid}-${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o644);
    try {
      await handle.writeFile(prepared.source, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await removeTemporaryFile(temporaryPath);
      throw error;
    }
    await handle.close();

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PackageError(
          "REPORT_ALREADY_EXISTS",
          targetPath,
          "同じstable IDのReportが既に存在します。",
        );
      }
      throw error;
    } finally {
      await removeTemporaryFile(temporaryPath);
    }

    return {
      valid: true,
      type: prepared.type,
      digest: prepared.digest,
      path: targetPath,
    };
  });
}

export async function readReport(path) {
  const record = await readYamlRecord(path);
  const { type, report } = validateReport(record, path);
  return {
    valid: true,
    type,
    digest: reportDigest(type, report),
    report,
  };
}
