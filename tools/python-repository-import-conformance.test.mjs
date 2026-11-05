import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { runPluginProcess } from "../packages/kernel/src/plugin-communication.js";
import { validateRepositoryImportRequest, validateRepositoryImportResult, importRepositoryFile,
  compareRepositoryImportSnapshots } from "../packages/kernel/src/repository-importer.js";
import { assessRepositoryReimport } from "../packages/kernel/src/repository-reimport-assessment.js";

const root = fileURLToPath(new URL("../", import.meta.url)), core = join(root, "packages/portable-core");
const source = join(root, "packages/kernel/test/fixtures/plugin-communication/repository");
const vectors = JSON.parse(await readFile(join(core, "fixtures/repository-import-vectors.json"), "utf8"));
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const sha = value => createHash("sha256").update(value).digest("hex");
function inputFor(entry) {
  const value = structuredClone(entry.input);
  if (entry.operation === "import" && typeof value?.input?.repositoryRoot === "string" && value.input.repositoryRoot.startsWith("@FIXTURE@")) {
    value.input.repositoryRoot = value.input.repositoryRoot.replace("@FIXTURE@", source);
  }
  return value;
}
async function evaluate(entry) {
  const value = inputFor(entry);
  try {
    let result;
    if (entry.operation === "validate-request") result = validateRepositoryImportRequest(value);
    else if (entry.operation === "validate-result") result = validateRepositoryImportResult(value.result, value.request ?? null);
    else if (entry.operation === "compare") result = compareRepositoryImportSnapshots(value);
    else if (entry.operation === "assess") result = assessRepositoryReimport(value);
    else result = await importRepositoryFile(value, { now: () => Object.hasOwn(entry, "now") ? entry.now : "2026-09-05T01:00:00Z" });
    return { accepted: true, resultSha256: sha(canonicalJson(result)), resultJsonSha256: sha(JSON.stringify(result)) };
  } catch (error) { return { accepted: false, code: error.code ?? error.name, path: error.path ?? null }; }
}
const bulk = `import copy,hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json
from repository_import import validate_repository_import_request,validate_repository_import_result,import_repository_file,compare_repository_import_snapshots,assess_repository_reimport
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin
v=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'));out=[]
for e in v['cases']:
 x=copy.deepcopy(e['input']);op=e['operation']
 if op=='import' and type(x) is dict and type(x.get('input')) is dict and type(x['input'].get('repositoryRoot')) is str and x['input']['repositoryRoot'].startswith('@FIXTURE@'):x['input']['repositoryRoot']=sys.argv[2]+x['input']['repositoryRoot'][9:]
 try:
  if op=='validate-request':r=validate_repository_import_request(x)
  elif op=='validate-result':r=validate_repository_import_result(x['result'],x.get('request'))
  elif op=='compare':r=compare_repository_import_snapshots(x)
  elif op=='assess':r=assess_repository_reimport(x)
  else:r=import_repository_file(x,now=lambda:e.get('now','2026-09-05T01:00:00Z'))
  raw=json.dumps(r,ensure_ascii=False,allow_nan=False,separators=(',',':'))
  out.append({'accepted':True,'resultSha256':hashlib.sha256(canonical_json(r).encode()).hexdigest(),'resultJsonSha256':hashlib.sha256(raw.encode()).hexdigest()})
 except ValidationError as error:out.append({'accepted':False,'code':error.code,'path':error.path})
print(json.dumps(out,separators=(',',':')))`;
function run(args, input, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error); return result;
}

test("frozen repository cases pin the reference source and all five operation counts", async () => {
  assert.equal(vectors.reference.commit, "d17b1e7d05d71688c2f5a8755b258217d6424384");
  assert.equal(vectors.reference.node, "26.13.0");
  for (const [name, hash] of Object.entries(vectors.reference.sourceSha256)) assert.equal(sha(await readFile(join(root, "packages/kernel/src", name))), hash);
  assert.equal(vectors.cases.length, 615); assert.equal(new Set(vectors.cases.map(entry => entry.id)).size, 615);
  assert.deepEqual(Object.fromEntries(["validate-request", "validate-result", "compare", "assess", "import"].map(op => [op, vectors.cases.filter(e => e.operation === op).length])),
    { "validate-request": 148, "validate-result": 162, compare: 42, assess: 91, import: 172 });
});

test("all 615 live Node and Python results match frozen values and raw JSON", async () => {
  const expected = vectors.cases.map(entry => entry.expected), actual = [];
  for (const entry of vectors.cases) actual.push(await evaluate(entry));
  assert.deepEqual(actual, expected);
  const result = run(["-c", bulk, core, source], JSON.stringify(vectors));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("production-only Python with no Node or Git reproduces 615 cases including actual local imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-repository-python-"));
  try {
    const runtime = join(directory, "core"), fixture = join(directory, "fixture"), empty = join(directory, "empty");
    await mkdir(runtime); await mkdir(fixture); await mkdir(empty);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    await copyFile(join(source, "source.txt"), join(fixture, "source.txt"));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    const result = spawnSync(executable, ["-B", "-c", bulk, runtime, fixture], { cwd: directory, env,
      input: JSON.stringify(vectors), encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), vectors.cases.map(entry => entry.expected));
    const request = inputFor(vectors.cases.find(e => e.id.startsWith("import/clock/") && e.now === "2026-09-05T01:00:00Z"));
    request.input.repositoryRoot = fixture;
    const child = spawnSync(executable, ["-B", join(runtime, "repository_import.py"), "--stdio"], { cwd: directory, env,
      input: JSON.stringify(request), encoding: "utf8", timeout: 30_000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.equal(validateRepositoryImportResult(JSON.parse(child.stdout), request).output.digest,
      "sha256:41719047f9824d28ef29e87214bbeb2c25e31dcd2a8c9ff3a28fda3ca4cd1353");
    console.info(`Production-only repository modules: ${modules.length}; fixed cases: 615; actual stdio import: success`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Node and Python execution hosts connect to the actual Python repository child", async () => {
  const fixture = async name => JSON.parse(await readFile(join(root, "packages/kernel/test/fixtures", name), "utf8"));
  const manifest = await fixture("plugin-manifest/repository-importer.json"), policy = await fixture("plugin-manifest/host-policy.json");
  const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
  const request = inputFor(vectors.cases.find(e => e.id.startsWith("import/clock/") && e.now === "2026-09-05T01:00:00Z"));
  for (const locator of ["source.txt", "missing.txt"]) {
    const current = structuredClone(request); current.input.locator = locator;
    const options = { command: executable, args: ["-B", join(core, "repository_import.py"), "--stdio"], manifest, policy, request: current };
    const node = runPluginProcess(options); validateRepositoryImportResult(node, current);
    const code = `import json,sys;sys.path.insert(0,sys.argv[1]);from plugin_runtime import run_plugin_process;print(json.dumps(run_plugin_process(**json.load(sys.stdin)),ensure_ascii=False,separators=(',',':')))`;
    const pythonResult = run(["-c", code, core], JSON.stringify(options));
    assert.equal(pythonResult.status, 0, pythonResult.stderr); assert.equal(pythonResult.stderr, "");
    const actual = JSON.parse(pythonResult.stdout); validateRepositoryImportResult(actual, current);
    for (const result of [node, actual]) {
      assert.equal(result.status, locator === "source.txt" ? "success" : "failure");
      if (result.status === "success") assert.equal(result.output.digest, "sha256:41719047f9824d28ef29e87214bbeb2c25e31dcd2a8c9ff3a28fda3ca4cd1353");
      else assert.equal(result.failure.code, "REPOSITORY_IMPORT_TARGET_MISSING");
    }
  }
});

test("bounded JSON CLI exposes validation, comparison, assessment and local import", async () => {
  for (const operation of ["validate-request", "validate-result", "compare", "assess", "import"]) {
    const entry = vectors.cases.find(e => e.operation === operation && e.expected.accepted);
    const value = inputFor(entry), result = run([join(core, "repository_import.py")], JSON.stringify({ operation, input: value }));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    if (operation.startsWith("validate")) assert.deepEqual(output, { valid: true });
    else if (operation === "compare") assert.deepEqual(output.report, compareRepositoryImportSnapshots(value));
    else if (operation === "assess") assert.deepEqual(output.report, assessRepositoryReimport(value));
    else validateRepositoryImportResult(output.result);
  }
});
