import { canonicalJson, compareUnicode, digestValue } from "./canonical.js";
import { PackageError } from "./errors.js";
import { readGraphPackage } from "./package-reader.js";

const QUERY_TYPES = new Map([
  ["why-artifact-exists", "core.artifact"],
  ["governing-decision", "core.artifact"],
  ["decision-evidence", "core.decision"],
  ["goal-achievement-evidence", "core.goal"],
  ["observation-triggered-change", "core.observation"],
]);
const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ELEMENT_KINDS = new Set(["entity", "relation"]);

function invalidInput(path, message) {
  throw new PackageError("TRACE_QUERY_INPUT_INVALID", path, message);
}

function validateTraceElements(elements) {
  const seen = new Set();
  elements.forEach((element, index) => {
    const pointer = `/elements/${index}`;
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
    if (element.kind === "entity") {
      if (typeof element.type !== "string" || element.type.length === 0) {
        invalidInput(`${pointer}/type`, "Entityの型が不正です。");
      }
      if (
        typeof element.revision !== "string" ||
        !DIGEST_PATTERN.test(element.revision)
      ) {
        invalidInput(`${pointer}/revision`, "EntityのRevision IDが不正です。");
      }
      return;
    }
    if (
      !element.attributes ||
      typeof element.attributes !== "object" ||
      Array.isArray(element.attributes)
    ) {
      invalidInput(`${pointer}/attributes`, "Relationのattributesが不正です。");
    }
    for (const field of ["source", "target"]) {
      if (
        typeof element.attributes[field] !== "string" ||
        !STABLE_ID_PATTERN.test(element.attributes[field])
      ) {
        invalidInput(
          `${pointer}/attributes/${field}`,
          `Relationの${field} stable IDが不正です。`,
        );
      }
    }
    if (
      typeof element.attributes.predicate !== "string" ||
      element.attributes.predicate.length === 0
    ) {
      invalidInput(
        `${pointer}/attributes/predicate`,
        "Relationのpredicateが不正です。",
      );
    }
    if (
      Object.hasOwn(element, "revision") &&
      (typeof element.revision !== "string" ||
        !DIGEST_PATTERN.test(element.revision))
    ) {
      invalidInput(`${pointer}/revision`, "RelationのRevision IDが不正です。");
    }
  });
}

function validateTraceQueryInput({
  graphRevision,
  schemaLockDigest,
  focusId,
  evaluatedAt,
  elements,
  id,
}) {
  if (
    typeof graphRevision !== "string" ||
    !GRAPH_REVISION_PATTERN.test(graphRevision)
  ) {
    invalidInput("/graphRevision", "GraphRevision IDが不正です。");
  }
  if (
    typeof schemaLockDigest !== "string" ||
    !DIGEST_PATTERN.test(schemaLockDigest)
  ) {
    invalidInput("/schemaLockDigest", "Schema固定情報のdigestが不正です。");
  }
  if (typeof focusId !== "string" || !STABLE_ID_PATTERN.test(focusId)) {
    invalidInput("/focusId", "焦点のstable IDが不正です。");
  }
  if (
    typeof evaluatedAt !== "string" ||
    !TIMESTAMP_PATTERN.test(evaluatedAt)
  ) {
    invalidInput("/evaluatedAt", "Trace Queryの評価時刻が不正です。");
  }
  try {
    canonicalJson(evaluatedAt);
  } catch {
    invalidInput("/evaluatedAt", "Trace Queryの評価時刻が不正です。");
  }
  if (
    id !== undefined &&
    (typeof id !== "string" || !STABLE_ID_PATTERN.test(id))
  ) {
    invalidInput("/id", "Reportのstable IDが不正です。");
  }
  if (!Array.isArray(elements)) {
    invalidInput("/elements", "Graph要素は一覧でなければなりません。");
  }
  validateTraceElements(elements);
}

function text(value) {
  return value.normalize("NFC");
}

function elementIndex(elements) {
  return new Map(elements.map((element) => [text(element.id), element]));
}

function appendRelation(index, predicate, endpoint, relation) {
  const byEndpoint = index.get(predicate) ?? new Map();
  const records = byEndpoint.get(endpoint) ?? [];
  records.push(relation);
  byEndpoint.set(endpoint, records);
  index.set(predicate, byEndpoint);
}

function relationIndex(elements) {
  const source = new Map();
  const target = new Map();
  for (const element of elements) {
    if (element.kind !== "relation") {
      continue;
    }
    const { predicate } = element.attributes;
    appendRelation(source, predicate, text(element.attributes.source), element);
    appendRelation(target, predicate, text(element.attributes.target), element);
  }
  return { source, target };
}

function relations(index, predicate, field, value) {
  return index[field].get(predicate)?.get(text(value)) ?? [];
}

function makeHop(relation, index, state) {
  const fromId = text(relation.attributes.source);
  const toId = text(relation.attributes.target);
  const from = index.get(fromId);
  const to = index.get(toId);
  if (!from || !to || from.kind !== "entity" || to.kind !== "entity") {
    state.broken = true;
    return undefined;
  }
  return {
    fromId,
    predicate: relation.attributes.predicate,
    toId,
    fromRevision: from.revision,
    toRevision: to.revision,
  };
}

function hasType(index, id, expected, state) {
  if (index.get(text(id))?.type === expected) {
    return true;
  }
  state.broken = true;
  return false;
}

function evaluateGoverningDecision(relationLookup, index, focusId, state) {
  const paths = [];
  for (const relation of relations(
    relationLookup,
    "governs",
    "target",
    focusId,
  )) {
    const hop = makeHop(relation, index, state);
    if (hop && hasType(index, hop.fromId, "core.decision", state)) {
      paths.push({ hops: [hop] });
    }
  }
  return { paths, missing: paths.length === 0 ? ["governs"] : [] };
}

function evaluateDecisionEvidence(relationLookup, index, focusId, state) {
  const supported = [];
  const challenged = [];
  for (const predicate of ["supported_by", "challenged_by"]) {
    for (const relation of relations(
      relationLookup,
      predicate,
      "source",
      focusId,
    )) {
      const hop = makeHop(relation, index, state);
      if (hop) {
        (predicate === "supported_by" ? supported : challenged).push({
          hops: [hop],
        });
      }
    }
  }
  const focus = index.get(text(focusId));
  const missing = [];
  if (supported.length === 0) {
    missing.push("supported_by");
  }
  if (challenged.length === 0 && !focus?.attributes?.challengeReview) {
    missing.push("challenged_by-or-challengeReview");
  }
  return { paths: [...supported, ...challenged], missing };
}

function evaluateWhyArtifactExists(relationLookup, index, focusId, state) {
  const paths = [];
  let foundProduces = false;
  let foundExecutes = false;
  for (const produced of relations(
    relationLookup,
    "produces",
    "target",
    focusId,
  )) {
    const producedHop = makeHop(produced, index, state);
    if (
      !producedHop ||
      !hasType(index, producedHop.fromId, "core.execution", state)
    ) {
      continue;
    }
    foundProduces = true;
    for (const executed of relations(
      relationLookup,
      "executes",
      "source",
      producedHop.fromId,
    )) {
      const executedHop = makeHop(executed, index, state);
      if (
        !executedHop ||
        !hasType(index, executedHop.toId, "core.plan", state)
      ) {
        continue;
      }
      foundExecutes = true;
      for (const pursued of relations(
        relationLookup,
        "pursues",
        "source",
        executedHop.toId,
      )) {
        const pursuedHop = makeHop(pursued, index, state);
        if (
          pursuedHop &&
          hasType(index, pursuedHop.toId, "core.goal", state)
        ) {
          paths.push({ hops: [producedHop, executedHop, pursuedHop] });
        }
      }
    }
  }
  const missing =
    paths.length > 0
      ? []
      : !foundProduces
        ? ["produces"]
        : !foundExecutes
          ? ["executes"]
          : ["pursues"];
  return { paths, missing };
}

function evaluateGoalAchievement(relationLookup, index, focusId, state) {
  const paths = [];
  let foundCriterion = false;
  let foundVerification = false;
  for (const criterionRelation of relations(
    relationLookup,
    "has_criterion",
    "source",
    focusId,
  )) {
    const criterionHop = makeHop(criterionRelation, index, state);
    if (
      !criterionHop ||
      !hasType(index, criterionHop.toId, "core.criterion", state)
    ) {
      continue;
    }
    foundCriterion = true;
    for (const against of relations(
      relationLookup,
      "against",
      "target",
      criterionHop.toId,
    )) {
      const againstHop = makeHop(against, index, state);
      if (
        !againstHop ||
        !hasType(index, againstHop.fromId, "core.verification", state)
      ) {
        continue;
      }
      foundVerification = true;
      for (const produced of relations(
        relationLookup,
        "produces",
        "source",
        againstHop.fromId,
      )) {
        const producedHop = makeHop(produced, index, state);
        if (
          producedHop &&
          hasType(index, producedHop.toId, "core.observation", state)
        ) {
          paths.push({ hops: [criterionHop, againstHop, producedHop] });
        }
      }
    }
  }
  const missing =
    paths.length > 0
      ? []
      : !foundCriterion
        ? ["has_criterion"]
        : !foundVerification
          ? ["against"]
          : ["produces-observation"];
  return { paths, missing };
}

function evaluateObservationChange(relationLookup, index, focusId, state) {
  const paths = [];
  let foundLearning = false;
  for (const derived of relations(
    relationLookup,
    "derived_from",
    "target",
    focusId,
  )) {
    const derivedHop = makeHop(derived, index, state);
    if (
      !derivedHop ||
      !hasType(index, derivedHop.fromId, "core.learning", state)
    ) {
      continue;
    }
    foundLearning = true;
    for (const triggered of relations(
      relationLookup,
      "triggers",
      "source",
      derivedHop.fromId,
    )) {
      const triggeredHop = makeHop(triggered, index, state);
      if (triggeredHop) {
        paths.push({ hops: [derivedHop, triggeredHop] });
      }
    }
  }
  const missing =
    paths.length > 0 ? [] : [foundLearning ? "triggers" : "derived_from"];
  return { paths, missing };
}

const EVALUATORS = new Map([
  ["why-artifact-exists", evaluateWhyArtifactExists],
  ["governing-decision", evaluateGoverningDecision],
  ["decision-evidence", evaluateDecisionEvidence],
  ["goal-achievement-evidence", evaluateGoalAchievement],
  ["observation-triggered-change", evaluateObservationChange],
]);

function sortPaths(paths) {
  return paths
    .map((path) => ({ hops: path.hops.map((hop) => ({ ...hop })) }))
    .sort((left, right) =>
      compareUnicode(canonicalJson(left), canonicalJson(right)),
    );
}

export function executeTraceQuery(input) {
  const {
    queryId,
    graphRevision,
    schemaLockDigest,
    focusId,
    evaluatedAt,
    elements,
    id,
  } = input ?? {};
  if (!QUERY_TYPES.has(queryId)) {
    throw new PackageError(
      "TRACE_QUERY_UNKNOWN",
      "/queryId",
      `未知の Trace Query です: ${String(queryId)}`,
    );
  }
  validateTraceQueryInput({
    graphRevision,
    schemaLockDigest,
    focusId,
    evaluatedAt,
    elements,
    id,
  });

  const index = elementIndex(elements);
  const relationLookup = relationIndex(elements);
  const focus = index.get(text(focusId));
  const state = { broken: false };
  let result;
  if (!focus || focus.kind !== "entity" || focus.type !== QUERY_TYPES.get(queryId)) {
    state.broken = true;
    result = { paths: [], missing: [!focus ? "focus" : "focus-type"] };
  } else {
    result = EVALUATORS.get(queryId)(relationLookup, index, focusId, state);
  }
  const paths = sortPaths(result.paths);
  const missing = [...new Set(result.missing.map(text))].sort(compareUnicode);
  return {
    format: "morivyx.trace-report/0.1",
    ...(id ? { id } : {}),
    queryId,
    graphRevision,
    schemaLockDigest,
    focusId: text(focusId),
    evaluatedAt,
    status: state.broken ? "broken" : missing.length === 0 ? "complete" : "partial",
    paths,
    missing,
  };
}

export function traceReportDigest(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return digestValue("morivyx:trace-report:v1", {
    ...content,
    paths: sortPaths(content.paths),
    missing: [...new Set(content.missing.map(text))].sort(compareUnicode),
  });
}

export function traceReportCanonicalJson(report) {
  canonicalJson(report);
  const { id: _id, ...content } = report;
  return canonicalJson({
    ...content,
    paths: sortPaths(content.paths),
    missing: [...new Set(content.missing.map(text))].sort(compareUnicode),
  });
}

export async function tracePackage(path, input) {
  const packageContents = await readGraphPackage(path);
  const report = executeTraceQuery({
    ...input,
    graphRevision: packageContents.revision.id,
    schemaLockDigest: packageContents.revision.schemaLockDigest,
    elements: packageContents.elements,
  });
  return {
    valid: true,
    digest: traceReportDigest(report),
    report,
  };
}
