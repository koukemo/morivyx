import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const PREFIX = "morivyx:migration:v1";
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
  if (value === null || typeof value !== "object") {
    throw new TypeError("unsupported canonical value");
  }
  const entries = Object.entries(value).map(([key, child]) => [key.normalize("NFC"), child]);
  entries.sort(([left], [right]) => compareUnicode(left, right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function calculate(migration) {
  const { id: _id, ...content } = migration;
  const canonical = canonicalJson(content);
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
  process.stderr.write("usage: migration-digest-reference <vector.json>\n");
  process.exitCode = 2;
} else {
  const vector = JSON.parse(await readFile(paths[0], "utf8"));
  const output = vector.cases.map(({ name, migration }) => ({
    name,
    ...calculate(migration),
  }));
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
