import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionId } from "../packages/kernel/src/canonical.js";
import { projectDecisionMarkdown } from "../packages/kernel/src/decision-markdown.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const implementation = join(root, "packages/portable-core/decision_markdown.py");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const limit = 8 * 1024 * 1024;
const vector = JSON.parse(await readFile(new URL("../packages/kernel/test/fixtures/decision-markdown-vector.json", import.meta.url), "utf8"));
const id = (suffix) => `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
function element(suffix, type, attributes = {}, kind = "entity") {
  const value = { format: "morivyx.git-graph/0.1", kind, id: id(suffix), type, typeVersion: "0.1", lifecycle: "active", reviewState: "unreviewed", attributes,
    provenance: { method: "asserted", actor: id(900), recordedAt: "2026-09-01T16:00:00Z" } };
  if (suffix === 1) Object.assign(value, { lifecycle: vector.input.decision.lifecycle, reviewState: vector.input.decision.reviewState });
  value.revision = revisionId(value);
  return value;
}
function input() {
  const decision = element(1, "core.decision", structuredClone(vector.input.decision.attributes));
  const entities = vector.input.entities.map((entry) => element(entry.suffix, entry.type));
  const aliases = new Map(vector.input.entities.map((entry, index) => [entry.alias, entities[index].id]));
  return { graphRevision: vector.input.graphRevision, decisionId: decision.id, projectorPackageDigest: vector.input.projectorPackageDigest,
    elements: [decision, ...entities, ...vector.input.relations.map((entry) => element(entry.suffix, `core.${entry.predicate}`, {
      source: decision.id, predicate: entry.predicate, target: aliases.get(entry.to),
    }, "relation"))] };
}
function run(args, data, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, encoding: "utf8", input: data, timeout: 30_000, maxBuffer: 2 * limit, ...options });
  assert.equal(result.error, undefined);
  return result;
}
const batch = `import copy,importlib.util,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('projection',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
from canonical import load_json
from stdin_transport import read_bounded_stdin
out=[]
for value in load_json(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 before=copy.deepcopy(value)
 try: out.append({'accepted':True,'projection':module.project_decision_markdown(value)})
 except (ValueError,TypeError,KeyError,RecursionError,OverflowError) as error: out.append({'accepted':False,'code':getattr(error,'code',None),'path':getattr(error,'path',None)})
 assert value==before
print(json.dumps(out,ensure_ascii=False))`;
function compare(cases) {
  const result = run(["-c", batch, implementation], JSON.stringify(cases.map((entry) => entry.value)));
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  cases.forEach(({ name, value, accepted }, index) => {
    const before = structuredClone(value);
    let expected;
    try { expected = { accepted: true, projection: projectDecisionMarkdown(value) }; }
    catch (error) { expected = { accepted: false, code: error.code ?? null, path: error.path ?? null }; }
    assert.equal(expected.accepted, accepted, name);
    assert.deepEqual(actual[index], expected, name);
    assert.deepEqual(value, before, name);
  });
  return actual;
}

test("independent Decision Markdown matches the unchanged fixed vector", () => {
  const [actual] = compare([{ name: "golden", value: input(), accepted: true }]);
  for (const key of ["sourceRevision", "rulesDigest", "configurationDigest", "digest"]) assert.equal(actual.projection[key], vector.expected[key]);
  assert.equal(Buffer.byteLength(actual.projection.markdown), vector.expected.byteLength);
  assert.equal(actual.projection.markdown.split("\n").length - 1, vector.expected.lineCount);
  const cli = run([implementation], JSON.stringify(input()));
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), actual.projection);
});

test("independent Decision Markdown preserves escaping, ordering and the projection scope", () => {
  const cases = [];
  const add = (name, edit) => { const value = input(); edit(value); cases.push({ name, value, accepted: true }); };
  add("reverse element and attribute order", (v) => { v.elements.reverse(); for (const e of v.elements) e.attributes = Object.fromEntries(Object.entries(e.attributes).reverse()); });
  add("all Markdown punctuation and controls", (v) => { v.elements[0].attributes.question = "\\`*_{}[]<>#+-.!|()>=~\r\n\t    a\rb\u0000\u0008\u000b\u000c\u001f\u007f"; });
  add("NFC, astral and line separators", (v) => { v.graphRevision = "graph:e\u0301\u0085"; v.elements[0].attributes.rationale = "e\u0301\ud83d\ude80\u2028\u2029"; });
  add("multiline lists", (v) => { v.elements[0].attributes.consequences = ["a\n\n\t# b", " "]; });
  add("absent optional fields and empty sections", (v) => { delete v.elements[0].attributes.challengeReview; delete v.elements[0].attributes.revisitTriggers; v.elements = [v.elements[0]]; });
  for (const value of [null, false, "a", 42, [], { z: "2026-09-01T16:00:00+00:00", a: "e\u0301" }]) add(`canonical challenge ${JSON.stringify(value)}`, (v) => { v.elements[0].attributes.challengeReview = value; });
  add("metadata is not revision verification", (v) => { v.graphRevision = "graph:asserted-only"; for (const e of v.elements) e.revision = "sha256:" + "0".repeat(64); });
  add("unknown predicate omitted after validation", (v) => { v.elements[6].type = "core.other"; v.elements[6].attributes.predicate = "other"; });
  add("unrelated source omitted", (v) => { v.elements[6].attributes.source = id(2); });
  add("unknown provenance field is retained in the unchanged input", (v) => { v.elements[1].provenance["extra/~"] = true; });
  add("same target ties sorted by relation ID", (v) => { const relation = structuredClone(v.elements[6]); relation.id = id(19); v.elements.push(relation); v.elements.reverse(); });
  for (const character of ["\u0085", "\u001c", "\ufeff"]) add(`type whitespace parity ${character.codePointAt(0)}`, (v) => {
    // ECMAScript accepts NEL and record separators, but not BOM in type IDs.
    v.elements[1].type = character === "\ufeff" ? "core.valid" : `core.${character}type`;
  });
  compare(cases);
  console.info(`Decision Markdown accepted differential cases: ${cases.length}; complete output differences: 0`);
});

test("independent Decision Markdown rejects malformed and unrelated relations", () => {
  const cases = [null, [], 1].map((value) => ({ name: `root ${JSON.stringify(value)}`, value, accepted: false }));
  const add = (name, edit) => { const value = input(); edit(value); cases.push({ name, value, accepted: false }); };
  for (const field of ["graphRevision", "decisionId", "projectorPackageDigest", "elements"]) add(`missing ${field}`, (v) => { delete v[field]; });
  add("extra field", (v) => { v.extra = true; });
  for (const value of ["graph:", "graph:a\n", "graph:a b", "graph:\ufeff"]) add(`bad graph ${JSON.stringify(value)}`, (v) => { v.graphRevision = value; });
  add("duplicate id", (v) => { v.elements.push(structuredClone(v.elements[0])); });
  add("missing decision", (v) => { v.decisionId = id(999); });
  add("wrong focal type", (v) => { v.decisionId = id(2); });
  for (const field of ["question", "rationale", "consequences"]) {
    add(`absent ${field}`, (v) => { delete v.elements[0].attributes[field]; });
    add(`empty ${field}`, (v) => { v.elements[0].attributes[field] = field === "consequences" ? [] : ""; });
  }
  add("non-string list", (v) => { v.elements[0].attributes.consequences = [1]; });
  add("null optional list", (v) => { v.elements[0].attributes.revisitTriggers = null; });
  for (const field of ["source", "target", "predicate"]) add(`missing relation ${field}`, (v) => { delete v.elements[6].attributes[field]; });
  add("relation type mismatch", (v) => { v.elements[6].type = "core.other"; });
  add("absent endpoint", (v) => { v.elements[6].attributes.target = id(999); });
  add("relation endpoint", (v) => { v.elements[6].attributes.target = id(21); });
  add("invalid unrelated relation", (v) => { v.elements[6].attributes.source = id(2); v.elements[6].attributes.target = id(999); });
  add("unknown predicate still validated", (v) => { v.elements[6].type = "core.other"; v.elements[6].attributes.predicate = "other"; v.elements[6].attributes.target = id(999); });
  for (const field of ["format", "kind", "id", "type", "typeVersion", "revision", "lifecycle", "reviewState", "attributes", "provenance"]) add(`bad structure ${field}`, (v) => { v.elements[1][field] = null; });
  for (const field of ["format", "kind", "id", "type", "typeVersion", "revision", "lifecycle", "reviewState", "attributes", "provenance"]) {
    for (const value of [false, 1, "", [], {}]) {
      if (field === "attributes" && !Array.isArray(value) && typeof value === "object") continue;
      add(`structure ${field} ${JSON.stringify(value)}`, (v) => { v.elements[1][field] = value; });
    }
  }
  for (const value of [null, false, 1, "", []]) add(`element root ${JSON.stringify(value)}`, (v) => { v.elements[1] = value; });
  for (const field of ["method", "actor", "recordedAt"]) for (const value of [null, false, 1, "", [], {}]) {
    add(`provenance ${field} ${JSON.stringify(value)}`, (v) => { v.elements[1].provenance[field] = value; });
  }
  for (const value of [null, false, 1, "", []]) add(`extensions ${JSON.stringify(value)}`, (v) => { v.elements[1].extensions = value; });
  add("unknown element field is escaped", (v) => { v.elements[1]["extra/~"] = true; });
  add("unknown root field has the API's path", (v) => { v["extra/~"] = true; });
  add("canonical rejection precedes invalid format", (v) => { v.elements[1].format = null; v.elements[0].attributes.question = "\ud800"; });
  add("first invalid element precedes later invalid relation", (v) => { v.elements[1].format = null; v.elements[6].attributes.target = id(999); });
  add("unknown field precedes missing format", (v) => { delete v.elements[1].format; v.elements[1]["extra/~"] = true; });
  add("normalization collision", (v) => { v.elements[0].attributes.challengeReview = { "é": 1, "e\u0301": 2 }; });
  add("BOM type", (v) => { v.elements[1].type = "core.\ufefftype"; });
  add("invalid timestamp", (v) => { v.elements[1].provenance.recordedAt = "2026-02-30T00:00:00Z"; });
  add("unpaired surrogate", (v) => { v.elements[0].attributes.question = "\ud800"; });
  const actual = compare(cases);
  const unstructured = cases.filter((_, index) => actual[index].code === null).map((entry) => entry.name);
  assert.deepEqual(unstructured.sort(), ["canonical rejection precedes invalid format", "invalid timestamp", "normalization collision", "unpaired surrogate"]);
  console.info(`Decision Markdown rejected differential cases: ${cases.length}; structured diagnostics: ${cases.length - unstructured.length}; canonical rejections without code/path: ${unstructured.length}; acceptance, code and path differences: 0`);
});

test("bounded Decision Markdown CLI emits fixed diagnostics and no partial output", () => {
  const bad = ["{", '{"elements":[],"elements":[]}', Buffer.from([0xff]), " ".repeat(limit + 1), '{"secret":"DO_NOT_ECHO"}'];
  const amplified = input(); amplified.elements[0].attributes.question = " ".repeat(2_000_000); bad.push(JSON.stringify(amplified));
  for (const data of bad) {
    const result = run([implementation], data);
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, '{"error":{"code":"DECISION_PROJECTION_INPUT_INVALID","path":"/"}}\n');
  }
  const extraArg = run([implementation, "--unknown"], ""); assert.equal(extraArg.status, 1); assert.equal(extraArg.stdout, "");
  const exact = JSON.stringify(input()); const padded = run([implementation], exact + " ".repeat(limit - Buffer.byteLength(exact)));
  assert.equal(padded.status, 0, padded.stderr);
});

test("copied Core projection runs with no Node, Git or experimental files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-python-markdown-"));
  try {
    const core = join(directory, "core"), isolatedModule = join(core, "decision_markdown.py"), emptyPath = join(directory, "empty-bin");
    await mkdir(core); await mkdir(emptyPath);
    for (const name of await readdir(join(root, "packages/portable-core"))) if (name.endsWith(".py") && !name.startsWith("test_") && !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name)) await copyFile(join(root, "packages/portable-core", name), join(core, name));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: emptyPath, PYTHONPATH: "", PYTHONNOUSERSITE: "1" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    const result = spawnSync(executable, ["-B", isolatedModule], { cwd: directory, env, encoding: "utf8", input: JSON.stringify(input()), timeout: 30_000, maxBuffer: limit });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), projectDecisionMarkdown(input()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
