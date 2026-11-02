import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const KIND_ORDER = [
  "entity_added",
  "entity_revised",
  "entity_retired",
  "entity_replaced",
  "relation_added",
  "relation_revised",
  "relation_retired",
  "decision_changed",
  "goal_changed",
  "trace_quality_changed",
  "provenance_changed",
  "external_digest_changed",
  "schema_changed",
  "unknown_extension_changed",
];
const KIND_INDEX = new Map(KIND_ORDER.map((kind, index) => [kind, index]));
const ENTRY_FIELDS = [
  "targetId",
  "aspect",
  "queryId",
  "beforeRevision",
  "afterRevision",
  "replacementId",
];
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function compareUnicode(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0));
  const rightPoints = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
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
  const [, year, month, day, hour, minute, second, fraction, zone, sign, offsetHour, offsetMinute] = match;
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
        (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
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
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("unsupported canonical value");
  }
  const entries = Object.entries(value).map(([key, child]) => [key.normalize("NFC"), child]);
  entries.sort(([left], [right]) => compareUnicode(left, right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function compareEntries(left, right) {
  const kindComparison = KIND_INDEX.get(left.kind) - KIND_INDEX.get(right.kind);
  if (kindComparison !== 0) {
    return kindComparison;
  }
  for (const field of ENTRY_FIELDS) {
    const comparison = compareUnicode(
      typeof left[field] === "string" ? left[field].normalize("NFC") : "",
      typeof right[field] === "string" ? right[field].normalize("NFC") : "",
    );
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function digest(prefix, value) {
  const canonical = canonicalJson(value);
  const hash = createHash("sha256");
  hash.update(prefix, "ascii");
  hash.update(Buffer.from([0]));
  hash.update(canonical, "utf8");
  return {
    canonicalByteLength: Buffer.byteLength(canonical),
    canonicalJson: canonical,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

export function calculateSemanticDiffReference(report) {
  const { id: _id, ...content } = report;
  return digest("morivyx:semantic-diff:v1", {
    ...content,
    entries: content.entries.map((entry) => ({ ...entry })).sort(compareEntries),
  });
}

export function calculateTraceReportReference(report) {
  const { id: _id, ...content } = report;
  return digest("morivyx:trace-report:v1", {
    ...content,
    paths: content.paths
      .map((path) => ({ hops: path.hops.map((hop) => ({ ...hop })) }))
      .sort((left, right) => compareUnicode(canonicalJson(left), canonicalJson(right))),
    missing: [...new Set(content.missing.map((value) => value.normalize("NFC")))].sort(
      compareUnicode,
    ),
  });
}

const calculators = new Map([
  ["semantic-diff", calculateSemanticDiffReference],
  ["trace-report", calculateTraceReportReference],
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, vectorPath] = process.argv.slice(2);
  if (!calculators.has(kind) || !vectorPath) {
    process.stderr.write(
      "usage: report-digest-reference <semantic-diff|trace-report> <vector.json>\n",
    );
    process.exitCode = 2;
  } else {
    const vector = JSON.parse(await readFile(vectorPath, "utf8"));
    const calculate = calculators.get(kind);
    const output = vector.cases.map(({ name, report }) => ({
      name,
      ...calculate(report),
    }));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
