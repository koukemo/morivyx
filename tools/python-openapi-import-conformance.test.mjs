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
import { validateOpenApiImportRequest, validateOpenApiImportResult, importOpenApiOperation } from "../packages/kernel/src/openapi-importer.js";
import { compareOpenApiImportSnapshots } from "../packages/kernel/src/openapi-reimport.js";

const root = fileURLToPath(new URL("../", import.meta.url)), core = join(root, "packages/portable-core");
const vectors = JSON.parse(await readFile(join(core, "fixtures/openapi-import-vectors.json"), "utf8"));
const fixture = join(root, "packages/kernel/test/fixtures/openapi-importer");
const request = JSON.parse(await readFile(join(fixture, "request.json"), "utf8"));
const result = JSON.parse(await readFile(join(fixture, "result.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
const now = result.output.retrievedAt, python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const sha = value => createHash("sha256").update(value).digest("hex");
function inputFor(entry) {
  const value = structuredClone(entry.input);
  for (const part of entry.expansions ?? []) {
    assert.equal(Number.isSafeInteger(part.count) && part.count >= 0 && part.count <= 2097153, true);
    const text = part.prefix + part.unit.repeat(part.count) + part.suffix;
    assert.equal(sha(text), part.sha256);
    let owner = value;
    for (const key of part.path.slice(0, -1)) owner = owner[key];
    owner[part.path.at(-1)] = text;
  }
  return value;
}
function evaluate(entry) {
  const value = inputFor(entry), before = structuredClone(value);
  try {
    let output;
    if (entry.operation === "validate-request") output = validateOpenApiImportRequest(value);
    else if (entry.operation === "validate-result") output = validateOpenApiImportResult(value.result, value.request ?? null);
    else if (entry.operation === "compare") output = compareOpenApiImportSnapshots(value);
    else output = importOpenApiOperation(value, { now: () => {
      if (entry.clockMode === "throw") throw Error("OWNED_SENTINEL");
      return Object.hasOwn(entry, "now") ? entry.now : now;
    } });
    return { accepted: true, resultSha256: sha(canonicalJson(output)), resultJsonSha256: sha(JSON.stringify(output)) };
  } catch (error) { return { accepted: false, code: error.code ?? error.name, path: error.path ?? null }; }
  finally { assert.deepEqual(value, before, entry.id); }
}
const bulk = `import copy,hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json
from openapi_import import validate_openapi_import_request,validate_openapi_import_result,import_openapi_operation,compare_openapi_import_snapshots
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin
vectors=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'));out=[]
for entry in vectors['cases']:
 value=copy.deepcopy(entry['input'])
 for part in entry.get('expansions',[]):
  assert type(part['count']) is int and 0<=part['count']<=2097153
  text=part['prefix']+part['unit']*part['count']+part['suffix']
  assert hashlib.sha256(text.encode()).hexdigest()==part['sha256']
  owner=value
  for key in part['path'][:-1]:owner=owner[key]
  owner[part['path'][-1]]=text
 before=copy.deepcopy(value)
 def clock():
  if entry.get('clockMode')=='throw':raise RuntimeError('OWNED_SENTINEL')
  return entry.get('now',sys.argv[2])
 try:
  op=entry['operation']
  if op=='validate-request':r=validate_openapi_import_request(value)
  elif op=='validate-result':r=validate_openapi_import_result(value['result'],value.get('request'))
  elif op=='compare':r=compare_openapi_import_snapshots(value)
  else:r=import_openapi_operation(value,now=clock)
  raw=json.dumps(r,ensure_ascii=False,allow_nan=False,separators=(',',':'))
  out.append({'accepted':True,'resultSha256':hashlib.sha256(canonical_json(r).encode()).hexdigest(),'resultJsonSha256':hashlib.sha256(raw.encode()).hexdigest()})
 except ValidationError as error:out.append({'accepted':False,'code':error.code,'path':error.path})
 assert value==before,entry['id']
print(json.dumps(out,separators=(',',':')))`;
function run(args, input = "", options = {}) {
  const output = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(output.error);
  return output;
}
function assertOutcomes(actual) {
  assert.equal(actual.length, vectors.cases.length);
  for (const [index, value] of actual.entries()) assert.deepEqual(value, vectors.cases[index].expected, vectors.cases[index].id);
}

test("OpenAPI vectors pin all four operations, expansion bytes and reference sources", async () => {
  assert.equal(vectors.reference.commit, "77275695f71b8445957ada702886e48d2703b5dc");
  assert.equal(vectors.reference.node, "26.13.0");
  for (const [name, hash] of Object.entries(vectors.reference.sourceSha256)) assert.equal(sha(await readFile(join(root, "packages/kernel/src", name))), hash);
  assert.equal(vectors.cases.length, 621);
  assert.equal(new Set(vectors.cases.map(entry => entry.id)).size, 621);
  assert.deepEqual(vectors.counts, { "validate-request": 179, "validate-result": 238, import: 148, compare: 56 });
  for (const [operation, count] of Object.entries(vectors.counts)) assert.equal(vectors.cases.filter(entry => entry.operation === operation).length, count);
  assert.equal(vectors.cases.filter(entry => entry.expected.accepted).length, 221);
});

test("all 621 live Node and independent Python outcomes match frozen logical and raw JSON", () => {
  assertOutcomes(vectors.cases.map(evaluate));
  const output = run(["-c", bulk, core, now], JSON.stringify(vectors));
  assert.equal(output.status, 0, output.stderr); assert.equal(output.stderr, "");
  assertOutcomes(JSON.parse(output.stdout));
});

test("production-only Python reproduces every case and actual stdio without Node or Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-openapi-python-"));
  try {
    const runtime = join(directory, "core"), empty = join(directory, "empty");
    await mkdir(runtime); await mkdir(empty);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const executable = run(["-c", "import sys;print(sys.executable)"]).stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    const output = spawnSync(executable, ["-B", "-c", bulk, runtime, now], { cwd: directory, env, input: JSON.stringify(vectors),
      encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(output.error); assert.equal(output.status, 0, output.stderr); assert.equal(output.stderr, "");
    assertOutcomes(JSON.parse(output.stdout));
    const child = spawnSync(executable, ["-B", join(runtime, "openapi_import.py"), "--stdio"], { cwd: directory, env,
      input: JSON.stringify(request), encoding: "utf8", timeout: 30_000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "");
    assert.deepEqual(validateOpenApiImportResult(JSON.parse(child.stdout), request).output.operation, result.output.operation);
    console.info(`Production-only OpenAPI modules: ${modules.length}; frozen cases: 621; actual stdio: success`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Node and Python execution hosts both connect to the actual pure OpenAPI child", () => {
  const executable = run(["-c", "import sys;print(sys.executable)"]).stdout.trim();
  const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { ...manifest.identity }, capability: {
    id: manifest.capabilities[0].id, effect: "pure", permissions: manifest.capabilities[0].permissions, resources: manifest.capabilities[0].resources } };
  delete policy.plugin.distributor;
  const missing = structuredClone(request); const document = JSON.parse(missing.input.documentText); document.paths = {};
  missing.input.documentText = JSON.stringify(document);
  const script = join(core, "openapi_import.py");
  for (const input of [request, missing]) {
    const expectedStatus = input === request ? "success" : "failure";
    const nodeResult = runPluginProcess({ command: executable, args: ["-B", script, "--stdio"], manifest, policy, request: input });
    assert.equal(validateOpenApiImportResult(nodeResult, input).status, expectedStatus);
    const pythonResult = run(["-c", `import json,sys
sys.path.insert(0,sys.argv[1])
from plugin_runtime import run_plugin_process
from stdin_transport import read_bounded_stdin
v=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode())
r=run_plugin_process(command=sys.executable,args=['-B',sys.argv[2],'--stdio'],manifest=v['manifest'],request=v['request'],policy=v['policy'])
print(json.dumps(r,ensure_ascii=False,separators=(',',':')))`, core, script], JSON.stringify({ manifest, policy, request: input }));
    assert.equal(pythonResult.status, 0, pythonResult.stderr); assert.equal(pythonResult.stderr, "");
    assert.equal(validateOpenApiImportResult(JSON.parse(pythonResult.stdout), input).status, expectedStatus);
  }
});

test("bounded OpenAPI JSON and stdio entries keep result status distinct from protocol errors", () => {
  const script = join(core, "openapi_import.py");
  const entries = [
    { operation: "validate-request", input: request }, { operation: "validate-result", input: { result, request } },
    { operation: "import", input: request }, { operation: "compare", input: { previousResult: result, currentRequest: request, currentResult: result } },
  ];
  for (const entry of entries) {
    const output = run([script], JSON.stringify(entry));
    assert.equal(output.status, 0, output.stderr); assert.equal(output.stderr, "");
    const value = JSON.parse(output.stdout);
    if (entry.operation === "import") validateOpenApiImportResult(value.result, request);
    else if (entry.operation === "compare") assert.equal(value.report.status, "current");
    else assert.deepEqual(value, { valid: true });
  }
  for (const [args, input] of [[[], "{"], [[], Buffer.from([255])], [[], '{"operation":"import","operation":"compare"}'],
    [["OWNED_SENTINEL"], "{}"], [[], " ".repeat(8 * 1024 * 1024 + 1)]]) {
    const output = run([script, ...args], input);
    assert.equal(output.status, 1); assert.equal(output.stdout, "");
    assert.equal(output.stderr, '{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n');
  }
  const malformed = run([script, "--stdio"], "{");
  assert.equal(malformed.status, 2); assert.equal(malformed.stdout, ""); assert.equal(malformed.stderr, "PLUGIN_STDIO_INPUT_INVALID\n");
});
