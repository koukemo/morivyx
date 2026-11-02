import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { changeSetDigest, graphRootDigest, revisionId } from "../src/canonical.js";
import { prepareDecisionCreation } from "../src/decision-creation.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeChangeSet } from "../src/ledger-store.js";
import { prepareProposalReview } from "../src/proposal-review.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-09T12:00:00Z";

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-proposal-review-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const basePath = join(temporary, "base");
  await cp(join(root, "docs/validation/fixtures/decision-maintenance-base"), basePath, { recursive: true });
  await mkdir(join(basePath, ".morivyx/schemas"));
  await cp(join(root, "docs/schema/morivyx.core@0.1.yaml"), join(basePath, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  const base = await readGraphPackage(basePath);
  const prepared = prepareDecisionCreation(base, {
    format: "morivyx.decision-creation-request/0.1",
    decisionId: id(1), changeSetId: id(2), actor: id(9), recordedAt: at,
    resultingRevision: "graph:proposal-created",
    attributes: { question: "保存前に比較するか", rationale: "誤った提案を正本へ入れない", consequences: ["承認は別途必要"] },
  });
  return { base, basePath, temporary, input: {
    basePath, changeSet: prepared.changeSet,
    candidateElements: [prepared.candidateElement],
    resultingRevision: prepared.resultingRevision, evaluatedAt: at,
  } };
}

async function snapshot(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${prefix}${item.name}`;
      result[key] = item.isDirectory() ? "directory" : (await readFile(join(path, item.name))).toString("base64");
      if (item.isDirectory()) await visit(join(path, item.name), `${key}/`);
    }
  }
  await visit(directory);
  return result;
}

async function saveBase(basePath, elements) {
  const base = await readGraphPackage(basePath);
  const directory = join(basePath, ".morivyx/graph/entities");
  await mkdir(directory, { recursive: true });
  for (const element of elements) {
    await writeFile(join(directory, `${element.id.slice(9)}.yaml`), serializeYamlRecord(element));
  }
  await writeFile(join(basePath, ".morivyx/revision.yaml"), serializeYamlRecord({
    ...base.revision, rootDigest: graphRootDigest(elements),
  }));
}

function setOperations(input, operations, candidates, finalElements) {
  input.changeSet.operations = operations;
  input.changeSet.resultingRootDigest = graphRootDigest(finalElements);
  input.resultingRevision.rootDigest = input.changeSet.resultingRootDigest;
  input.candidateElements = candidates;
}

test("prepares reproducible before/after and semantic comparison without writing or approving", async t => {
  const { input, temporary } = await fixture(t);
  const previous = await snapshot(temporary), owned = structuredClone(input);
  const result = await prepareProposalReview(input);
  assert.equal(result.valid, true);
  assert.equal(result.baseRevision, input.changeSet.baseRevision);
  assert.equal(result.baseRootDigest, graphRootDigest([]));
  assert.equal(result.schemaLockDigest, input.changeSet.schemaLockDigest);
  assert.equal(result.changeSetId, input.changeSet.id);
  assert.equal(result.changeSetDigest, changeSetDigest(input.changeSet));
  assert.equal(result.authorization, "not-assessed");
  assert.equal(result.persisted, false);
  assert.equal(result.comparison[0].before, null);
  assert.deepEqual(result.comparison[0].after, input.candidateElements[0]);
  assert.equal(result.semanticDiff.entries[0].kind, "entity_added");
  assert.deepEqual(await prepareProposalReview(input), result);
  assert.deepEqual(await snapshot(temporary), previous);
  assert.deepEqual(input, owned);
  result.changeSet.provenance.actor = id(99);
  result.comparison[0].after.attributes.rationale = "changed result";
  assert.deepEqual(input, owned);
});

test("owns caller input before asynchronous package reads", async t => {
  const { input } = await fixture(t);
  const expected = structuredClone(input);
  const pending = prepareProposalReview(input);
  input.candidateElements[0].attributes.rationale = "changed during read";
  input.changeSet.provenance.actor = id(99);
  const result = await pending;
  assert.equal(result.changeSet.provenance.actor, expected.changeSet.provenance.actor);
  assert.deepEqual(result.comparison[0].after, expected.candidateElements[0]);
  let invoked = false;
  await assert.rejects(prepareProposalReview({ get basePath() { invoked = true; return "unused"; } }),
    { code: "PROPOSAL_REVIEW_INPUT_INVALID" });
  assert.equal(invoked, false);
});

test("shows intermediate before/after for repeated revisions, retirement and replacement", async t => {
  const { input, basePath, temporary } = await fixture(t);
  const first = input.candidateElements[0];
  await saveBase(basePath, [first]);
  const second = structuredClone(first);
  second.attributes.rationale = "二番目";
  second.revision = revisionId(second);
  const replacement = structuredClone(second);
  replacement.id = id(3);
  replacement.attributes.rationale = "置換先";
  replacement.revision = revisionId(replacement);
  setOperations(input, [
    { op: "revise", targetId: first.id, beforeRevision: first.revision, afterRevision: second.revision },
    { op: "replace", targetId: first.id, beforeRevision: second.revision, replacementId: replacement.id, afterRevision: replacement.revision },
    { op: "retire", targetId: replacement.id, beforeRevision: replacement.revision },
  ], [second, replacement], []);
  const before = await snapshot(temporary);
  const result = await prepareProposalReview(input);
  assert.deepEqual(result.comparison.map(step => [step.before, step.after]), [
    [first, second], [second, replacement], [replacement, null],
  ]);
  assert.equal(result.semanticDiff.entries[0].kind, "entity_retired");
  assert.deepEqual(await snapshot(temporary), before);
});

test("rejects malformed input and unknown write options before reading", async t => {
  for (const input of [null, [], {}, { basePath: "unused", outputPath: "forbidden" }, { basePath: "unused", changeSet: 1n }]) {
    await t.test(String(input?.basePath ?? input), () =>
      assert.rejects(prepareProposalReview(input), { code: "PROPOSAL_REVIEW_INPUT_INVALID" }));
  }
});

test("rejects invalid proposals without any filesystem mutation", async t => {
  const cases = [
    ["stale base", x => { x.changeSet.baseRevision = "graph:old"; }, "CHANGESET_BASE_REVISION_MISMATCH"],
    ["invalid candidate", x => { x.candidateElements[0].attributes.rationale = "tampered"; }, "CHANGESET_CANDIDATE_REVISION_MISMATCH"],
    ["wrong result", x => { x.resultingRevision.rootDigest = `sha256:${"0".repeat(64)}`; }, "CHANGESET_RESULT_MISMATCH"],
    ["schema violation", x => {
      delete x.candidateElements[0].attributes.question;
      x.candidateElements[0].revision = revisionId(x.candidateElements[0]);
      x.changeSet.operations[0].afterRevision = x.candidateElements[0].revision;
      x.changeSet.resultingRootDigest = graphRootDigest(x.candidateElements);
      x.resultingRevision.rootDigest = x.changeSet.resultingRootDigest;
    }, "PROPOSAL_REVIEW_TARGET_INVALID"],
    ["ID collision", x => { x.changeSet.id = x.candidateElements[0].id; }, "PROPOSAL_REVIEW_ID_CONFLICT"],
    ["missing evaluation time", x => { delete x.evaluatedAt; }, "SEMANTIC_DIFF_INPUT_INVALID"],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async sub => {
    const { input, temporary } = await fixture(sub);
    mutate(input);
    const before = await snapshot(temporary);
    await assert.rejects(prepareProposalReview(input), { code });
    assert.deepEqual(await snapshot(temporary), before);
  });
});

test("rejects structurally valid base with invalid Schema content", async t => {
  const { input, basePath } = await fixture(t);
  const element = structuredClone(input.candidateElements[0]);
  delete element.attributes.question;
  element.revision = revisionId(element);
  await saveBase(basePath, [element]);
  await assert.rejects(prepareProposalReview(input), { code: "PROPOSAL_REVIEW_BASE_INVALID" });
});

test("reviews a stored pending ChangeSet and its revocation without altering the ledger", async t => {
  const { input, basePath, temporary } = await fixture(t);
  await writeChangeSet(basePath, input.changeSet);
  const before = await snapshot(temporary);
  assert.equal((await prepareProposalReview(input)).changeSetId, input.changeSet.id);
  const pendingId = input.changeSet.id;
  input.changeSet.id = id(20);
  setOperations(input, [{ op: "revoke", targetId: pendingId }], [], []);
  const result = await prepareProposalReview(input);
  assert.deepEqual(result.comparison[0], {
    index: 0, operation: { op: "revoke", targetId: pendingId }, before: null, after: null,
  });
  assert.deepEqual(result.semanticDiff.entries, []);
  assert.deepEqual(await snapshot(temporary), before);
});

test("rejects reused ChangeSet IDs and candidate IDs colliding with the ledger", async t => {
  const { input, basePath } = await fixture(t);
  await writeChangeSet(basePath, input.changeSet);
  const altered = structuredClone(input);
  altered.changeSet.provenance.actor = id(99);
  await assert.rejects(prepareProposalReview(altered), { code: "PROPOSAL_REVIEW_ID_CONFLICT" });
  input.candidateElements[0].id = input.changeSet.id;
  input.changeSet.id = id(30);
  await assert.rejects(prepareProposalReview(input), { code: "PROPOSAL_REVIEW_ID_CONFLICT" });
});

test("rejects ChangeSet ID collisions with Graph elements", async t => {
  const { input, basePath } = await fixture(t);
  await saveBase(basePath, input.candidateElements);
  input.changeSet.id = input.candidateElements[0].id;
  await assert.rejects(prepareProposalReview(input), { code: "PROPOSAL_REVIEW_ID_CONFLICT" });
});

test("rejects revocation of the ChangeSet that produced the current Graph", async t => {
  const { input, basePath } = await fixture(t);
  await saveBase(basePath, input.candidateElements);
  await writeChangeSet(basePath, input.changeSet);
  await writeFile(join(basePath, ".morivyx/revision.yaml"), serializeYamlRecord(input.resultingRevision));
  const appliedId = input.changeSet.id;
  input.changeSet.id = id(30);
  input.changeSet.baseRevision = input.resultingRevision.id;
  input.changeSet.resultingRevision = "graph:revocation";
  input.resultingRevision.parentRevision = input.resultingRevision.id;
  input.resultingRevision.id = "graph:revocation";
  setOperations(input, [{ op: "revoke", targetId: appliedId }], [], input.candidateElements);
  await assert.rejects(prepareProposalReview(input), { code: "CHANGESET_REVOKE_INVALID" });
});
