import { normalizeNfc } from "./unicode-nfc.js";
import { isMap, isPair, isScalar, isSeq } from "yaml";
import { PackageError } from "./errors.js";

const KNOWN_FORMATS = new Set([
  "morivyx.git-graph/0.1",
  "morivyx.decision-creation-request/0.1",
  "morivyx.decision-revision-request/0.1",
  "morivyx.schema-lock/0.1",
  "morivyx.graph-revision/0.1",
  "morivyx.approval/0.1",
  "morivyx.schema/0.1",
  "morivyx.changeset/0.1",
  "morivyx.migration/0.1",
  "morivyx.trace-report/0.1",
  "morivyx.semantic-diff/0.1",
  "morivyx.migration-semantic-diff/0.1",
  "morivyx.external-artifact-report/0.1",
]);

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function rootFormat(root) {
  if (!isMap(root)) {
    return undefined;
  }
  const pair = root.items.find(
    (entry) => isPair(entry) && isScalar(entry.key) && entry.key.value === "format",
  );
  return isScalar(pair?.value) ? pair.value.value : undefined;
}

function rootValue(root, key) {
  const pair = root.items.find(
    (entry) =>
      isPair(entry) && isScalar(entry.key) && entry.key.value === key,
  );
  return isScalar(pair?.value) ? pair.value.value : undefined;
}

export function isYamlNullAllowed(format, path, rootStatus) {
  if (format === "morivyx.graph-revision/0.1") {
    return path === "/parentRevision";
  }
  if (format === "morivyx.schema/0.1") {
    return /^\/relationTypes\/\d+\/maxCount$/.test(path);
  }
  if (format === "morivyx.git-graph/0.1") {
    return path.startsWith("/extensions/");
  }
  if (
    format === "morivyx.external-artifact-report/0.1" &&
    rootStatus === "invalid"
  ) {
    return (
      path === "/graphRevision" ||
      path === "/retrieval" ||
      path === "/comparedAt" ||
      /^\/(?:artifact|externalSource|relation)\/(?:id|revision)$/.test(path) ||
      path === "/artifact/lifecycle" ||
      /^\/retrieval\/(?:status|comparedAt|digest|digestRule|externalVersion|method|reason)$/.test(
        path,
      )
    );
  }
  return false;
}

function validateNodeNulls(node, format, path, root) {
  const pending = [{ node, path }];
  while (pending.length > 0) {
    const { node: current, path: currentPath } = pending.pop();
    if (isScalar(current) && current.value === null) {
      if (!isYamlNullAllowed(format, currentPath, rootValue(root, "status"))) {
        throw new PackageError("PACKAGE_NULL_INVALID", currentPath, "Schema が許可しない位置に null があります。");
      }
      continue;
    }
    let entries;
    if (isSeq(current)) entries = current.items.map((item, index) => [index, item]);
    else if (isMap(current)) entries = current.items.map((pair) => [normalizeNfc(pair.key.value), pair.value]);
    else continue;
    for (let index = entries.length - 1; index >= 0; index--) {
      pending.push({ node: entries[index][1], path: pointerChild(currentPath, entries[index][0]) });
    }
  }
}

export function validateYamlNullPolicy(document) {
  const format = rootFormat(document.contents);
  if (!KNOWN_FORMATS.has(format)) {
    return;
  }
  validateNodeNulls(document.contents, format, "", document.contents);
}
