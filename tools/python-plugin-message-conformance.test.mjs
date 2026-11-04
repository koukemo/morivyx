import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { authorizePluginRunRequest, validatePluginRunRequest, validatePluginRunResult } from "../packages/kernel/src/plugin-communication.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/portable-core"), python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const vectors = JSON.parse(await readFile(join(core, "fixtures/plugin-message-vectors.json"), "utf8"));
function requestText(entry) {
  if (entry.inputJson) return entry.inputJson;
  const value = { operation: entry.operation, ...structuredClone(vectors.templates[entry.template]) };
  for (const edit of entry.edits) {
    let owner = value; for (const key of edit.path.slice(0, -1)) owner = owner[key];
    if (edit.delete) delete owner[edit.path.at(-1)]; else owner[edit.path.at(-1)] = structuredClone(edit.value);
  }
  return JSON.stringify(value);
}
function assess(text) {
  const value = JSON.parse(text), before = structuredClone(value);
  let outcome;
  try {
    const result = value.operation === "validate-request" ? validatePluginRunRequest(value.request) :
      value.operation === "authorize-request" ? authorizePluginRunRequest(value.manifest, value.request) : validatePluginRunResult(value.result, value.request);
    outcome = { accepted: true, resultSha256: createHash("sha256").update(canonicalJson(result)).digest("hex") };
  } catch (error) { assert.equal(typeof error.code, "string"); assert.equal(typeof error.path, "string"); outcome = { accepted: false, code: error.code, path: error.path }; }
  assert.deepEqual(value, before); return outcome;
}
function run(args, input) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error); return result;
}
const bulk = `import hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json,load_json
from plugin_messages import validate_plugin_run_request,authorize_plugin_run_request,validate_plugin_run_result
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin
results=[]
for text in load_json(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 request=load_json(text)
 try:
  operation=request['operation']
  if operation=='validate-request':value=validate_plugin_run_request(request['request'])
  elif operation=='authorize-request':value=authorize_plugin_run_request(request['manifest'],request['request'])
  else:value=validate_plugin_run_result(request['result'],request.get('request'))
  result={'accepted':True,'resultSha256':hashlib.sha256(canonical_json(value).encode()).hexdigest()}
 except ValidationError as error:result={'accepted':False,'code':error.code,'path':error.path}
 results.append(result)
print(json.dumps(results,ensure_ascii=False,separators=(',',':')))`;

test("311 frozen plugin message cases retain Node and independent Python outcomes", () => {
  assert.equal(vectors.cases.length, 311); assert.equal(vectors.cases.filter(entry => entry.expected.accepted).length, 71);
  assert.equal(new Set(vectors.cases.map(entry => entry.name)).size, vectors.cases.length);
  const requests = vectors.cases.map(requestText), expected = vectors.cases.map(entry => entry.expected);
  assert.deepEqual(requests.map(assess), expected);
  const result = run(["-c", bulk, core], JSON.stringify(requests));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("message CLI separates three operations and uses bounded sanitized diagnostics", () => {
  const { manifest, request, result } = vectors.templates.base, script = join(core, "plugin_messages.py");
  const inputs = [{ operation: "validate-request", request }, { operation: "authorize-request", manifest, request },
    { operation: "validate-result", result, request }, { operation: "validate-result", result },
    { operation: "validate-result", result: vectors.templates.failure.result, request: null }];
  for (const input of inputs) {
    const actual = run([script], JSON.stringify(input)); assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stderr, "");
    assert.deepEqual(JSON.parse(actual.stdout), input.operation === "authorize-request" ? { capability: authorizePluginRunRequest(manifest, request) } : { valid: true });
  }
  for (const [args, input] of [[[], Buffer.from([0xff])], [[], '{"secret":"NEVER_ECHO_BODY"}'],
    [[], '{"operation":"validate-request","operation":"validate-result"}'], [["NEVER_ECHO_ARGUMENT"], "{}"], [[], " ".repeat(8 * 1024 * 1024 + 1)]]) {
    const actual = run([script, ...args], input); assert.equal(actual.status, 1); assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, '{"error":{"code":"PLUGIN_MESSAGES_INPUT_INVALID","path":"/"}}\n');
  }
});

test("copied production Python alone reproduces all 311 fixed message cases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-plugin-messages-"));
  try {
    const runtime = join(directory, "portable-core"), empty = join(directory, "empty-path"); await mkdir(runtime); await mkdir(empty);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
    const actual = spawnSync(executable, ["-B", "-c", bulk, runtime], { cwd: directory, env,
      input: JSON.stringify(vectors.cases.map(requestText)), encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(actual.error); assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stderr, "");
    assert.deepEqual(JSON.parse(actual.stdout), vectors.cases.map(entry => entry.expected));
    console.info(`Production-only plugin message modules: ${modules.length}; fixed cases: ${vectors.cases.length}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
