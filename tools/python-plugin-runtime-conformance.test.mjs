import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { createPluginExecutionGrant, runPluginProcess } from "../packages/kernel/src/plugin-communication.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/portable-core"), child = join(core, "fixtures/plugin-runtime-child.py");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const vectors = JSON.parse(await readFile(join(core, "fixtures/plugin-runtime-vectors.json"), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
function valueText(entry) {
  if (entry.inputJson) return entry.inputJson;
  const value = structuredClone(vectors.templates[entry.template]);
  for (const edit of entry.edits) {
    let owner = value; for (const key of edit.path.slice(0, -1)) owner = owner[key];
    if (edit.delete) delete owner[edit.path.at(-1)]; else owner[edit.path.at(-1)] = structuredClone(edit.value);
  }
  return JSON.stringify(value);
}
function grantOutcome(value) {
  try {
    const wire = canonicalJson(createPluginExecutionGrant(value.manifest, value.request, value.policy));
    return { accepted: true, resultSha256: sha(wire), wireUtf8Bytes: Buffer.byteLength(wire) };
  } catch (error) { assert.equal(typeof error.code, "string"); return { accepted: false, code: error.code, path: error.path }; }
}
function processOptions(entry, directory) {
  const value = JSON.parse(valueText(entry));
  if (entry.inputDepth) { let nested = {}; for (let index = 0; index < entry.inputDepth; index++) nested = { next: nested }; value.request.input = nested; }
  if (entry.inputRepeat) value.request.input = { payload: "x".repeat(entry.inputRepeat) };
  const options = { ...value, command: python, args: ["-B", child, ...(entry.childArgs ?? [])], cwd: directory };
  if (entry.commandKind === "missing") options.command = join(directory, "NEVER_ECHO_MISSING");
  if (entry.cwdKind === "missing") options.cwd = join(directory, "NEVER_ECHO_CWD");
  if (entry.cwdKind === "work") options.cwd = join(directory, "work");
  for (const key of ["command", "args", "cwd"]) if (Object.hasOwn(entry, key)) options[key] = entry[key];
  return options;
}
function processOutcome(options) {
  try { const result = runPluginProcess(options); return { accepted: true, resultSha256: sha(canonicalJson(result)), status: result.status }; }
  catch (error) { assert.equal(typeof error.code, "string"); return { accepted: false, code: error.code, path: error.path }; }
}
const bulk = `import hashlib,json,os,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json,load_json
from plugin_runtime import create_plugin_execution_grant,run_plugin_process
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin
source=load_json(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'))
grants=[]
for text in source['grants']:
 value=load_json(text)
 try:
  wire=create_plugin_execution_grant(value['manifest'],value['request'],value['policy']).canonical_json.encode()
  outcome={'accepted':True,'resultSha256':hashlib.sha256(wire).hexdigest(),'wireUtf8Bytes':len(wire)}
 except ValidationError as error:outcome={'accepted':False,'code':error.code,'path':error.path}
 grants.append(outcome)
processes=[]
with tempfile.TemporaryDirectory(prefix='morivyx-runtime-bulk-') as location:
 directory=Path(location);(directory/'work').mkdir()
 for case in source['processes']:
  value=load_json(case['valueJson'])
  if case.get('inputDepth'):
   nested={}
   for _ in range(case['inputDepth']):nested={'next':nested}
   value['request']['input']=nested
  if case.get('inputRepeat'):value['request']['input']={'payload':'x'*case['inputRepeat']}
  options={key:value[key] for key in ('manifest','request','policy')}
  options.update(command=sys.executable,args=['-B',sys.argv[2],*case.get('childArgs',[])],cwd=location)
  if case.get('commandKind')=='missing':options['command']=str(directory/'NEVER_ECHO_MISSING')
  if case.get('cwdKind')=='missing':options['cwd']=str(directory/'NEVER_ECHO_CWD')
  if case.get('cwdKind')=='work':options['cwd']=str(directory/'work')
  for key in ('command','args','cwd'):
   if key in case:options[key]=case[key]
  try:
   result=run_plugin_process(**options)
   outcome={'accepted':True,'resultSha256':hashlib.sha256(canonical_json(result).encode()).hexdigest(),'status':result['status']}
  except ValidationError as error:outcome={'accepted':False,'code':error.code,'path':error.path}
  processes.append(outcome)
print(json.dumps({'grants':grants,'processes':processes,'ambientPresent':'MORIVYX_TEST_RUNTIME_AMBIENT' in os.environ},ensure_ascii=False,separators=(',',':')))`;
const payload = { grants: vectors.grantCases.map(valueText), processes: vectors.processCases.map(entry => ({ ...entry, valueJson: valueText(entry) })) };
const expected = { grants: vectors.grantCases.map(entry => entry.expected), processes: vectors.processCases.map(entry => entry.expected), ambientPresent: true };
function runBulk(executable, runtime, fixture, options = {}) {
  const result = spawnSync(executable, ["-B", "-c", bulk, runtime, fixture], { cwd: root,
    input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, MORIVYX_TEST_RUNTIME_AMBIENT: "synthetic-parent-only" }, ...options });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("371 immutable grant values and wire bytes retain frozen Node outcomes", () => {
  assert.equal(vectors.grantCases.length, 371); assert.equal(vectors.grantCases.filter(entry => entry.expected.accepted).length, 68);
  assert.equal(new Set(vectors.grantCases.map(entry => entry.name)).size, 371);
  for (const entry of vectors.grantCases) {
    const value = JSON.parse(valueText(entry)), before = structuredClone(value);
    assert.deepEqual(grantOutcome(value), entry.expected, entry.name); assert.deepEqual(value, before);
  }
});

test("64 real-process outcomes match frozen Node and independent Python transports", async () => {
  assert.equal(vectors.processCases.length, 64); assert.equal(vectors.processCases.filter(entry => entry.expected.accepted).length, 22);
  assert.equal(new Set(vectors.processCases.map(entry => entry.name)).size, 64);
  assert.equal(sha(await readFile(child)), vectors.reference.childSha256);
  const directory = await mkdtemp(join(tmpdir(), "morivyx-runtime-node-")); await mkdir(join(directory, "work"));
  const previous = process.env.MORIVYX_TEST_RUNTIME_AMBIENT; process.env.MORIVYX_TEST_RUNTIME_AMBIENT = "synthetic-parent-only";
  try {
    for (const entry of vectors.processCases) assert.deepEqual(processOutcome(processOptions(entry, directory)), entry.expected, entry.name);
  } finally {
    if (previous === undefined) delete process.env.MORIVYX_TEST_RUNTIME_AMBIENT; else process.env.MORIVYX_TEST_RUNTIME_AMBIENT = previous;
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(runBulk(python, core, child), expected);
});

test("bounded runtime CLI only creates grant data and sanitizes failures", () => {
  const script = join(core, "plugin_runtime.py"), value = vectors.templates.runtime;
  const result = spawnSync(python, ["-B", script], { input: JSON.stringify({ operation: "grant", ...value }), encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { grant: createPluginExecutionGrant(value.manifest, value.request, value.policy) });
  for (const [args, input] of [[[], Buffer.from([255])], [["NEVER_ECHO_ARGUMENT"], "{}"],
    [[], '{"operation":"run","command":"NEVER_ECHO_BODY"}'], [[], '{"operation":"grant","operation":"run"}'], [[], " ".repeat(8 * 1024 * 1024 + 1)]]) {
    const actual = spawnSync(python, ["-B", script, ...args], { input, encoding: "utf8", timeout: 30_000 });
    assert.ifError(actual.error); assert.equal(actual.status, 1); assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, '{"error":{"code":"PLUGIN_RUNTIME_INPUT_INVALID","path":"/"}}\n');
  }
});

test("copied production Python and a synthetic child reproduce all 435 cases without Node or Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-runtime-isolated-"));
  try {
    const runtime = join(directory, "portable-core"), empty = join(directory, "empty-path"), fixture = join(directory, "synthetic-child.py");
    await mkdir(runtime); await mkdir(empty); await copyFile(child, fixture);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const located = spawnSync(python, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(located.error); assert.equal(located.status, 0, located.stderr);
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1", MORIVYX_TEST_RUNTIME_AMBIENT: "synthetic-parent-only" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    assert.deepEqual(runBulk(located.stdout.trim(), runtime, fixture, { cwd: directory, env }), expected);
    console.info(`Production-only runtime modules: ${modules.length}; frozen grants: 371; actual processes: 64`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
