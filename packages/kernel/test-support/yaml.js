import { stringify } from "yaml";

const GRAPH_ELEMENT_ORDER = [
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
];
const PROVENANCE_ORDER = ["method", "actor", "recordedAt"];

function compareUnicode(left, right) {
  const leftPoints = Array.from(left.normalize("NFC"), (value) => value.codePointAt(0));
  const rightPoints = Array.from(right.normalize("NFC"), (value) => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

function sortedMap(value) {
  if (Array.isArray(value)) {
    return value.map(sortedMap);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicode(left, right))
      .map(([key, entry]) => [key, sortedMap(entry)]),
  );
}

function orderedMap(value, order, transform = {}) {
  const known = new Set(order);
  return Object.fromEntries([
    ...order
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, transform[key]?.(value[key]) ?? value[key]]),
    ...Object.entries(value)
      .filter(([key]) => !known.has(key))
      .sort(([left], [right]) => compareUnicode(left, right)),
  ]);
}

function authoringRecord(value) {
  if (value?.format !== "morivyx.git-graph/0.1") {
    return value;
  }
  return orderedMap(value, GRAPH_ELEMENT_ORDER, {
    attributes: sortedMap,
    provenance: (entry) => orderedMap(entry, PROVENANCE_ORDER),
    extensions: sortedMap,
  });
}

export function yaml(value) {
  return stringify(authoringRecord(value), {
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
}
