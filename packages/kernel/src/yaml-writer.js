import { stringify } from "yaml";
import { canonicalJson, compareUnicode } from "./canonical.js";
import { PackageError } from "./errors.js";
import {
  APPROVAL_ORDER,
  AUTHORING_ORDERS_ORDER,
  CHANGESET_OPERATION_ORDER,
  CHANGESET_ORDER,
  DECISION_CREATION_REQUEST_ORDER,
  DECISION_REVISION_REQUEST_ORDER,
  ENTITY_TYPE_ORDER,
  EXTERNAL_ARTIFACT_IDENTITY_ORDER,
  EXTERNAL_ARTIFACT_ISSUE_ORDER,
  EXTERNAL_ARTIFACT_REPORT_ORDER,
  EXTERNAL_ARTIFACT_RETRIEVAL_ORDER,
  GRAPH_ELEMENT_ORDER,
  GRAPH_REVISION_ORDER,
  MIGRATION_SEMANTIC_DIFF_ORDER,
  MIGRATION_ORDER,
  PROVENANCE_ORDER,
  RELATION_TYPE_ORDER,
  SCHEMA_DEFINITION_ORDER,
  SCHEMA_LOCK_ENTRY_ORDER,
  SCHEMA_LOCK_ORDER,
  SEMANTIC_DIFF_ENTRY_ORDER,
  SEMANTIC_DIFF_ORDER,
  TRACE_HOP_ORDER,
  TRACE_PATH_ORDER,
  TRACE_REPORT_ORDER,
} from "./yaml-record-order.js";
import { isYamlNullAllowed } from "./yaml-null-policy.js";

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function invalid(path, message) {
  throw new PackageError("YAML_SERIALIZATION_INVALID", path, message);
}

function assertUnicodeString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        invalid(path, "単独surrogateを含む文字列はYAMLへ変換できません。");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid(path, "単独surrogateを含む文字列はYAMLへ変換できません。");
    }
  }
}

function validateLogicalStructure(value, path = "", activeValues = new Set()) {
  if (typeof value === "string") {
    assertUnicodeString(value, path);
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (activeValues.has(value)) {
    invalid(path, "循環参照を含む値はYAMLへ変換できません。");
  }
  activeValues.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        invalid(path, "疎配列または追加propertyはYAMLへ変換できません。");
      }
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = pointerChild(path, index);
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value")
        ) {
          invalid(
            itemPath,
            "列挙可能なdata property以外の配列要素はYAMLへ変換できません。",
          );
        }
        validateLogicalStructure(descriptor.value, itemPath, activeValues);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(path, "論理値の対応表ではないobjectはYAMLへ変換できません。");
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value")
      ) {
        invalid(
          path,
          "列挙可能な文字列data property以外はYAMLへ変換できません。",
        );
      }
      assertUnicodeString(key, path);
      const childPath = pointerChild(path, key);
      validateLogicalStructure(descriptor.value, childPath, activeValues);
    }
  } finally {
    activeValues.delete(value);
  }
}

function validateLogicalNullPolicy(value, format, rootStatus, path = "") {
  if (value === null) {
    if (!isYamlNullAllowed(format, path, rootStatus)) {
      invalid(path, "Schema が許可しない位置に null があります。");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateLogicalNullPolicy(
        item,
        format,
        rootStatus,
        pointerChild(path, index),
      ),
    );
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [rawKey, entryValue] of Object.entries(value)) {
    const key = rawKey.normalize("NFC");
    validateLogicalNullPolicy(
      entryValue,
      format,
      rootStatus,
      pointerChild(path, key),
    );
  }
}

function normalizedEntries(value, path) {
  const entries = [];
  const keys = new Set();
  for (const [rawKey, entryValue] of Object.entries(value)) {
    const key = rawKey.normalize("NFC");
    if (keys.has(key)) {
      invalid(
        pointerChild(path, key),
        `NFC正規化後に重複する項目はYAMLへ変換できません: ${key}`,
      );
    }
    keys.add(key);
    entries.push([key, entryValue]);
  }
  return entries;
}

function normalizeValue(value, path) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeValue(entry, pointerChild(path, index)),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      normalizedEntries(value, path)
        .sort(([left], [right]) => compareUnicode(left, right))
        .map(([key, entryValue]) => [
          key,
          normalizeValue(entryValue, pointerChild(path, key)),
        ]),
    );
  }
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    invalid(path, `YAMLへ変換できない値です: ${error.message}`);
  }
}

function orderedRecord(record, order, path = "", transforms = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    invalid(path, "記録は対応表でなければなりません。");
  }
  const positions = new Map(order.map((key, index) => [key, index]));
  const entries = normalizedEntries(record, path).sort(([left], [right]) => {
    const leftPosition = positions.get(left);
    const rightPosition = positions.get(right);
    if (leftPosition !== undefined && rightPosition !== undefined) {
      return leftPosition - rightPosition;
    }
    if (leftPosition !== undefined) {
      return -1;
    }
    if (rightPosition !== undefined) {
      return 1;
    }
    return compareUnicode(left, right);
  });
  return Object.fromEntries(
    entries.map(([key, value]) => {
      const childPath = pointerChild(path, key);
      return [
        key,
        Object.hasOwn(transforms, key)
          ? transforms[key](value, childPath)
          : normalizeValue(value, childPath),
      ];
    }),
  );
}

function orderedSequence(value, order, path, transforms = {}) {
  if (!Array.isArray(value)) {
    invalid(path, "記録の集合は配列でなければなりません。");
  }
  return value.map((entry, index) =>
    orderedRecord(entry, order, pointerChild(path, index), transforms),
  );
}

const RECORD_WRITERS = new Map([
  [
    "morivyx.decision-creation-request/0.1",
    (record) => orderedRecord(record, DECISION_CREATION_REQUEST_ORDER),
  ],
  [
    "morivyx.decision-revision-request/0.1",
    (record) => orderedRecord(record, DECISION_REVISION_REQUEST_ORDER),
  ],
  [
    "morivyx.git-graph/0.1",
    (record) =>
      orderedRecord(record, GRAPH_ELEMENT_ORDER, "", {
        provenance: (value, path) =>
          orderedRecord(value, PROVENANCE_ORDER, path),
      }),
  ],
  [
    "morivyx.schema-lock/0.1",
    (record) =>
      orderedRecord(record, SCHEMA_LOCK_ORDER, "", {
        schemas: (value, path) =>
          orderedSequence(value, SCHEMA_LOCK_ENTRY_ORDER, path),
      }),
  ],
  [
    "morivyx.graph-revision/0.1",
    (record) => orderedRecord(record, GRAPH_REVISION_ORDER),
  ],
  [
    "morivyx.approval/0.1",
    (record) => orderedRecord(record, APPROVAL_ORDER),
  ],
  [
    "morivyx.schema/0.1",
    (record) =>
      orderedRecord(record, SCHEMA_DEFINITION_ORDER, "", {
        entityTypes: (value, path) =>
          orderedSequence(value, ENTITY_TYPE_ORDER, path),
        relationTypes: (value, path) =>
          orderedSequence(value, RELATION_TYPE_ORDER, path),
        authoringOrders: (value, path) =>
          orderedRecord(value, AUTHORING_ORDERS_ORDER, path),
      }),
  ],
  [
    "morivyx.changeset/0.1",
    (record) =>
      orderedRecord(record, CHANGESET_ORDER, "", {
        operations: (value, path) =>
          orderedSequence(value, CHANGESET_OPERATION_ORDER, path),
        provenance: (value, path) =>
          orderedRecord(value, PROVENANCE_ORDER, path),
      }),
  ],
  [
    "morivyx.migration/0.1",
    (record) =>
      orderedRecord(record, MIGRATION_ORDER, "", {
        provenance: (value, path) =>
          orderedRecord(value, PROVENANCE_ORDER, path),
      }),
  ],
  [
    "morivyx.trace-report/0.1",
    (record) =>
      orderedRecord(record, TRACE_REPORT_ORDER, "", {
        paths: (value, path) =>
          orderedSequence(value, TRACE_PATH_ORDER, path, {
            hops: (hops, hopsPath) =>
              orderedSequence(hops, TRACE_HOP_ORDER, hopsPath),
          }),
      }),
  ],
  [
    "morivyx.semantic-diff/0.1",
    (record) =>
      orderedRecord(record, SEMANTIC_DIFF_ORDER, "", {
        entries: (value, path) =>
          orderedSequence(value, SEMANTIC_DIFF_ENTRY_ORDER, path),
      }),
  ],
  [
    "morivyx.migration-semantic-diff/0.1",
    (record) =>
      orderedRecord(record, MIGRATION_SEMANTIC_DIFF_ORDER, "", {
        entries: (value, path) =>
          orderedSequence(value, SEMANTIC_DIFF_ENTRY_ORDER, path),
      }),
  ],
  [
    "morivyx.external-artifact-report/0.1",
    (record) =>
      orderedRecord(record, EXTERNAL_ARTIFACT_REPORT_ORDER, "", {
        artifact: (value, path) =>
          orderedRecord(value, EXTERNAL_ARTIFACT_IDENTITY_ORDER, path),
        externalSource: (value, path) =>
          orderedRecord(value, EXTERNAL_ARTIFACT_IDENTITY_ORDER, path),
        relation: (value, path) =>
          orderedRecord(value, EXTERNAL_ARTIFACT_IDENTITY_ORDER, path),
        retrieval: (value, path) =>
          value === null
            ? null
            : orderedRecord(value, EXTERNAL_ARTIFACT_RETRIEVAL_ORDER, path),
        issues: (value, path) =>
          orderedSequence(value, EXTERNAL_ARTIFACT_ISSUE_ORDER, path),
      }),
  ],
]);

export function serializeYamlRecord(record) {
  try {
    validateLogicalStructure(record);
    const format = record?.format?.normalize?.("NFC");
    const writer = RECORD_WRITERS.get(format);
    if (!writer) {
      throw new PackageError(
        "PACKAGE_FORMAT_UNSUPPORTED",
        "/format",
        `対応していない記録形式です: ${String(record?.format)}`,
      );
    }
    validateLogicalNullPolicy(record, format, record.status);
    return stringify(writer(record), {
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
      lineWidth: 0,
    });
  } catch (error) {
    if (error instanceof PackageError) {
      throw error;
    }
    invalid(
      "",
      `YAMLへの変換に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
