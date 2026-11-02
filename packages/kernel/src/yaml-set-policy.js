import { isMap, isPair, isScalar, isSeq } from "yaml";
import { PackageError } from "./errors.js";

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function mapPair(node, key) {
  return node.items.find(
    (pair) =>
      isPair(pair) && isScalar(pair.key) && pair.key.value.normalize("NFC") === key,
  );
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

function scalarString(node) {
  return isScalar(node) && typeof node.value === "string"
    ? node.value.normalize("NFC")
    : undefined;
}

function invalid(path, current, previous) {
  const reason = current === previous ? "重複しています" : "昇順ではありません";
  throw new PackageError(
    "PACKAGE_SET_ORDER_INVALID",
    path,
    `集合として定義した一覧が${reason}: ${current}`,
  );
}

function validateStringSet(sequence, path) {
  if (!isSeq(sequence)) {
    return;
  }
  let previous;
  sequence.items.forEach((item, index) => {
    const current = scalarString(item);
    if (current === undefined) {
      return;
    }
    if (previous !== undefined && compareUnicode(previous, current) >= 0) {
      invalid(pointerChild(path, index), current, previous);
    }
    previous = current;
  });
}

function validateNestedStringSets(entry, keys, path) {
  for (const key of keys) {
    validateStringSet(mapPair(entry, key)?.value, pointerChild(path, key));
  }
}

function validateMapSet(sequence, identityKey, nestedKeys, path) {
  if (!isSeq(sequence)) {
    return;
  }
  let previous;
  sequence.items.forEach((entry, index) => {
    if (!isMap(entry)) {
      return;
    }
    const entryPath = pointerChild(path, index);
    const current = scalarString(mapPair(entry, identityKey)?.value);
    if (
      current !== undefined &&
      previous !== undefined &&
      compareUnicode(previous, current) >= 0
    ) {
      invalid(pointerChild(entryPath, identityKey), current, previous);
    }
    if (current !== undefined) {
      previous = current;
    }
    validateNestedStringSets(entry, nestedKeys, entryPath);
  });
}

export function validateYamlSetPolicy(document) {
  const root = document.contents;
  if (!isMap(root)) {
    return;
  }
  const format = mapPair(root, "format")?.value?.value;
  if (format === "morivyx.trace-report/0.1") {
    validateStringSet(mapPair(root, "missing")?.value, "/missing");
    return;
  }
  if (format !== "morivyx.schema/0.1") {
    return;
  }
  validateStringSet(mapPair(root, "reviewStates")?.value, "/reviewStates");
  validateMapSet(
    mapPair(root, "entityTypes")?.value,
    "typeId",
    ["requiredAttributes", "optionalAttributes", "lifecycle"],
    "/entityTypes",
  );
  validateMapSet(
    mapPair(root, "relationTypes")?.value,
    "predicate",
    ["sourceTypes", "targetTypes"],
    "/relationTypes",
  );
}
