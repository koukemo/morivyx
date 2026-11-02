import { normalizeNfc } from "./unicode-nfc.js";
import { isMap, isPair, isScalar, isSeq } from "yaml";
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

function invalidOrder(path, message) {
  throw new PackageError("PACKAGE_AUTHORING_ORDER_INVALID", path, message);
}

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function mapPair(node, key) {
  if (!isMap(node)) {
    return undefined;
  }
  return node.items.find(
    (pair) =>
      isPair(pair) &&
      isScalar(pair.key) &&
      typeof pair.key.value === "string" &&
      normalizeNfc(pair.key.value) === key,
  );
}

function mapKeys(node) {
  if (!isMap(node)) {
    return [];
  }
  return node.items.map((pair) => normalizeNfc(pair.key.value));
}

function compareUnicode(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

function validateKnownOrder(node, expected, path) {
  const positions = new Map(expected.map((key, index) => [key, index]));
  let previous = -1;
  for (const key of mapKeys(node)) {
    const position = positions.get(key);
    if (position === undefined) {
      continue;
    }
    if (position <= previous) {
      invalidOrder(
        pointerChild(path, key),
        `既知項目の順序が authoringOrder と一致しません: ${key}`,
      );
    }
    previous = position;
  }
}

function validatePrefixedOrder(node, expected, path) {
  const positions = new Map(expected.map((key, index) => [key, index]));
  let previousKnown = -1;
  let previousUnknown;
  let foundUnknown = false;
  for (const key of mapKeys(node)) {
    const position = positions.get(key);
    if (position !== undefined) {
      if (foundUnknown || position <= previousKnown) {
        invalidOrder(
          pointerChild(path, key),
          `既知項目の順序が authoringOrder と一致しません: ${key}`,
        );
      }
      previousKnown = position;
      continue;
    }
    foundUnknown = true;
    if (previousUnknown !== undefined && compareUnicode(previousUnknown, key) >= 0) {
      invalidOrder(
        pointerChild(path, key),
        `追加項目が Unicode 符号位置の昇順ではありません: ${key}`,
      );
    }
    previousUnknown = key;
  }
}

function validateSortedMap(node, path) {
  if (!isMap(node)) {
    return;
  }
  let previous;
  for (const key of mapKeys(node)) {
    if (previous !== undefined && compareUnicode(previous, key) >= 0) {
      invalidOrder(
        pointerChild(path, key),
        `対応表が Unicode 符号位置の昇順ではありません: ${key}`,
      );
    }
    previous = key;
  }
}

function validateUnknownMapOrder(node, path) {
  if (isSeq(node)) {
    node.items.forEach((item, index) =>
      validateUnknownMapOrder(item, pointerChild(path, index)),
    );
    return;
  }
  if (!isMap(node)) {
    return;
  }
  validateSortedMap(node, path);
  for (const pair of node.items) {
    const key = normalizeNfc(pair.key.value);
    validateUnknownMapOrder(pair.value, pointerChild(path, key));
  }
}

function validateSequenceEntryOrder(root, key, expected, path) {
  const sequence = mapPair(root, key)?.value;
  if (!isSeq(sequence)) {
    return;
  }
  sequence.items.forEach((entry, index) => {
    if (isMap(entry)) {
      validateKnownOrder(entry, expected, pointerChild(pointerChild(path, key), index));
    }
  });
}

export function validateYamlAuthoringOrder(document) {
  const root = document.contents;
  if (!isMap(root)) {
    return;
  }
  const format = mapPair(root, "format")?.value?.value;
  if (format === "morivyx.git-graph/0.1") {
    validateKnownOrder(root, GRAPH_ELEMENT_ORDER, "");
    validateSortedMap(mapPair(root, "attributes")?.value, "/attributes");
    validatePrefixedOrder(
      mapPair(root, "provenance")?.value,
      PROVENANCE_ORDER,
      "/provenance",
    );
    validateUnknownMapOrder(mapPair(root, "extensions")?.value, "/extensions");
    return;
  }
  if (format === "morivyx.decision-creation-request/0.1") {
    validateKnownOrder(root, DECISION_CREATION_REQUEST_ORDER, "");
    validateSortedMap(mapPair(root, "attributes")?.value, "/attributes");
    return;
  }
  if (format === "morivyx.decision-revision-request/0.1") {
    validateKnownOrder(root, DECISION_REVISION_REQUEST_ORDER, "");
    validateSortedMap(mapPair(root, "attributes")?.value, "/attributes");
    return;
  }
  if (format === "morivyx.schema-lock/0.1") {
    validateKnownOrder(root, SCHEMA_LOCK_ORDER, "");
    validateSequenceEntryOrder(root, "schemas", SCHEMA_LOCK_ENTRY_ORDER, "");
    return;
  }
  if (format === "morivyx.graph-revision/0.1") {
    validateKnownOrder(root, GRAPH_REVISION_ORDER, "");
    return;
  }
  if (format === "morivyx.approval/0.1") {
    validateKnownOrder(root, APPROVAL_ORDER, "");
    return;
  }
  if (format === "morivyx.changeset/0.1") {
    validateKnownOrder(root, CHANGESET_ORDER, "");
    validateSequenceEntryOrder(
      root,
      "operations",
      CHANGESET_OPERATION_ORDER,
      "",
    );
    validatePrefixedOrder(
      mapPair(root, "provenance")?.value,
      PROVENANCE_ORDER,
      "/provenance",
    );
    return;
  }
  if (format === "morivyx.migration/0.1") {
    validateKnownOrder(root, MIGRATION_ORDER, "");
    validatePrefixedOrder(
      mapPair(root, "provenance")?.value,
      PROVENANCE_ORDER,
      "/provenance",
    );
    return;
  }
  if (format === "morivyx.trace-report/0.1") {
    validateKnownOrder(root, TRACE_REPORT_ORDER, "");
    validateSequenceEntryOrder(root, "paths", TRACE_PATH_ORDER, "");
    const paths = mapPair(root, "paths")?.value;
    if (isSeq(paths)) {
      paths.items.forEach((path, index) =>
        validateSequenceEntryOrder(
          path,
          "hops",
          TRACE_HOP_ORDER,
          pointerChild("/paths", index),
        ),
      );
    }
    return;
  }
  if (format === "morivyx.semantic-diff/0.1") {
    validateKnownOrder(root, SEMANTIC_DIFF_ORDER, "");
    validateSequenceEntryOrder(
      root,
      "entries",
      SEMANTIC_DIFF_ENTRY_ORDER,
      "",
    );
    return;
  }
  if (format === "morivyx.migration-semantic-diff/0.1") {
    validateKnownOrder(root, MIGRATION_SEMANTIC_DIFF_ORDER, "");
    validateSequenceEntryOrder(
      root,
      "entries",
      SEMANTIC_DIFF_ENTRY_ORDER,
      "",
    );
    return;
  }
  if (format === "morivyx.external-artifact-report/0.1") {
    validateKnownOrder(root, EXTERNAL_ARTIFACT_REPORT_ORDER, "");
    for (const key of ["artifact", "externalSource", "relation"]) {
      validateKnownOrder(
        mapPair(root, key)?.value,
        EXTERNAL_ARTIFACT_IDENTITY_ORDER,
        pointerChild("", key),
      );
    }
    validateKnownOrder(
      mapPair(root, "retrieval")?.value,
      EXTERNAL_ARTIFACT_RETRIEVAL_ORDER,
      "/retrieval",
    );
    validateSequenceEntryOrder(
      root,
      "issues",
      EXTERNAL_ARTIFACT_ISSUE_ORDER,
      "",
    );
    return;
  }
  if (format === "morivyx.schema/0.1") {
    validateKnownOrder(root, SCHEMA_DEFINITION_ORDER, "");
    validateSequenceEntryOrder(root, "entityTypes", ENTITY_TYPE_ORDER, "");
    validateSequenceEntryOrder(root, "relationTypes", RELATION_TYPE_ORDER, "");
    validateKnownOrder(
      mapPair(root, "authoringOrders")?.value,
      AUTHORING_ORDERS_ORDER,
      "/authoringOrders",
    );
  }
}
