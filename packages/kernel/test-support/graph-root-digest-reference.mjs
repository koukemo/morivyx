import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const PREFIX = "morivyx:root:v1";
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

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

function canonicalString(value) {
  return JSON.stringify(normalizeTimestamp(value.normalize("NFC")));
}

function ownStringProperty(value, key) {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`element must be an object: ${key}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string"
  ) {
    throw new TypeError(`element property must be a string: ${key}`);
  }
  return descriptor.value;
}

function calculate(elements) {
  if (!Array.isArray(elements)) {
    throw new TypeError("elements must be an array");
  }
  const pairs = elements
    .map((element) => [
      ownStringProperty(element, "id"),
      ownStringProperty(element, "revision"),
    ])
    .sort(([left], [right]) => compareUnicode(left, right));
  const canonical = `[${pairs
    .map(
      ([id, revision]) =>
        `[${canonicalString(id)},${canonicalString(revision)}]`,
    )
    .join(",")}]`;
  const hash = createHash("sha256");
  hash.update(PREFIX, "ascii");
  hash.update(Buffer.from([0]));
  hash.update(canonical, "utf8");
  return {
    canonicalByteLength: Buffer.byteLength(canonical),
    canonicalJson: canonical,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

const paths = process.argv.slice(2);
if (paths.length !== 1) {
  process.stderr.write("usage: graph-root-digest-reference <vector.json>\n");
  process.exitCode = 2;
} else {
  const vector = JSON.parse(await readFile(paths[0], "utf8"));
  process.stdout.write(`${JSON.stringify(calculate(vector.elements))}\n`);
}
