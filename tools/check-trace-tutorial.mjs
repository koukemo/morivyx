import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), "morivyx-trace-tutorial-")));
const root = join(temporary, "sample");
const cli = "packages/kernel/src/cli.js";
const id = suffix => `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
function node(args, failure = false) {
  const p = spawnSync(process.execPath, args, { cwd: repository, encoding: "utf8", timeout: 30_000 });
  assert.ifError(p.error);
  if (failure) { assert.notEqual(p.status, 0); return; }
  assert.equal(p.status, 0, p.stderr || p.stdout);
  return JSON.parse(p.stdout);
}
async function snapshot(path) {
  const files = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(child) : (await readFile(child)).toString("base64");
  }
  return files;
}
try {
  node(["examples/getting-started/prepare.mjs", root]);
  const base = join(root, "base"), after = join(root, "after"), linked = join(root, "linked");
  node([cli, "create-decision", base, join(root, "decision.yaml"), after]);
  const before = await snapshot(after);
  const trace = (path, query, focus) => node([cli, "trace", path, "--query", query,
    "--focus", id(focus), "--evaluated-at", "2026-11-02T00:50:00Z"]).report;
  const missing = trace(after, "governing-decision", 1);
  assert.equal(missing.status, "partial");
  assert.deepEqual(missing.missing, ["governs"]);
  const created = node(["examples/getting-started/link.mjs", after, linked]);
  assert.equal(created.elementCount, 7);
  assert.equal(node([cli, "validate", linked]).valid, true);
  assert.deepEqual(await snapshot(after), before);
  const governs = trace(linked, "governing-decision", 1);
  assert.equal(governs.status, "complete");
  assert.equal(governs.paths.length, 1);
  assert.deepEqual(governs.paths[0].hops.map(h => [h.fromId, h.predicate, h.toId]), [[id(2), "governs", id(1)]]);
  const evidence = trace(linked, "decision-evidence", 2);
  assert.equal(evidence.status, "complete");
  assert.deepEqual(evidence.paths.flatMap(p => p.hops.map(h => h.predicate)).sort(), ["challenged_by", "supported_by"]);
  const origin = trace(linked, "why-artifact-exists", 1);
  assert.equal(origin.status, "partial");
  assert.deepEqual(origin.missing, ["produces"]);
  assert.equal(trace(linked, "governing-decision", 99).status, "broken");
  assert.equal(trace(linked, "decision-evidence", 1).status, "broken");
  const saved = await snapshot(linked);
  node(["examples/getting-started/link.mjs", after, linked], true);
  assert.deepEqual(await snapshot(linked), saved);
  console.log(JSON.stringify({ valid: true, elements: 7, addedElements: 5, sourceUnchanged: true,
    existingDestinationUnchanged: true, governingDecision: "complete", decisionEvidence: "complete",
    absentRelation: "partial", absentOrWrongFocus: "broken", node: process.version }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
