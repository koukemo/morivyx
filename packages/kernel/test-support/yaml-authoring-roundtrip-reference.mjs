import { parseDocument, stringify } from "yaml";

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
const SCHEMA_LOCK_ORDER = [
  "format",
  "stableIdScheme",
  "digestAlgorithm",
  "schemas",
];
const SCHEMA_REFERENCE_ORDER = ["schemaId", "version", "digest"];
const GRAPH_REVISION_ORDER = [
  "format",
  "id",
  "parentRevision",
  "rootDigest",
  "schemaLockDigest",
];
const APPROVAL_ORDER = [
  "format",
  "id",
  "actor",
  "targetId",
  "targetRevision",
  "operation",
  "scope",
  "approvedAt",
  "recordedAt",
  "expiresAt",
  "revokes",
];
const CHANGESET_ORDER = [
  "format",
  "id",
  "baseRevision",
  "resultingRevision",
  "resultingRootDigest",
  "schemaLockDigest",
  "operations",
  "provenance",
  "recordedAt",
];
const CHANGESET_OPERATION_ORDER = [
  "op",
  "targetId",
  "beforeRevision",
  "afterRevision",
  "replacementId",
];
const MIGRATION_ORDER = [
  "format",
  "id",
  "baseRevision",
  "sourceSchemaLockDigest",
  "targetSchemaLockDigest",
  "rulesDigest",
  "mappingDigest",
  "plannedSemanticDiffDigest",
  "changeSetId",
  "resultingRevision",
  "resultingRootDigest",
  "provenance",
  "recordedAt",
];
const TRACE_REPORT_ORDER = [
  "format",
  "id",
  "queryId",
  "graphRevision",
  "schemaLockDigest",
  "focusId",
  "evaluatedAt",
  "status",
  "paths",
  "missing",
  "waiverDecisionId",
];
const TRACE_PATH_ORDER = ["hops"];
const TRACE_HOP_ORDER = [
  "fromId",
  "predicate",
  "toId",
  "fromRevision",
  "toRevision",
];
const PROVENANCE_ORDER = ["method", "actor", "recordedAt"];
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

function normalizedEntries(value) {
  const keys = new Set();
  return Object.entries(value).map(([rawKey, entry]) => {
    const key = rawKey.normalize("NFC");
    if (keys.has(key)) {
      throw new TypeError(`duplicate normalized key: ${key}`);
    }
    keys.add(key);
    return [key, entry];
  });
}

function normalizeLogicalValue(value) {
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLogicalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    normalizedEntries(value).map(([key, entry]) => [
      key,
      normalizeLogicalValue(entry),
    ]),
  );
}

function normalizeForWriting(value) {
  if (typeof value === "string") {
    return normalizeTimestamp(value.normalize("NFC"));
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForWriting);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    normalizedEntries(value)
      .sort(([left], [right]) => compareUnicode(left, right))
      .map(([key, entry]) => [key, normalizeForWriting(entry)]),
  );
}

function orderedRecord(value, order, transforms = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("record must be a mapping");
  }
  const positions = new Map(order.map((key, index) => [key, index]));
  return Object.fromEntries(
    normalizedEntries(value)
      .sort(([left], [right]) => {
        const leftPosition = positions.get(left);
        const rightPosition = positions.get(right);
        if (leftPosition !== undefined && rightPosition !== undefined) {
          return leftPosition - rightPosition;
        }
        if (leftPosition !== undefined) {
          return -1;
        }
        if (rightPosition !== undefined) {
          return 1;
        }
        return compareUnicode(left, right);
      })
      .map(([key, entry]) => [
        key,
        Object.hasOwn(transforms, key)
          ? transforms[key](entry)
          : normalizeForWriting(entry),
      ]),
  );
}

export function readYamlReference(source) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError(document.errors[0].message);
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("record root must be a mapping");
  }
  return normalizeLogicalValue(value);
}

export function writeYamlRecordReference(record) {
  const format = record?.format?.normalize?.("NFC");
  let ordered;
  if (format === "morivyx.git-graph/0.1") {
    ordered = orderedRecord(record, GRAPH_ELEMENT_ORDER, {
      provenance: (value) => orderedRecord(value, PROVENANCE_ORDER),
    });
  } else if (format === "morivyx.schema-lock/0.1") {
    ordered = orderedRecord(record, SCHEMA_LOCK_ORDER, {
      schemas: (value) =>
        value.map((entry) => orderedRecord(entry, SCHEMA_REFERENCE_ORDER)),
    });
  } else if (format === "morivyx.graph-revision/0.1") {
    ordered = orderedRecord(record, GRAPH_REVISION_ORDER);
  } else if (format === "morivyx.approval/0.1") {
    ordered = orderedRecord(record, APPROVAL_ORDER);
  } else if (format === "morivyx.changeset/0.1") {
    ordered = orderedRecord(record, CHANGESET_ORDER, {
      operations: (value) =>
        value.map((entry) => orderedRecord(entry, CHANGESET_OPERATION_ORDER)),
      provenance: (value) => orderedRecord(value, PROVENANCE_ORDER),
    });
  } else if (format === "morivyx.migration/0.1") {
    ordered = orderedRecord(record, MIGRATION_ORDER, {
      provenance: (value) => orderedRecord(value, PROVENANCE_ORDER),
    });
  } else if (format === "morivyx.trace-report/0.1") {
    ordered = orderedRecord(record, TRACE_REPORT_ORDER, {
      paths: (value) =>
        value.map((path) =>
          orderedRecord(path, TRACE_PATH_ORDER, {
            hops: (hops) =>
              hops.map((hop) => orderedRecord(hop, TRACE_HOP_ORDER)),
          }),
        ),
    });
  } else {
    throw new TypeError("unsupported record format");
  }
  return stringify(ordered, {
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    lineWidth: 0,
  });
}

export function writeYamlReference(record) {
  if (record?.format?.normalize?.("NFC") !== "morivyx.git-graph/0.1") {
    throw new TypeError("unsupported record format");
  }
  return writeYamlRecordReference(record);
}
