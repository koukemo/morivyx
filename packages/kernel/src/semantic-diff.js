import {
  canonicalJson,
  compareUnicode,
  digestValue,
  schemaLockDigest,
} from "./canonical.js";
import { PackageError } from "./errors.js";
import { readGraphPackage } from "./package-reader.js";

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
const TRACE_QUERY_IDS = new Set([
  "why-artifact-exists",
  "governing-decision",
  "decision-evidence",
  "goal-achievement-evidence",
  "observation-triggered-change",
]);
const TRACE_STATUSES = new Set([
  "complete",
  "partial",
  "waived",
  "stale",
  "broken",
]);
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ELEMENT_KINDS = new Set(["entity", "relation"]);
export const MIGRATION_SEMANTIC_DIFF_FORMAT =
  "morivyx.migration-semantic-diff/0.1";

function invalidInput(path, message) {
  throw new PackageError("SEMANTIC_DIFF_INPUT_INVALID", path, message);
}

function validateElementProjection(elements, field) {
  const seen = new Set();
  elements.forEach((element, index) => {
    const pointer = `/${field}/${index}`;
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      invalidInput(pointer, "Graph要素は対応表でなければなりません。");
    }
    if (typeof element.id !== "string" || !STABLE_ID_PATTERN.test(element.id)) {
      invalidInput(`${pointer}/id`, "Graph要素のstable IDが不正です。");
    }
    if (seen.has(element.id)) {
      invalidInput(`${pointer}/id`, "Graph要素のstable IDが重複しています。");
    }
    seen.add(element.id);
    if (!ELEMENT_KINDS.has(element.kind)) {
      invalidInput(`${pointer}/kind`, "Graph要素のkindが不正です。");
    }
    if (
      typeof element.revision !== "string" ||
      !DIGEST_PATTERN.test(element.revision)
    ) {
      invalidInput(`${pointer}/revision`, "Graph要素のRevision IDが不正です。");
    }
  });
}

function validateSemanticDiffInput({
  baseRevision,
  targetRevision,
  schemaLockDigest,
  evaluatedAt,
  baseElements,
  targetElements,
  traceChanges,
  id,
}) {
  for (const [field, value] of [
    ["baseRevision", baseRevision],
    ["targetRevision", targetRevision],
  ]) {
    if (typeof value !== "string" || !GRAPH_REVISION_PATTERN.test(value)) {
      invalidInput(`/${field}`, "GraphRevision IDが不正です。");
    }
  }
  if (
    typeof schemaLockDigest !== "string" ||
    !DIGEST_PATTERN.test(schemaLockDigest)
  ) {
    invalidInput("/schemaLockDigest", "Schema固定情報のdigestが不正です。");
  }
  if (
    typeof evaluatedAt !== "string" ||
    !TIMESTAMP_PATTERN.test(evaluatedAt)
  ) {
    invalidInput("/evaluatedAt", "semantic diffの評価時刻が不正です。");
  }
  try {
    canonicalJson(evaluatedAt);
  } catch {
    invalidInput("/evaluatedAt", "semantic diffの評価時刻が不正です。");
  }
  if (
    id !== undefined &&
    (typeof id !== "string" || !STABLE_ID_PATTERN.test(id))
  ) {
    invalidInput("/id", "Reportのstable IDが不正です。");
  }
  for (const [field, value] of [
    ["baseElements", baseElements],
    ["targetElements", targetElements],
    ["traceChanges", traceChanges],
  ]) {
    if (!Array.isArray(value)) {
      invalidInput(`/${field}`, `${field}は一覧でなければなりません。`);
    }
  }
  validateElementProjection(baseElements, "baseElements");
  validateElementProjection(targetElements, "targetElements");
}

function text(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

function assertKind(kind) {
  if (!KIND_INDEX.has(kind)) {
    throw new PackageError(
      "SEMANTIC_DIFF_KIND_UNKNOWN",
      "/entries/kind",
      `未知の semantic diff 種別です: ${String(kind)}`,
    );
  }
}

export function compareSemanticDiffEntries(left, right) {
  assertKind(left.kind);
  assertKind(right.kind);
  const kindComparison = KIND_INDEX.get(left.kind) - KIND_INDEX.get(right.kind);
  if (kindComparison !== 0) {
    return kindComparison;
  }
  for (const field of [
    "targetId",
    "aspect",
    "queryId",
    "beforeRevision",
    "afterRevision",
    "replacementId",
  ]) {
    const comparison = compareUnicode(text(left[field]), text(right[field]));
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function sortedEntries(entries) {
  const copy = entries.map((entry) => ({ ...entry }));
  for (const entry of copy) {
    assertKind(entry.kind);
  }
  copy.sort(compareSemanticDiffEntries);
  for (let index = 1; index < copy.length; index += 1) {
    if (compareSemanticDiffEntries(copy[index - 1], copy[index]) === 0) {
      throw new PackageError(
        "SEMANTIC_DIFF_ENTRY_DUPLICATE",
        `/entries/${index}`,
        "semantic diffに同じ論理順序キーのentryが重複しています。",
      );
    }
  }
  return copy;
}

export function semanticDiffStructuralEntries(baseElements, targetElements) {
  const base = new Map(baseElements.map((element) => [text(element.id), element]));
  const target = new Map(
    targetElements.map((element) => [text(element.id), element]),
  );
  const ids = new Set([...base.keys(), ...target.keys()]);
  const entries = [];

  for (const id of [...ids].sort(compareUnicode)) {
    const before = base.get(id);
    const after = target.get(id);
    if (!before) {
      entries.push({
        kind: after.kind === "relation" ? "relation_added" : "entity_added",
        targetId: id,
        afterRevision: after.revision,
      });
      continue;
    }
    if (!after) {
      entries.push({
        kind:
          before.kind === "relation" ? "relation_retired" : "entity_retired",
        targetId: id,
        beforeRevision: before.revision,
      });
      continue;
    }
    if (before.revision === after.revision) {
      continue;
    }
    if (before.kind !== after.kind) {
      entries.push(
        {
          kind:
            before.kind === "relation"
              ? "relation_retired"
              : "entity_retired",
          targetId: id,
          beforeRevision: before.revision,
        },
        {
          kind:
            after.kind === "relation" ? "relation_added" : "entity_added",
          targetId: id,
          afterRevision: after.revision,
        },
      );
      continue;
    }
    entries.push({
      kind: after.kind === "relation" ? "relation_revised" : "entity_revised",
      targetId: id,
      beforeRevision: before.revision,
      afterRevision: after.revision,
    });
  }
  return sortedEntries(entries);
}

function traceEntries(traceChanges) {
  return traceChanges
    .map((change, index) => {
      const path = `/traceChanges/${index}`;
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        invalidInput(path, "Trace品質差分は対応表でなければなりません。");
      }
      if (
        typeof change.targetId !== "string" ||
        !STABLE_ID_PATTERN.test(change.targetId)
      ) {
        invalidInput(`${path}/targetId`, "対象のstable IDが不正です。");
      }
      if (
        !TRACE_QUERY_IDS.has(change.queryId) ||
        !TRACE_STATUSES.has(change.beforeStatus) ||
        !TRACE_STATUSES.has(change.afterStatus)
      ) {
        invalidInput(path, "Trace品質差分の問いまたは状態が不正です。");
      }
      if (change.beforeStatus === change.afterStatus) {
        return undefined;
      }
      return {
        kind: "trace_quality_changed",
        targetId: text(change.targetId),
        queryId: change.queryId,
        beforeStatus: change.beforeStatus,
        afterStatus: change.afterStatus,
      };
    })
    .filter(Boolean);
}

export function createSemanticDiff(input) {
  const {
    baseRevision,
    targetRevision,
    schemaLockDigest,
    evaluatedAt,
    baseElements,
    targetElements,
    traceChanges = [],
    id,
  } = input ?? {};
  validateSemanticDiffInput({
    baseRevision,
    targetRevision,
    schemaLockDigest,
    evaluatedAt,
    baseElements,
    targetElements,
    traceChanges,
    id,
  });
  const report = {
    format: "morivyx.semantic-diff/0.1",
    ...(id ? { id } : {}),
    baseRevision,
    targetRevision,
    schemaLockDigest,
    evaluatedAt,
    entries: sortedEntries([
      ...semanticDiffStructuralEntries(baseElements, targetElements),
      ...traceEntries(traceChanges),
    ]),
  };
  return report;
}

function schemaEntries(schemaLock, path) {
  if (
    !schemaLock ||
    typeof schemaLock !== "object" ||
    Array.isArray(schemaLock) ||
    !Array.isArray(schemaLock.schemas)
  ) {
    throw new PackageError(
      "SEMANTIC_DIFF_INPUT_INVALID",
      `${path}/schemas`,
      "Schema 固定情報の一覧が不正です。",
    );
  }
  const entries = new Map();
  for (const entry of schemaLock.schemas) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.schemaId !== "string" ||
      entry.schemaId.length === 0 ||
      entries.has(entry.schemaId.normalize("NFC"))
    ) {
      throw new PackageError(
        "SEMANTIC_DIFF_INPUT_INVALID",
        `${path}/schemas`,
        "Schema 固定情報の Schema ID が不正または重複しています。",
      );
    }
    entries.set(entry.schemaId.normalize("NFC"), entry);
  }
  return entries;
}

function verifySchemaLockDigest(schemaLock, expectedDigest, path) {
  let actualDigest;
  try {
    actualDigest = schemaLockDigest(schemaLock);
  } catch {
    throw new PackageError(
      "SCHEMA_LOCK_CONFLICT",
      path,
      "Schema 固定情報から digest を計算できません。",
    );
  }
  if (actualDigest !== expectedDigest) {
    throw new PackageError(
      "SCHEMA_LOCK_CONFLICT",
      path,
      "Schema 固定情報の内容と宣言 digest が一致しません。",
    );
  }
}

export function migrationSchemaChangeEntries(
  sourceSchemaLock,
  targetSchemaLock,
) {
  const source = schemaEntries(sourceSchemaLock, "/sourceSchemaLock");
  const target = schemaEntries(targetSchemaLock, "/targetSchemaLock");
  const schemaIds = new Set([...source.keys(), ...target.keys()]);
  const entries = [];

  for (const schemaId of [...schemaIds].sort(compareUnicode)) {
    const before = source.get(schemaId);
    const after = target.get(schemaId);
    if (
      before === undefined ||
      after === undefined ||
      canonicalJson(before) !== canonicalJson(after)
    ) {
      entries.push({ kind: "schema_changed", targetId: schemaId });
    }
  }
  if (entries.length === 0) {
    throw new PackageError(
      "SEMANTIC_DIFF_INPUT_INVALID",
      "/targetSchemaLock/schemas",
      "Migration の対象となる Schema の変更がありません。",
    );
  }
  return entries;
}

export function createMigrationSemanticDiff(input) {
  const {
    baseRevision,
    targetRevision,
    sourceSchemaLock,
    targetSchemaLock,
    sourceSchemaLockDigest,
    targetSchemaLockDigest,
    evaluatedAt,
    baseElements,
    targetElements,
    traceChanges = [],
    id,
  } = input ?? {};
  verifySchemaLockDigest(
    sourceSchemaLock,
    sourceSchemaLockDigest,
    "/sourceSchemaLockDigest",
  );
  verifySchemaLockDigest(
    targetSchemaLock,
    targetSchemaLockDigest,
    "/targetSchemaLockDigest",
  );
  if (sourceSchemaLockDigest === targetSchemaLockDigest) {
    throw new PackageError(
      "SCHEMA_LOCK_CONFLICT",
      "/targetSchemaLockDigest",
      "Migration の変換元と変換先の Schema 固定情報が同一です。",
    );
  }
  const report = createSemanticDiff({
    baseRevision,
    targetRevision,
    schemaLockDigest: targetSchemaLockDigest,
    evaluatedAt,
    baseElements,
    targetElements,
    traceChanges,
    id,
  });
  return {
    format: MIGRATION_SEMANTIC_DIFF_FORMAT,
    ...(id ? { id } : {}),
    baseRevision,
    targetRevision,
    sourceSchemaLockDigest,
    targetSchemaLockDigest,
    evaluatedAt,
    entries: sortedEntries([
      ...report.entries,
      ...migrationSchemaChangeEntries(sourceSchemaLock, targetSchemaLock),
    ]),
  };
}

export function semanticDiffDigest(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  const normalized = { ...content, entries: sortedEntries(content.entries) };
  return digestValue("morivyx:semantic-diff:v1", normalized);
}

export function migrationSemanticDiffDigest(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  const normalized = { ...content, entries: sortedEntries(content.entries) };
  return digestValue("morivyx:migration-semantic-diff:v1", normalized);
}

export async function diffPackages(
  basePath,
  targetPath,
  { evaluatedAt, traceChanges = [], id },
) {
  const base = await readGraphPackage(basePath);
  const target = await readGraphPackage(targetPath);
  if (base.revision.schemaLockDigest !== target.revision.schemaLockDigest) {
    throw new PackageError(
      "SCHEMA_LOCK_CONFLICT",
      targetPath,
      "比較する GraphRevision の Schema 固定情報 digest が一致しません。",
    );
  }
  const report = createSemanticDiff({
    baseRevision: base.revision.id,
    targetRevision: target.revision.id,
    schemaLockDigest: base.revision.schemaLockDigest,
    evaluatedAt,
    baseElements: base.elements,
    targetElements: target.elements,
    traceChanges,
    id,
  });
  return {
    valid: true,
    digest: semanticDiffDigest(report),
    report,
  };
}

export function semanticDiffCanonicalJson(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return canonicalJson({ ...content, entries: sortedEntries(content.entries) });
}

export function migrationSemanticDiffCanonicalJson(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return canonicalJson({ ...content, entries: sortedEntries(content.entries) });
}
