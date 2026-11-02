import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const ISSUE_ORDER = [
  "EXTERNAL_REFERENCE_INCOMPLETE",
  "EXTERNAL_DIGEST_RULE_UNSUPPORTED",
  "EXTERNAL_SOURCE_UNAVAILABLE",
  "EXTERNAL_TARGET_MISSING",
  "EXTERNAL_VERSION_CHANGED",
  "EXTERNAL_DIGEST_CHANGED",
];

function compareUnicode(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0));
  const rightPoints = Array.from(right, (value) => value.codePointAt(0));
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return value;
  }
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    zone,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;
  const local = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offset =
    zone === "Z"
      ? 0
      : (sign === "+" ? 1 : -1) *
        (Number(offsetHour) * 60 + Number(offsetMinute)) *
        60_000;
  const normalized = new Date(local - offset).toISOString().slice(0, 19);
  const normalizedFraction = fraction?.replace(/0+$/, "") ?? "";
  return `${normalized}${normalizedFraction ? `.${normalizedFraction}` : ""}Z`;
}

function canonicalJson(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeTimestamp(value.normalize("NFC")));
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("unsupported canonical value");
  }
  const entries = Object.entries(value).map(([key, child]) => [
    key.normalize("NFC"),
    child,
  ]);
  entries.sort(([left], [right]) => compareUnicode(left, right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function reportDigest(report) {
  const { id: _id, ...content } = report;
  const canonical = canonicalJson(content);
  const hash = createHash("sha256");
  hash.update("morivyx:external-artifact-report:v1", "ascii");
  hash.update(Buffer.from([0]));
  hash.update(canonical, "utf8");
  return {
    canonicalByteLength: Buffer.byteLength(canonical),
    canonicalJson: canonical,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function derivedFromRelations(input) {
  if (!Array.isArray(input.relations) || !isRecord(input.artifact)) {
    return [];
  }
  return input.relations.filter(
    (relation) =>
      isRecord(relation) &&
      isRecord(relation.attributes) &&
      relation.attributes.predicate === "derived_from" &&
      relation.attributes.source === input.artifact.id,
  );
}

function reference(input, relations) {
  const artifact = input.artifact;
  const externalSource = input.externalSource;
  const relation = relations.length === 1 ? relations[0] : null;
  const artifactComplete =
    isRecord(artifact) &&
    artifact.kind === "entity" &&
    artifact.type === "core.artifact" &&
    isText(artifact.id) &&
    isDigest(artifact.revision) &&
    isText(artifact.lifecycle) &&
    isRecord(artifact.attributes) &&
    isText(artifact.attributes.artifactKind) &&
    isText(artifact.attributes.uri) &&
    isDigest(artifact.attributes.digest) &&
    (!Object.hasOwn(artifact.attributes, "externalVersion") ||
      isText(artifact.attributes.externalVersion)) &&
    isRecord(artifact.provenance) &&
    artifact.provenance.method === "imported" &&
    isTimestamp(artifact.provenance.retrievedAt) &&
    isText(artifact.provenance.digestRule);
  const sourceComplete =
    isRecord(externalSource) &&
    externalSource.kind === "entity" &&
    externalSource.type === "core.external-source" &&
    isText(externalSource.id) &&
    isDigest(externalSource.revision) &&
    isRecord(externalSource.attributes) &&
    isText(externalSource.attributes.system) &&
    isText(externalSource.attributes.externalId) &&
    (!Object.hasOwn(externalSource.attributes, "snapshotAt") ||
      isTimestamp(externalSource.attributes.snapshotAt));
  const relationComplete =
    isRecord(relation) &&
    relation.kind === "relation" &&
    relation.type === "core.derived_from" &&
    isText(relation.id) &&
    isDigest(relation.revision) &&
    relation.attributes.target === externalSource?.id;
  return {
    complete: artifactComplete && sourceComplete && relationComplete,
    relation,
  };
}

function retrievalComplete(retrieval, recordedVersion) {
  if (
    !isRecord(retrieval) ||
    !["resolved", "missing", "unavailable"].includes(retrieval.status) ||
    !isTimestamp(retrieval.comparedAt)
  ) {
    return false;
  }
  if (retrieval.status === "missing") {
    return isText(retrieval.method);
  }
  if (retrieval.status === "unavailable") {
    return isText(retrieval.reason);
  }
  return (
    isDigest(retrieval.digest) &&
    isText(retrieval.digestRule) &&
    (recordedVersion === undefined || isText(retrieval.externalVersion))
  );
}

function unsupportedDigestRule(input, recordedRule) {
  return (
    !Array.isArray(input.supportedDigestRules) ||
    input.supportedDigestRules.some((rule) => !isText(rule)) ||
    !input.supportedDigestRules.includes(recordedRule) ||
    (input.retrieval?.status === "resolved" &&
      input.retrieval.digestRule !== recordedRule)
  );
}

function report(input, relation, status, codes) {
  const retrieval = normalizeRetrieval(input.retrieval);
  return {
    format: "morivyx.external-artifact-report/0.1",
    graphRevision: isText(input.graphRevision) ? input.graphRevision : null,
    artifact: identity(input.artifact, true),
    externalSource: identity(input.externalSource),
    relation: identity(relation),
    retrieval,
    comparedAt: retrieval?.comparedAt ?? null,
    status,
    issues: ISSUE_ORDER.filter((code) => codes.has(code)).map((code) => ({
      code,
    })),
  };
}

function compare(input) {
  const relations = derivedFromRelations(input);
  const { complete, relation } = reference(input, relations);
  const recordedVersion = input.artifact?.attributes?.externalVersion;
  const recordedRule = input.artifact?.provenance?.digestRule;
  const codes = new Set();
  if (
    typeof input.graphRevision !== "string" ||
    !GRAPH_REVISION_PATTERN.test(input.graphRevision) ||
    !complete ||
    !retrievalComplete(input.retrieval, recordedVersion)
  ) {
    codes.add("EXTERNAL_REFERENCE_INCOMPLETE");
  }
  if (unsupportedDigestRule(input, recordedRule)) {
    codes.add("EXTERNAL_DIGEST_RULE_UNSUPPORTED");
  }
  if (codes.size > 0) {
    return report(input, relation, "invalid", codes);
  }
  if (input.retrieval.status === "unavailable") {
    codes.add("EXTERNAL_SOURCE_UNAVAILABLE");
    return report(input, relation, "unavailable", codes);
  }
  if (input.retrieval.status === "missing") {
    codes.add("EXTERNAL_TARGET_MISSING");
    return report(input, relation, "missing", codes);
  }
  if (
    recordedVersion !== undefined &&
    input.retrieval.externalVersion !== recordedVersion
  ) {
    codes.add("EXTERNAL_VERSION_CHANGED");
  }
  if (input.retrieval.digest !== input.artifact.attributes.digest) {
    codes.add("EXTERNAL_DIGEST_CHANGED");
  }
  return report(input, relation, codes.size === 0 ? "current" : "stale", codes);
}

const paths = process.argv.slice(2);
if (paths.length !== 1) {
  process.stderr.write("usage: external-artifact-reference <vector.json>\n");
  process.exitCode = 2;
} else {
  const vector = JSON.parse(await readFile(paths[0], "utf8"));
  const output = vector.cases.map(({ name, input, reportId }) => {
    const generatedReport = compare(input);
    const digestReport =
      typeof reportId === "string"
        ? { ...generatedReport, id: reportId }
        : generatedReport;
    return {
      name,
      report: generatedReport,
      ...reportDigest(digestReport),
    };
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
