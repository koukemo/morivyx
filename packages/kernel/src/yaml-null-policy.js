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
  if (isScalar(node) && node.value === null) {
    if (!isYamlNullAllowed(format, path, rootValue(root, "status"))) {
      throw new PackageError(
        "PACKAGE_NULL_INVALID",
        path,
        "Schema が許可しない位置に null があります。",
      );
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) =>
      validateNodeNulls(item, format, pointerChild(path, index), root),
    );
    return;
  }
  if (!isMap(node)) {
    return;
  }
  for (const pair of node.items) {
    const key = pair.key.value.normalize("NFC");
    validateNodeNulls(pair.value, format, pointerChild(path, key), root);
  }
}

export function validateYamlNullPolicy(document) {
  const format = rootFormat(document.contents);
  if (!KNOWN_FORMATS.has(format)) {
    return;
  }
  validateNodeNulls(document.contents, format, "", document.contents);
}
