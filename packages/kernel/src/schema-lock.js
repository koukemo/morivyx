import { compareUnicode } from "./canonical.js";
import { PackageError } from "./errors.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROOT_FIELDS = new Set([
  "format",
  "stableIdScheme",
  "digestAlgorithm",
  "schemas",
]);
const ENTRY_FIELDS = new Set(["schemaId", "version", "digest"]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function issuePath(filePath, pointer) {
  return filePath && pointer ? `${filePath}#${pointer}` : filePath || pointer;
}

function invalid(code, filePath, pointer, message) {
  throw new PackageError(code, issuePath(filePath, pointer), message);
}

function assertFields(record, fields, filePath, pointer) {
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) {
      invalid(
        "SCHEMA_LOCK_INVALID",
        filePath,
        pointerChild(pointer, key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
}

function assertText(value, filePath, pointer) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(
      "SCHEMA_LOCK_INVALID",
      filePath,
      pointer,
      "空でない文字列が必要です。",
    );
  }
}

export function validateSchemaLock(schemaLock, filePath = "") {
  if (!schemaLock || typeof schemaLock !== "object" || Array.isArray(schemaLock)) {
    invalid(
      "SCHEMA_LOCK_INVALID",
      filePath,
      "",
      "Schema lockは対応表でなければなりません。",
    );
  }
  assertFields(schemaLock, ROOT_FIELDS, filePath, "");
  if (schemaLock.format !== "morivyx.schema-lock/0.1") {
    invalid(
      "PACKAGE_FORMAT_UNSUPPORTED",
      filePath,
      "/format",
      `対応していない保存形式です: ${String(schemaLock.format)}`,
    );
  }
  if (schemaLock.stableIdScheme !== "urn-uuid-v4") {
    invalid(
      "STABLE_ID_SCHEME_UNSUPPORTED",
      filePath,
      "/stableIdScheme",
      "Stage 1 は urn-uuid-v4 だけを受け入れます。",
    );
  }
  if (schemaLock.digestAlgorithm !== "sha256") {
    invalid(
      "DIGEST_ALGORITHM_UNSUPPORTED",
      filePath,
      "/digestAlgorithm",
      "Stage 1 は sha256 だけを受け入れます。",
    );
  }
  if (!Array.isArray(schemaLock.schemas)) {
    invalid(
      "SCHEMA_LOCK_INVALID",
      filePath,
      "/schemas",
      "Schema固定情報のschemasは一覧でなければなりません。",
    );
  }

  let previous;
  schemaLock.schemas.forEach((schema, index) => {
    const pointer = `/schemas/${index}`;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      invalid(
        "SCHEMA_LOCK_INVALID",
        filePath,
        pointer,
        "Schema固定情報の各要素は対応表でなければなりません。",
      );
    }
    assertFields(schema, ENTRY_FIELDS, filePath, pointer);
    assertText(schema.schemaId, filePath, `${pointer}/schemaId`);
    assertText(schema.version, filePath, `${pointer}/version`);
    if (typeof schema.digest !== "string" || !DIGEST_PATTERN.test(schema.digest)) {
      invalid(
        "SCHEMA_LOCK_INVALID",
        filePath,
        `${pointer}/digest`,
        "小文字のSHA-256 digestが必要です。",
      );
    }
    const current = [
      schema.schemaId.normalize("NFC"),
      schema.version.normalize("NFC"),
    ];
    if (
      previous &&
      (compareUnicode(previous[0], current[0]) > 0 ||
        (previous[0] === current[0] &&
          compareUnicode(previous[1], current[1]) >= 0))
    ) {
      invalid(
        "SCHEMA_LOCK_ORDER_INVALID",
        filePath,
        pointer,
        "Schema固定情報の一覧が昇順でないか、重複しています。",
      );
    }
    previous = current;
  });
  return schemaLock;
}
