import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.argv[2] ?? "python3";
const temporary = await realpath(await mkdtemp(join(tmpdir(), "morivyx-tutorial-check-")));
const root = join(temporary, "sample");
const cli = "packages/kernel/src/cli.js";
function execute(command, args, expected = 0, input) {
  const result = spawnSync(command, args, {
    cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, input,
  });
  assert.ifError(result.error);
  if (expected === 0) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0);
  return expected === 0 ? JSON.parse(result.stdout) : null;
}
const node = (...args) => execute(process.execPath, args);
async function snapshot(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(path, relative + "/"));
    else files[relative] = (await readFile(path)).toString("base64");
  }
  return files;
}
try {
  assert.equal(node("examples/getting-started/prepare.mjs", root).valid, true);
  const before = await snapshot(root);
  const base = join(root, "base");
  const after = join(root, "after");
  const request = join(root, "decision.yaml");
  assert.equal(node(cli, "inspect", base).elementCount, 1);
  assert.equal(node(cli, "validate", base).valid, true);
  execute(process.execPath, ["examples/getting-started/prepare.mjs", root], 1);
  assert.deepEqual(await snapshot(root), before);
  const created = node(cli, "create-decision", base, request, after);
  assert.equal(created.elementCount, 2);
  assert.equal(node(cli, "inspect", after).graphRevision, "graph:tutorial-decision");
  assert.equal(node(cli, "validate", after).valid, true);
  assert.deepEqual(await snapshot(base), Object.fromEntries(Object.entries(before)
    .filter(([path]) => path.startsWith("base/")).map(([path, value]) => [path.slice(5), value])));
  const diff = node(cli, "diff", base, after, "--evaluated-at", "2026-11-02T00:10:00Z");
  assert.equal(diff.report.entries.length, 1);
  assert.equal(diff.report.entries[0].kind, "entity_added");
  assert.equal(diff.report.entries[0].targetId, created.decisionId);
  const read = node("examples/getting-started/read.mjs", after);
  const decision = read.elements.find(value => value.type === "core.decision");
  assert.equal(decision.lifecycle, "draft");
  assert.equal(decision.reviewState, "unreviewed");
  assert.equal(decision.attributes.question, "設定の保存形式を何にするか？");
  const saved = await snapshot(after);
  execute(process.execPath, [cli, "create-decision", base, request, after], 1);
  assert.deepEqual(await snapshot(after), saved);
  const revised = join(root, "revised");
  const revisionRequest = "examples/getting-started/revise.yaml";
  const updated = node(cli, "revise-decision", after, revisionRequest, revised);
  assert.equal(updated.decisionId, created.decisionId);
  assert.notEqual(updated.decisionRevision, created.decisionRevision);
  assert.equal(updated.elementCount, 2);
  assert.deepEqual(await snapshot(after), saved);
  assert.equal(node(cli, "validate", revised).valid, true);
  const revisedDecision = node("examples/getting-started/read.mjs", revised).elements
    .find(value => value.id === created.decisionId);
  assert.equal(revisedDecision.attributes.rationale, "YAMLを維持し、読み取り時にも構造を検証する。");
  assert.equal(revisedDecision.lifecycle, "draft");
  assert.equal(revisedDecision.reviewState, "unreviewed");
  const revisionDiff = node(cli, "diff", after, revised, "--evaluated-at", "2026-11-02T00:30:00Z");
  assert(revisionDiff.report.entries.length > 0);
  assert(revisionDiff.report.entries.every(entry => entry.targetId === created.decisionId));
  assert(!revisionDiff.report.entries.some(entry => entry.kind === "entity_added"));
  const history = node("examples/getting-started/history.mjs", revised);
  assert.equal(history.parentRevision, "graph:tutorial-decision");
  assert.equal(history.changeSets.length, 2);
  const revisionChange = history.changeSets.find(value => value.resultingRevision === "graph:tutorial-revised");
  assert.deepEqual(revisionChange.operations, [{ op: "revise", targetId: created.decisionId,
    beforeRevision: created.decisionRevision, afterRevision: updated.decisionRevision }]);
  const revisedSaved = await snapshot(revised);
  execute(process.execPath, [cli, "revise-decision", after, revisionRequest, revised], 1);
  assert.deepEqual(await snapshot(revised), revisedSaved);
  const pyRead = execute(python, ["packages/portable-core/package_records.py", join(after, ".morivyx")]);
  assert.equal(pyRead.counts.elements, 2);
  assert.equal(pyRead.counts.changeSets, 1);
  assert.equal(pyRead.calculatedRootDigest, created.rootDigest);
  const pyValidate = execute(python, ["packages/portable-core/package_validation.py", join(after, ".morivyx"),
    "--previous", join(base, ".morivyx")]);
  assert.equal(pyValidate.valid, true);
  assert.equal(pyValidate.validation.graphConstraintsValidated, true);
  assert.equal(pyValidate.validation.signaturesValidated, false);
  assert.deepEqual(execute(python, ["packages/portable-core/portable_cli.py", "read-yaml"], 0,
    JSON.stringify('question: "保存形式を何にするか？"\nanswer: "YAML"\n')),
  { question: "保存形式を何にするか？", answer: "YAML" });
  console.log(JSON.stringify({ valid: true, workflow: "create-revise-history-diff-python", baseUnchanged: true,
    revisionInputUnchanged: true, sameDecisionId: true, storedChangeSets: history.changeSets.length,
    existingDestinationsUnchanged: true, addedElements: 1, pythonRootDigestMatches: true,
    node: process.version, python }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
