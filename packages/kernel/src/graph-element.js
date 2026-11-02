import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";

const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[^\s./]+(?:\.[^\s./]+)+$/;
const EXTENSION_KEY_PATTERN = /^[^\s/]+\/[^\s/]+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(["entity", "relation"]);
const REVIEW_STATES = new Set([
  "unreviewed",
  "proposed",
  "approved",
  "rejected",
]);
const ROOT_FIELDS = new Set([
  "format",
  "kind",
  "id",
  "type",
  "typeVersion",
  "revision",
  "lifecycle",
  "reviewState",
  "attributes",
  "provenance",
  "extensions",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(filePath, path, message) {
  throw new PackageError(
    "GRAPH_ELEMENT_INVALID",
    filePath && path ? `${filePath}#${path}` : filePath || path,
    message,
  );
}

function assertText(value, filePath, path) {
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

function assertMap(value, filePath, path, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(filePath, path, `${name}は対応表でなければなりません。`);
  }
}

export function validateGraphElement(element, filePath = "") {
  assertMap(element, filePath, "", "GraphElement");
  for (const key of Object.keys(element)) {
    if (!ROOT_FIELDS.has(key)) {
      invalid(
        filePath,
        pointerChild("", key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
  if (element.format !== "morivyx.git-graph/0.1") {
    invalid(filePath, "/format", "対応していないGraphElement形式です。");
  }
  if (!KINDS.has(element.kind)) {
    invalid(filePath, "/kind", "kindはentityまたはrelationにします。");
  }
  assertStableId(element.id, filePath, "/id");
  if (typeof element.type !== "string" || !TYPE_PATTERN.test(element.type)) {
    invalid(filePath, "/type", "名前空間付き型IDが必要です。");
  }
  for (const field of ["typeVersion", "lifecycle"]) {
    assertText(element[field], filePath, pointerChild("", field));
  }
  if (
    typeof element.revision !== "string" ||
    !REVISION_PATTERN.test(element.revision)
  ) {
    invalid(filePath, "/revision", "小文字のSHA-256 Revision IDが必要です。");
  }
  if (!REVIEW_STATES.has(element.reviewState)) {
    invalid(filePath, "/reviewState", "定義済みのreview stateが必要です。");
  }
  assertMap(element.attributes, filePath, "/attributes", "attributes");
  assertMap(element.provenance, filePath, "/provenance", "ProvenanceRecord");
  assertText(element.provenance.method, filePath, "/provenance/method");
  assertStableId(element.provenance.actor, filePath, "/provenance/actor");
  assertTimestamp(
    element.provenance.recordedAt,
    filePath,
    "/provenance/recordedAt",
  );
  if (Object.hasOwn(element, "extensions")) {
    assertMap(element.extensions, filePath, "/extensions", "extensions");
    for (const key of Object.keys(element.extensions)) {
      if (!EXTENSION_KEY_PATTERN.test(key)) {
        invalid(
          filePath,
          pointerChild("/extensions", key),
          "Extensionには名前空間付きkeyが必要です。",
        );
      }
    }
  }
  return element;
}
