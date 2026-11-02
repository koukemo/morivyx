import {
  readYamlReference,
  writeYamlRecordReference,
} from "./yaml-authoring-roundtrip-reference.mjs";
import { calculateTraceReportReference } from "./report-digest-reference.mjs";

const REQUIRED_FILES = ["schema.lock.yaml", "revision.yaml"];
const RECORD_DIRECTORIES = [
  "graph/entities/",
  "graph/relations/",
  "approvals/",
  "ledger/",
  "migrations/",
  "reports/",
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

function recordFilename(record) {
  const prefix = "urn:uuid:";
  if (typeof record?.id !== "string" || !record.id.startsWith(prefix)) {
    throw new TypeError("record id must use urn:uuid");
  }
  return `${record.id.slice(prefix.length)}.yaml`;
}

function readRecord(files, path) {
  if (typeof files[path] !== "string") {
    throw new TypeError(`missing package file: ${path}`);
  }
  return readYamlReference(files[path]);
}

function recordsIn(files, prefix, kind) {
  return Object.keys(files)
    .filter((path) => path.startsWith(prefix) && path.endsWith(".yaml"))
    .sort(compareUnicode)
    .map((path) => {
      const record = readRecord(files, path);
      if (path.slice(prefix.length) !== recordFilename(record)) {
        throw new TypeError(`record filename does not match id: ${path}`);
      }
      if (kind && record.kind !== kind) {
        throw new TypeError(`record kind does not match directory: ${path}`);
      }
      return record;
    });
}

function assertSupportedFiles(files) {
  for (const path of Object.keys(files)) {
    if (
      !REQUIRED_FILES.includes(path) &&
      !RECORD_DIRECTORIES.some((directory) => path.startsWith(directory))
    ) {
      throw new TypeError(`unsupported package file: ${path}`);
    }
  }
}

function reportResult(report) {
  if (report.format !== "morivyx.trace-report/0.1") {
    throw new TypeError(`unsupported report format: ${report.format}`);
  }
  return {
    valid: true,
    type: "trace-report",
    digest: calculateTraceReportReference(report).digest,
    report,
  };
}

export function readGraphPackageReference(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new TypeError("package files must be a mapping");
  }
  assertSupportedFiles(files);
  const entities = recordsIn(files, "graph/entities/", "entity");
  const relations = recordsIn(files, "graph/relations/", "relation");
  return {
    schemaLock: readRecord(files, "schema.lock.yaml"),
    revision: readRecord(files, "revision.yaml"),
    elements: [...entities, ...relations].sort((left, right) =>
      compareUnicode(left.id, right.id),
    ),
    approvals: recordsIn(files, "approvals/"),
    changeSets: recordsIn(files, "ledger/"),
    migrations: recordsIn(files, "migrations/"),
    reports: recordsIn(files, "reports/").map(reportResult),
  };
}

export function writeGraphPackageReference(packageValue) {
  const files = {
    "schema.lock.yaml": writeYamlRecordReference(packageValue.schemaLock),
    "revision.yaml": writeYamlRecordReference(packageValue.revision),
  };
  for (const element of [...packageValue.elements].sort((left, right) =>
    compareUnicode(left.id, right.id),
  )) {
    const directory =
      element.kind === "entity"
        ? "graph/entities"
        : element.kind === "relation"
          ? "graph/relations"
          : null;
    if (!directory) {
      throw new TypeError(`unsupported graph element kind: ${element.kind}`);
    }
    files[`${directory}/${recordFilename(element)}`] =
      writeYamlRecordReference(element);
  }
  for (const approval of [...packageValue.approvals].sort((left, right) =>
    compareUnicode(left.id, right.id),
  )) {
    files[`approvals/${recordFilename(approval)}`] =
      writeYamlRecordReference(approval);
  }
  for (const changeSet of [...packageValue.changeSets].sort((left, right) =>
    compareUnicode(left.id, right.id),
  )) {
    files[`ledger/${recordFilename(changeSet)}`] =
      writeYamlRecordReference(changeSet);
  }
  for (const migration of [...packageValue.migrations].sort((left, right) =>
    compareUnicode(left.id, right.id),
  )) {
    files[`migrations/${recordFilename(migration)}`] =
      writeYamlRecordReference(migration);
  }
  for (const result of [...packageValue.reports].sort((left, right) =>
    compareUnicode(left.report.id, right.report.id),
  )) {
    files[`reports/${recordFilename(result.report)}`] =
      writeYamlRecordReference(result.report);
  }
  return files;
}
