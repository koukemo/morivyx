import { compareUnicode } from "./canonical.js";
import { PackageError } from "./errors.js";

const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;
const TYPE_ID_PATTERN = /^[^\s./]+(?:\.[^\s./]+)+$/;
const CYCLES = new Set(["allowed", "forbidden", "not_applicable"]);
const ROOT_FIELDS = new Set([
  "format",
  "schemaId",
  "version",
  "stableIdScheme",
  "digestAlgorithm",
  "reviewStates",
  "entityTypes",
  "relationTypes",
  "authoringOrders",
]);
const ENTITY_FIELDS = new Set([
  "typeId",
  "requiredAttributes",
  "optionalAttributes",
  "lifecycle",
]);
const RELATION_FIELDS = new Set([
  "predicate",
  "sourceTypes",
  "targetTypes",
  "minCount",
  "maxCount",
  "cycle",
]);
const AUTHORING_ORDER_FIELDS = new Set([
  "root",
  "attributes",
  "provenance",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(filePath, pointer, message) {
  throw new PackageError(
    "SCHEMA_DEFINITION_INVALID",
    filePath && pointer ? `${filePath}#${pointer}` : filePath || pointer,
    message,
  );
}

function assertMap(value, filePath, pointer, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(filePath, pointer, `${name}は対応表でなければなりません。`);
  }
}

function assertFields(record, fields, filePath, pointer) {
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) {
      invalid(
        filePath,
        pointerChild(pointer, key),
        `定義されていない項目です: ${key}`,
      );
    }
  }
}

function assertText(value, filePath, pointer, message = "空でない文字列が必要です。") {
  if (typeof value !== "string" || value.length === 0) {
    invalid(filePath, pointer, message);
  }
}

function assertStringSet(
  value,
  filePath,
  pointer,
  { allowEmpty = true, itemPattern } = {},
) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(
      filePath,
      pointer,
      allowEmpty
        ? "文字列の一覧が必要です。"
        : "空でない文字列の一覧が必要です。",
    );
  }
  let previous;
  value.forEach((item, index) => {
    const itemPointer = `${pointer}/${index}`;
    assertText(item, filePath, itemPointer);
    if (itemPattern && !itemPattern.test(item)) {
      invalid(filePath, itemPointer, "名前空間付きIDが必要です。");
    }
    const current = item.normalize("NFC");
    if (previous !== undefined && compareUnicode(previous, current) >= 0) {
      invalid(
        filePath,
        itemPointer,
        "一覧はNFC正規化後のUnicode昇順かつ重複なしにします。",
      );
    }
    previous = current;
  });
}

function assertSortedEntries(value, filePath, pointer, key, validateEntry) {
  if (!Array.isArray(value)) {
    invalid(filePath, pointer, "一覧が必要です。");
  }
  let previous;
  value.forEach((entry, index) => {
    const entryPointer = `${pointer}/${index}`;
    validateEntry(entry, entryPointer);
    const current = entry[key].normalize("NFC");
    if (previous !== undefined && compareUnicode(previous, current) >= 0) {
      invalid(
        filePath,
        `${entryPointer}/${key}`,
        `${key}のUnicode昇順かつ重複なしにします。`,
      );
    }
    previous = current;
  });
}

function validateEntityType(entityType, filePath, pointer) {
  assertMap(entityType, filePath, pointer, "Entity型");
  assertFields(entityType, ENTITY_FIELDS, filePath, pointer);
  if (
    typeof entityType.typeId !== "string" ||
    !TYPE_ID_PATTERN.test(entityType.typeId)
  ) {
    invalid(filePath, `${pointer}/typeId`, "名前空間付き型IDが必要です。");
  }
  assertStringSet(
    entityType.requiredAttributes,
    filePath,
    `${pointer}/requiredAttributes`,
  );
  if (Object.hasOwn(entityType, "optionalAttributes")) {
    assertStringSet(
      entityType.optionalAttributes,
      filePath,
      `${pointer}/optionalAttributes`,
      { allowEmpty: false },
    );
    const required = new Set(
      entityType.requiredAttributes.map((value) => value.normalize("NFC")),
    );
    entityType.optionalAttributes.forEach((value, index) => {
      if (required.has(value.normalize("NFC"))) {
        invalid(
          filePath,
          `${pointer}/optionalAttributes/${index}`,
          "必須属性と任意属性は重複できません。",
        );
      }
    });
  }
  assertStringSet(entityType.lifecycle, filePath, `${pointer}/lifecycle`, {
    allowEmpty: false,
  });
}

function validateRelationType(relationType, filePath, pointer) {
  assertMap(relationType, filePath, pointer, "Relation型");
  assertFields(relationType, RELATION_FIELDS, filePath, pointer);
  assertText(relationType.predicate, filePath, `${pointer}/predicate`);
  assertStringSet(relationType.sourceTypes, filePath, `${pointer}/sourceTypes`, {
    allowEmpty: false,
    itemPattern: TYPE_ID_PATTERN,
  });
  assertStringSet(relationType.targetTypes, filePath, `${pointer}/targetTypes`, {
    allowEmpty: false,
    itemPattern: TYPE_ID_PATTERN,
  });
  if (!Number.isSafeInteger(relationType.minCount) || relationType.minCount < 0) {
    invalid(filePath, `${pointer}/minCount`, "0以上の安全な整数が必要です。");
  }
  if (
    relationType.maxCount !== null &&
    (!Number.isSafeInteger(relationType.maxCount) ||
      relationType.maxCount < relationType.minCount)
  ) {
    invalid(
      filePath,
      `${pointer}/maxCount`,
      "nullまたはminCount以上の安全な整数が必要です。",
    );
  }
  if (!CYCLES.has(relationType.cycle)) {
    invalid(filePath, `${pointer}/cycle`, "定義済みのcycle値が必要です。");
  }
}

function validateAuthoringOrders(authoringOrders, filePath) {
  assertMap(authoringOrders, filePath, "/authoringOrders", "authoringOrders");
  assertFields(
    authoringOrders,
    AUTHORING_ORDER_FIELDS,
    filePath,
    "/authoringOrders",
  );
  for (const field of AUTHORING_ORDER_FIELDS) {
    const values = authoringOrders[field];
    const pointer = `/authoringOrders/${field}`;
    if (!Array.isArray(values) || (field !== "attributes" && values.length === 0)) {
      invalid(filePath, pointer, "項目名の一覧が必要です。");
    }
    const seen = new Set();
    values.forEach((value, index) => {
      assertText(value, filePath, `${pointer}/${index}`);
      const normalized = value.normalize("NFC");
      if (seen.has(normalized)) {
        invalid(
          filePath,
          `${pointer}/${index}`,
          "authoring orderの項目名は重複できません。",
        );
      }
      seen.add(normalized);
    });
  }
}

export function validateSchemaDefinition(definition, filePath = "") {
  assertMap(definition, filePath, "", "Schema定義");
  assertFields(definition, ROOT_FIELDS, filePath, "");
  if (definition.format !== "morivyx.schema/0.1") {
    invalid(filePath, "/format", "対応していないSchema定義形式です。");
  }
  if (
    typeof definition.schemaId !== "string" ||
    !SCHEMA_ID_PATTERN.test(definition.schemaId)
  ) {
    invalid(filePath, "/schemaId", "名前空間付きSchema IDが必要です。");
  }
  if (
    typeof definition.version !== "string" ||
    !VERSION_PATTERN.test(definition.version)
  ) {
    invalid(filePath, "/version", "数字を点で区切ったversionが必要です。");
  }
  if (definition.stableIdScheme !== "urn-uuid-v4") {
    invalid(filePath, "/stableIdScheme", "Stage 1はurn-uuid-v4だけを受け入れます。");
  }
  if (definition.digestAlgorithm !== "sha256") {
    invalid(filePath, "/digestAlgorithm", "Stage 1はsha256だけを受け入れます。");
  }
  assertStringSet(definition.reviewStates, filePath, "/reviewStates", {
    allowEmpty: false,
  });
  assertSortedEntries(
    definition.entityTypes,
    filePath,
    "/entityTypes",
    "typeId",
    (entry, pointer) => validateEntityType(entry, filePath, pointer),
  );
  assertSortedEntries(
    definition.relationTypes,
    filePath,
    "/relationTypes",
    "predicate",
    (entry, pointer) => validateRelationType(entry, filePath, pointer),
  );
  validateAuthoringOrders(definition.authoringOrders, filePath);
  return definition;
}
