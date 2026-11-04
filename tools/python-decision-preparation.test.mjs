import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareDecisionCreation } from "../packages/kernel/src/decision-creation.js";
import { prepareDecisionRevision } from "../packages/kernel/src/decision-revision.js";
import { applyChangeSet } from "../packages/kernel/src/changeset-apply.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { validateGraph, validatePackage } from "../packages/kernel/src/validator.js";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { resolveSchemaRegistry } from "../packages/kernel/src/schema-registry.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "packages/portable-core/decision_preparation.py");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const limit = 8 * 1024 * 1024;
const vectors = JSON.parse(await readFile(join(root, "packages/portable-core/fixtures/portable-cli-vectors.json"), "utf8"));
const files = vectors.cases.find((entry) => entry.name === "package-read").input;
const id = (number) => `urn:uuid:00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function request(operation = "create") {
  return { format: `morivyx.decision-${operation === "create" ? "creation" : "revision"}-request/0.1`, decisionId: id(1001),
    attributes: { question: operation === "create" ? "判断を保存する方法は？" : "判断の保存方法を再検討するか？", rationale: "根拠を保持する。\ne\u0301😀", consequences: [operation === "create" ? "後で更新できる。" : "更新した理由も保持する。"] },
    changeSetId: id(operation === "create" ? 1002 : 1003), resultingRevision: `graph:decision-${operation}`, actor: id(1), recordedAt: operation === "create" ? "2026-10-27T01:00:00+01:00" : "2026-10-27T02:00:00+01:00" };
}
function run(args, input, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * limit, ...options });
  assert.equal(result.error, undefined); return result;
}
async function materialize(directory, mapping) {
  for (const [name, source] of Object.entries(mapping)) { const path = join(directory, ".morivyx", name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
}
async function baseContents() {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-decision-base-"));
  try {
    await materialize(directory, files); const contents = await readGraphPackage(directory);
    return Object.fromEntries(["elements", "approvals", "changeSets", "migrations", "reports", "schemaLock", "revision", "calculatedSchemaLockDigest"].map((key) => [key, contents[key]]));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const loadModule = `import copy,importlib.util,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('preparation',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
from canonical import load_json
from stdin_transport import read_bounded_stdin
value=load_json(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'))
`;
function nodePrepare(value) { return (value.operation === "create" ? prepareDecisionCreation : prepareDecisionRevision)(value.contents, value.request); }
function compare(cases) {
  const code = loadModule + `out=[]
for value in value:
 before=copy.deepcopy(value)
 try: out.append({'accepted':True,'plan':(module.prepare_decision_creation if value['operation']=='create' else module.prepare_decision_revision)(value['contents'],value['request'])})
 except ValueError as error: out.append({'accepted':False,'code':getattr(error,'code',None),'path':getattr(error,'path',None)})
 assert value==before
print(json.dumps(out,ensure_ascii=False))`;
  const result = run(["-c", code, script], JSON.stringify(cases)); assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  cases.forEach((value, index) => { const before = structuredClone(value); let expected;
    try { expected = { accepted: true, plan: nodePrepare(value) }; } catch (error) { expected = { accepted: false, code: error.code ?? null, path: error.path ?? null }; }
    assert.equal(expected.accepted, value.accepted, value.name); assert.deepEqual(actual[index], expected, value.name); assert.deepEqual(value, before, value.name);
  });
  return actual;
}

test("independent creation and revision preserve exact plans and raw authoring values", async () => {
  const contents = await baseContents(), created = prepareDecisionCreation(contents, request());
  const revisedContents = { ...contents, elements: [...contents.elements, created.candidateElement], changeSets: [created.changeSet], revision: created.resultingRevision };
  const cases = [{ name: "create", operation: "create", contents, request: request(), accepted: true }];
  for (const lifecycle of ["draft", "active"]) { const value = structuredClone(revisedContents); value.elements.at(-1).lifecycle = lifecycle;
    cases.push({ name: `revise ${lifecycle}`, operation: "revise", contents: value, request: request("revise"), accepted: true }); }
  const extended = structuredClone(revisedContents); extended.elements.at(-1).extensions = { "example/meta": { preserved: true } }; extended.elements.at(-1).reviewState = "approved";
  cases.push({ name: "extensions preserved and review reset", operation: "revise", contents: extended, request: request("revise"), accepted: true });
  for (const text of ["graph:e\u0301", "graph:\u0085", "graph:\u001c"]) { const r = request(); r.resultingRevision = text; cases.push({ name: `graph ${JSON.stringify(text)}`, operation: "create", contents, request: r, accepted: true }); }
  const emptyAttributes = request(); emptyAttributes.attributes = {};
  cases.push({ name: "preparation does not validate Core attribute constraints", operation: "create", contents, request: emptyAttributes, accepted: true });
  const actual = compare(cases);
  assert.equal(actual[0].plan.candidateElement.provenance.recordedAt, request().recordedAt);
  assert.equal(actual[0].plan.candidateElement.attributes.rationale, request().attributes.rationale);
  assert.equal(actual[3].plan.candidateElement.reviewState, "unreviewed");
  assert.deepEqual(actual[3].plan.candidateElement.extensions, extended.elements.at(-1).extensions);
  console.info(`Decision preparation accepted differential cases: ${cases.length}; complete plan differences: 0`);
});

test("independent decision preparation rejects conflicting identities, states and malformed requests", async () => {
  const contents = await baseContents(), first = prepareDecisionCreation(contents, request());
  const revisedContents = { ...contents, elements: [...contents.elements, first.candidateElement], revision: first.resultingRevision };
  const cases = [];
  const add = (operation, name, edit) => { const value = { operation, name, contents: structuredClone(operation === "create" ? contents : revisedContents), request: request(operation), accepted: false }; edit(value); cases.push(value); };
  for (const operation of ["create", "revise"]) {
    for (const field of Object.keys(request(operation))) add(operation, `absent ${operation} ${field}`, (v) => { delete v.request[field]; });
    for (const value of [null, [], 1]) add(operation, `root ${operation} ${value}`, (v) => { v.request = value; });
    add(operation, `extra ${operation}`, (v) => { v.request["unknown/~"] = true; });
    add(operation, `same identity ${operation}`, (v) => { v.request.changeSetId = v.request.decisionId; });
    add(operation, `same revision ${operation}`, (v) => { v.request.resultingRevision = v.contents.revision.id; });
    add(operation, `timestamp ${operation}`, (v) => { v.request.recordedAt = "2026-02-30T00:00:00Z"; });
    add(operation, `attributes ${operation}`, (v) => { v.request.attributes = []; });
    add(operation, `surrogate ${operation}`, (v) => { v.request.attributes.question = "\ud800"; });
    add(operation, `normalization collision ${operation}`, (v) => { v.request.attributes = { "é": 1, "e\u0301": 2 }; });
    add(operation, `BOM graph ${operation}`, (v) => { v.request.resultingRevision = "graph:\ufeff"; });
    add(operation, `package ${operation}`, (v) => { v.contents = null; });
    for (const field of ["elements", "approvals", "changeSets", "migrations", "reports"]) add(operation, `change ID collision ${operation} ${field}`, (v) => { const record = { id: v.request.changeSetId }; v.contents[field].push(field === "reports" ? { report: record } : record); });
    add(operation, `raw nullable report collision ${operation}`, (v) => { v.contents.reports.push({ id: v.request.changeSetId, report: null }); });
  }
  for (const field of ["elements", "approvals", "changeSets", "migrations", "reports"]) add("create", `decision ID collision ${field}`, (v) => { const record = { id: v.request.decisionId }; v.contents[field].push(field === "reports" ? { report: record } : record); });
  add("create", "schema missing", (v) => { v.contents.schemaLock.schemas = []; });
  add("create", "null schema lock", (v) => { v.contents.schemaLock = null; });
  add("create", "raw nullable report decision collision", (v) => { v.contents.reports.push({ id: v.request.decisionId, report: null }); });
  add("revise", "target missing", (v) => { v.request.decisionId = id(999); });
  add("revise", "target type", (v) => { v.request.decisionId = contents.elements[0].id; });
  for (const state of ["accepted", "deprecated", "retired"]) add("revise", `lifecycle ${state}`, (v) => { v.contents.elements.at(-1).lifecycle = state; });
  compare(cases); console.info(`Decision preparation rejected differential cases: ${cases.length}; code/path differences: 0`);
});

test("fixed package creates, revises, applies, exports and rereads in both implementations", async () => {
  const code = loadModule + `from changeset_apply import apply_change_set
from package_records import read_package_files,write_package_files
from package_validation import validate_package_files
from package_restore import restore_package_files
from tempfile import TemporaryDirectory
from package_records import read_package
files=value['files'];out=[]
for request in value['requests']:
 contents=read_package_files(files);before=copy.deepcopy(contents)
 plan=(module.prepare_decision_creation if not out else module.prepare_decision_revision)(contents,request)
 applied=apply_change_set({'changeSet':plan['changeSet'],'currentRevision':contents['revision'],'schemaLockDigest':contents['calculatedSchemaLockDigest'],'currentElements':contents['elements'],'candidateElements':[plan['candidateElement']],'resultingRevision':plan['resultingRevision']})
 assert contents==before
 contents['elements']=applied['elements'];contents['revision']=applied['revision'];contents['changeSets'].append(plan['changeSet'])
 previous=files;files=write_package_files(contents);reread=read_package_files(files)
 with TemporaryDirectory() as temporary:
  directory=Path(temporary).resolve()/'restored'
  receipt=restore_package_files(files,directory)
  restored=read_package(directory)
  assert receipt['restored'] and restored['elements']==reread['elements']
  assert {str(p.relative_to(directory)):p.read_bytes() for p in directory.rglob('*') if p.is_file()}=={name:source.encode('utf-8') for name,source in files.items()}
 out.append({'plan':plan,'applied':applied,'files':files,'validation':validate_package_files(files,previous_files=previous),'element':next(e for e in reread['elements'] if e['id']==request['decisionId'])})
print(json.dumps(out,ensure_ascii=False))`;
  const result = run(["-c", code, script], JSON.stringify({ files, requests: [request(), request("revise")] })); assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(result.stdout); let contents = await baseContents();
  for (let i = 0; i < values.length; i++) {
    const actual = values[i], plan = (i === 0 ? prepareDecisionCreation : prepareDecisionRevision)(contents, request(i === 0 ? "create" : "revise"));
    assert.deepEqual(actual.plan, plan);
    if (i > 0) assert.notEqual(plan.changeSet.operations[0].beforeRevision, plan.changeSet.operations[0].afterRevision);
    const applied = applyChangeSet({ changeSet: plan.changeSet, currentRevision: contents.revision, schemaLockDigest: contents.calculatedSchemaLockDigest,
      currentElements: contents.elements, candidateElements: [plan.candidateElement], resultingRevision: plan.resultingRevision });
    assert.deepEqual(actual.applied, applied); assert.equal(canonicalJson(actual.element), canonicalJson(plan.candidateElement));
    const directory = await mkdtemp(join(tmpdir(), "morivyx-decision-export-")), previous = await mkdtemp(join(tmpdir(), "morivyx-decision-previous-"));
    try {
      await materialize(directory, actual.files); await materialize(previous, i === 0 ? files : values[i - 1].files);
      const { validation, ...report } = actual.validation;
      assert.deepEqual(report, await validatePackage(directory));
      const reread = await readGraphPackage(directory), prior = await readGraphPackage(previous);
      const registry = await resolveSchemaRegistry(reread.directory, reread.schemaLock);
      assert.deepEqual(report, validateGraph({ graphRevision: reread.revision.id, schemaLockDigest: reread.revision.schemaLockDigest,
        schemas: registry.schemas, elements: reread.elements, approvals: reread.approvals, registryIssues: registry.issues, previousElements: prior.elements }));
      assert.equal(canonicalJson(reread.elements), canonicalJson(applied.elements)); contents = reread;
    } finally { await rm(directory, { recursive: true, force: true }); await rm(previous, { recursive: true, force: true }); }
  }
  const cli = run([script], JSON.stringify({ operation: "create", packageFiles: files, request: request() })); assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), values[0].plan);
  console.info(`Decision preparation round trips: ${values.length}; plan, applied elements, exported reread and validation differences: 0`);
});

test("bounded preparation CLI rejects invalid input without partial output or copied secrets", () => {
  const valid = JSON.stringify({ operation: "create", packageFiles: files, request: request() });
  const requests = ["{", Buffer.from([0xff]), '{"operation":"create","operation":"revise"}', " ".repeat(limit + 1), '{"private":"DO_NOT_ECHO"}', JSON.stringify({ operation: "apply", packageFiles: files, request: request() })];
  const amplified = request(); amplified.resultingRevision = "graph:" + "a".repeat(4_300_000); requests.push(JSON.stringify({ operation: "create", packageFiles: files, request: amplified }));
  for (const input of requests) { const result = run([script], input); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, '{"error":{"code":"DECISION_PREPARATION_INPUT_INVALID","path":"/"}}\n'); }
  const padded = run([script], valid + " ".repeat(limit - Buffer.byteLength(valid))); assert.equal(padded.status, 0, padded.stderr);
  const args = run([script, "--unknown"], ""); assert.equal(args.status, 1); assert.equal(args.stdout, "");
});

test("copied Core preparation runs without Node, Git or experimental files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-preparation-isolated-"));
  try {
    const core = join(directory, "core"), isolatedScript = join(core, "decision_preparation.py"), emptyPath = join(directory, "empty-bin");
    await mkdir(core); await mkdir(emptyPath);
    for (const name of await readdir(join(root, "packages/portable-core"))) if (name.endsWith(".py") && !name.startsWith("test_")) await copyFile(join(root, "packages/portable-core", name), join(core, name));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const result = spawnSync(executable, ["-B", isolatedScript], { cwd: directory, env: { ...process.env, PATH: emptyPath, PYTHONPATH: "", PYTHONNOUSERSITE: "1" }, encoding: "utf8", timeout: 30_000, maxBuffer: limit,
      input: JSON.stringify({ operation: "create", packageFiles: files, request: request() }) });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), prepareDecisionCreation(await baseContents(), request()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
