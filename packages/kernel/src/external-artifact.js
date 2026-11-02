import { canonicalJson, digestValue } from "./canonical.js";
import { validateGraphElement } from "./graph-element.js";

export const EXTERNAL_ARTIFACT_REPORT_FORMAT =
  "morivyx.external-artifact-report/0.1";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RETRIEVAL_STATUSES = new Set(["resolved", "missing", "unavailable"]);
const RETRIEVAL_FIELDS = new Map([
  [
    "resolved",
    new Set([
      "status",
      "comparedAt",
      "digest",
      "digestRule",
      "externalVersion",
    ]),
  ],
  ["missing", new Set(["status", "comparedAt", "method"])],
  ["unavailable", new Set(["status", "comparedAt", "reason"])],
]);
const ISSUE_ORDER = [
  "EXTERNAL_REFERENCE_INCOMPLETE",
  "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
  "EXTERNAL_SOURCE_UNAVAILABLE",
  "EXTERNAL_TARGET_MISSING",
  "EXTERNAL_VERSION_CHANGED",
  "EXTERNAL_DIGEST_CHANGED",
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLogicalRecord(value) {
  if (!isRecord(value)) {
    return false;
  }
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function isText(value) {
  return typeof value === "string" && value.length > 0;
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value);
}

function isGraphElement(value) {
  try {
    validateGraphElement(value);
    return true;
  } catch {
    return false;
  }
}

function identity(element, includeLifecycle = false) {
  const source = isRecord(element) ? element : {};
  const result = {
    id: isText(source.id) ? source.id : null,
    revision: isText(source.revision) ? source.revision : null,
  };
  if (includeLifecycle) {
    result.lifecycle = isText(source.lifecycle) ? source.lifecycle : null;
  }
  return result;
}

function normalizeRetrieval(retrieval) {
  if (!isRecord(retrieval)) {
    return null;
  }
  const result = {
    status: isText(retrieval.status) ? retrieval.status : null,
    comparedAt: isText(retrieval.comparedAt) ? retrieval.comparedAt : null,
  };
  for (const field of [
    "digest",
    "digestRule",
    "externalVersion",
    "method",
    "reason",
  ]) {
    if (Object.hasOwn(retrieval, field)) {
      result[field] = isText(retrieval[field]) ? retrieval[field] : null;
    }
  }
  return result;
}

function orderedIssues(codes) {
  return ISSUE_ORDER.filter((code) => codes.has(code)).map((code) => ({ code }));
}

function createReport(input, relation, status, codes) {
  const root = isRecord(input) ? input : {};
  const retrieval = normalizeRetrieval(root.retrieval);
  return {
    format: EXTERNAL_ARTIFACT_REPORT_FORMAT,
    graphRevision: isText(root.graphRevision) ? root.graphRevision : null,
    artifact: identity(root.artifact, true),
    externalSource: identity(root.externalSource),
    relation: identity(relation),
    retrieval,
    comparedAt: retrieval?.comparedAt ?? null,
    status,
    issues: orderedIssues(codes),
  };
}

export function externalArtifactReportDigest(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return digestValue("morivyx:external-artifact-report:v1", content);
}

export function externalArtifactReportCanonicalJson(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return canonicalJson(content);
}

function derivedFromRelations(relations, artifact) {
  if (!Array.isArray(relations) || !isRecord(artifact)) {
    return [];
  }
  return relations.filter(
    (relation) =>
      isRecord(relation) &&
      isRecord(relation.attributes) &&
      relation.attributes.predicate === "derived_from" &&
      relation.attributes.source === artifact.id,
  );
}

function completeReference(artifact, externalSource, relations) {
  if (
    !isGraphElement(artifact) ||
    artifact.kind !== "entity" ||
    artifact.type !== "core.artifact" ||
    !isRecord(artifact.attributes) ||
    !isText(artifact.attributes.artifactKind) ||
    !isText(artifact.attributes.uri) ||
    !isDigest(artifact.attributes.digest) ||
    !isRecord(artifact.provenance) ||
    artifact.provenance.method !== "imported" ||
    !isTimestamp(artifact.provenance.retrievedAt) ||
    !isText(artifact.provenance.digestRule)
  ) {
    return { complete: false, relation: null };
  }
  if (
    Object.hasOwn(artifact.attributes, "externalVersion") &&
    !isText(artifact.attributes.externalVersion)
  ) {
    return { complete: false, relation: null };
  }
  if (
    !isGraphElement(externalSource) ||
    externalSource.kind !== "entity" ||
    externalSource.type !== "core.external-source" ||
    !isRecord(externalSource.attributes) ||
    !isText(externalSource.attributes.system) ||
    !isText(externalSource.attributes.externalId)
  ) {
    return { complete: false, relation: null };
  }
  if (
    Object.hasOwn(externalSource.attributes, "snapshotAt") &&
    !isTimestamp(externalSource.attributes.snapshotAt)
  ) {
    return { complete: false, relation: null };
  }
  const matches = derivedFromRelations(relations, artifact);
  if (matches.length !== 1) {
    return { complete: false, relation: null };
  }
  const relation = matches[0];
  if (
    !isGraphElement(relation) ||
    relation.kind !== "relation" ||
    relation.type !== "core.derived_from" ||
    relation.attributes.target !== externalSource.id
  ) {
    return { complete: false, relation };
  }
  return { complete: true, relation };
}

function completeRetrieval(retrieval, recordedExternalVersion) {
  if (
    !isRecord(retrieval) ||
    !RETRIEVAL_STATUSES.has(retrieval.status) ||
    !isTimestamp(retrieval.comparedAt)
  ) {
    return false;
  }
  const allowedFields = RETRIEVAL_FIELDS.get(retrieval.status);
  if (Object.keys(retrieval).some((field) => !allowedFields.has(field))) {
    return false;
  }
  if (retrieval.status === "missing") {
    return isText(retrieval.method);
  }
  if (retrieval.status === "unavailable") {
    return isText(retrieval.reason);
  }
  if (!isDigest(retrieval.digest) || !isText(retrieval.digestRule)) {
    return false;
  }
  if (
    Object.hasOwn(retrieval, "externalVersion") &&
    !isText(retrieval.externalVersion)
  ) {
    return false;
  }
  return (
    recordedExternalVersion === undefined ||
    isText(retrieval.externalVersion)
  );
}

function digestRuleUnsupported(input, recordedDigestRule) {
  if (!isText(recordedDigestRule)) {
    return false;
  }
  if (
    !Array.isArray(input.supportedDigestRules) ||
    input.supportedDigestRules.some((rule) => !isText(rule)) ||
    !input.supportedDigestRules.includes(recordedDigestRule)
  ) {
    return true;
  }
  return (
    input.retrieval?.status === "resolved" &&
    isText(input.retrieval.digestRule) &&
    input.retrieval.digestRule !== recordedDigestRule
  );
}

export function compareExternalArtifactReference(input) {
  const root = isLogicalRecord(input) ? input : {};
  const artifact = root.artifact;
  const externalSource = root.externalSource;
  const recordedExternalVersion = artifact?.attributes?.externalVersion;
  const recordedDigestRule = artifact?.provenance?.digestRule;
  const { complete: referenceComplete, relation } = completeReference(
    artifact,
    externalSource,
    root.relations,
  );
  const codes = new Set();
  if (
    !isText(root.graphRevision) ||
    !GRAPH_REVISION_PATTERN.test(root.graphRevision) ||
    !referenceComplete ||
    !completeRetrieval(root.retrieval, recordedExternalVersion)
  ) {
    codes.add("EXTERNAL_REFERENCE_INCOMPLETE");
  }
  if (digestRuleUnsupported(root, recordedDigestRule)) {
    codes.add("EXTERNAL_DIGEST_RULE_UNSUPPORTED");
  }
  if (codes.size > 0) {
    return createReport(root, relation, "invalid", codes);
  }

  if (root.retrieval.status === "unavailable") {
    codes.add("EXTERNAL_SOURCE_UNAVAILABLE");
    return createReport(root, relation, "unavailable", codes);
  }
  if (root.retrieval.status === "missing") {
    codes.add("EXTERNAL_TARGET_MISSING");
    return createReport(root, relation, "missing", codes);
  }

  if (
    recordedExternalVersion !== undefined &&
    root.retrieval.externalVersion !== recordedExternalVersion
  ) {
    codes.add("EXTERNAL_VERSION_CHANGED");
  }
  if (root.retrieval.digest !== artifact.attributes.digest) {
    codes.add("EXTERNAL_DIGEST_CHANGED");
  }
  return createReport(root, relation, codes.size === 0 ? "current" : "stale", codes);
}
