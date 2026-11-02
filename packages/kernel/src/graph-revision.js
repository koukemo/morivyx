import { PackageError } from "./errors.js";

const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROOT_FIELDS = new Set([
  "format",
  "id",
  "parentRevision",
  "rootDigest",
  "schemaLockDigest",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(filePath, path, message) {
  throw new PackageError(
    "GRAPH_REVISION_INVALID",
    filePath && path ? `${filePath}#${path}` : filePath || path,
    message,
  );
}

function assertGraphRevisionId(value, filePath, path) {
  if (typeof value !== "string" || !GRAPH_REVISION_PATTERN.test(value)) {
    invalid(filePath, path, "graph:で始まるGraphRevision IDが必要です。");
  }
}

function assertDigest(value, filePath, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    invalid(filePath, path, "小文字のSHA-256 digestが必要です。");
  }
}

export function validateGraphRevision(revision, filePath = "") {
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
    invalid(filePath, "", "GraphRevisionは対応表でなければなりません。");
  }
  for (const key of Object.keys(revision)) {
    if (!ROOT_FIELDS.has(key)) {
      invalid(
        filePath,
        pointerChild("", key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
  if (revision.format !== "morivyx.graph-revision/0.1") {
    invalid(filePath, "/format", "対応していないGraphRevision形式です。");
  }
  assertGraphRevisionId(revision.id, filePath, "/id");
  if (revision.parentRevision !== null) {
    assertGraphRevisionId(revision.parentRevision, filePath, "/parentRevision");
    if (revision.parentRevision === revision.id) {
      invalid(
        filePath,
        "/parentRevision",
        "GraphRevisionは自分自身をparentにできません。",
      );
    }
  }
  assertDigest(revision.rootDigest, filePath, "/rootDigest");
  assertDigest(revision.schemaLockDigest, filePath, "/schemaLockDigest");
  return revision;
}
