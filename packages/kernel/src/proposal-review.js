import { canonicalJson, changeSetDigest } from "./canonical.js";
import { applyChangeSet } from "./changeset-apply.js";
import { PackageError } from "./errors.js";
import { readGraphPackage } from "./package-reader.js";
import { packageRecords } from "./package-records.js";
import { resolveSchemaRegistry } from "./schema-registry.js";
import { createSemanticDiff, semanticDiffDigest } from "./semantic-diff.js";
import { validateGraph } from "./validator.js";

const FIELDS = new Set([
  "basePath", "changeSet", "candidateElements", "resultingRevision", "evaluatedAt",
]);

function fail(code, path, message) {
  throw new PackageError(`PROPOSAL_REVIEW_${code}`, path, message);
}

function ownInput(input) {
  let owned;
  try {
    // Own proposal data before asynchronous file reads. No mutation of caller input.
    canonicalJson(input);
    owned = structuredClone(input);
  } catch {
    fail("INPUT_INVALID", "/", "提案は複製できるJSONの値にします。");
  }
  if (!owned || typeof owned !== "object" || Array.isArray(owned) ||
      Object.keys(owned).some(key => !FIELDS.has(key)) ||
      typeof owned.basePath !== "string" || owned.basePath.length === 0) {
    fail("INPUT_INVALID", "/", "比較元と提案の入力が必要です。");
  }
  return owned;
}

function comparisonSteps(base, changeSet, candidates) {
  const current = new Map(base.elements.map(element => [element.id, element]));
  const byRevision = new Map(candidates.map(element => [
    `${element.id}\0${element.revision}`, element,
  ]));
  return changeSet.operations.map((operation, index) => {
    const before = operation.op === "revoke" ? null : current.get(operation.targetId) ?? null;
    const afterId = operation.op === "replace" ? operation.replacementId : operation.targetId;
    const after = operation.afterRevision
      ? byRevision.get(`${afterId}\0${operation.afterRevision}`) : null;
    if (operation.op !== "revoke") {
      current.delete(operation.targetId);
      if (after) current.set(after.id, after);
    }
    return { index, operation, before, after };
  });
}

/** Read-only preparation, not approval or an authorization token for later writes. */
export async function prepareProposalReview(input) {
  const owned = ownInput(input);
  const { basePath, changeSet, resultingRevision, evaluatedAt } = owned;
  const candidateElements = owned.candidateElements ?? [];
  const base = await readGraphPackage(basePath);
  const registry = await resolveSchemaRegistry(base.directory, base.schemaLock);
  const validationInput = {
    schemaLockDigest: base.calculatedSchemaLockDigest,
    schemas: registry.schemas,
    registryIssues: registry.issues,
    approvals: base.approvals,
  };
  const baseValidation = validateGraph({
    ...validationInput, graphRevision: base.revision.id, elements: base.elements,
  });
  if (!baseValidation.valid) {
    fail("BASE_INVALID", "/basePath", "比較元のGraphが固定Schemaの検査に失敗しました。");
  }

  const existing = packageRecords(base).find(record => record.id === changeSet?.id);
  if (existing && (!base.changeSets.includes(existing) ||
      changeSetDigest(existing) !== changeSetDigest(changeSet))) {
    fail("ID_CONFLICT", "/changeSet/id", "提案のIDが既存記録と競合しています。");
  }
  const nonElementIds = new Set(packageRecords(base)
    .filter(record => !base.elements.includes(record)).map(record => record.id));
  if (Array.isArray(candidateElements) && candidateElements.some(element =>
    nonElementIds.has(element?.id) || element?.id === changeSet?.id)) {
    fail("ID_CONFLICT", "/candidateElements", "候補要素のIDが保存記録と競合しています。");
  }

  const applied = applyChangeSet({
    changeSet, candidateElements, resultingRevision,
    currentRevision: base.revision,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    currentElements: base.elements,
    knownChangeSetIds: base.changeSets.map(record => record.id),
    appliedChangeSetIds: base.changeSets.filter(record =>
      record.baseRevision === base.revision.parentRevision &&
      record.resultingRevision === base.revision.id &&
      record.resultingRootDigest === base.revision.rootDigest &&
      record.schemaLockDigest === base.revision.schemaLockDigest).map(record => record.id),
  });
  const targetValidation = validateGraph({
    ...validationInput, graphRevision: applied.revision.id,
    elements: applied.elements, previousElements: base.elements,
  });
  if (!targetValidation.valid) {
    fail("TARGET_INVALID", "/candidateElements", "提案のGraphが固定Schemaまたは承認条件の検査に失敗しました。");
  }
  const report = createSemanticDiff({
    baseRevision: base.revision.id,
    targetRevision: applied.revision.id,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    evaluatedAt, baseElements: base.elements, targetElements: applied.elements,
  });
  return structuredClone({
    valid: true,
    baseRevision: base.revision.id,
    baseRootDigest: base.calculatedRootDigest,
    schemaLockDigest: base.calculatedSchemaLockDigest,
    changeSetId: changeSet.id,
    changeSetDigest: changeSetDigest(changeSet),
    resultingRevision: applied.revision,
    changeSet,
    comparison: comparisonSteps(base, changeSet, candidateElements),
    semanticDiff: report,
    semanticDiffDigest: semanticDiffDigest(report),
    authorization: "not-assessed",
    persisted: false,
  });
}
