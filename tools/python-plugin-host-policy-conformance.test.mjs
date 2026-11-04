import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { authorizePluginHostPolicy, validatePluginHostPolicy } from "../packages/kernel/src/plugin-host-policy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/portable-core"), python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const vectors = JSON.parse(await readFile(join(core, "fixtures/plugin-host-policy-vectors.json"), "utf8"));
function requestText(entry) {
  if (entry.inputJson) return entry.inputJson;
  const request = { operation: entry.operation, ...structuredClone(vectors.template) };
  for (const edit of entry.edits) {
    let owner = request; for (const key of edit.path.slice(0, -1)) owner = owner[key];
    if (edit.delete) delete owner[edit.path.at(-1)]; else owner[edit.path.at(-1)] = structuredClone(edit.value);
  }
  return JSON.stringify(request);
}
function assess(text) {
  const input = JSON.parse(text), before = structuredClone(input);
  let outcome;
  try {
    const result = input.operation === "validate" ? validatePluginHostPolicy(input.policy) : authorizePluginHostPolicy(input.manifest, input.capabilityId, input.policy);
    outcome = { accepted: true, resultSha256: createHash("sha256").update(canonicalJson(result)).digest("hex") };
  } catch (error) { assert.equal(typeof error.code, "string"); assert.equal(typeof error.path, "string"); outcome = { accepted: false, code: error.code, path: error.path }; }
  assert.deepEqual(input, before); return outcome;
}
function run(args, input) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error); return result;
}
const bulk = `import hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json,load_json
from plugin_host_policy import validate_plugin_host_policy,authorize_plugin_host_policy
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin
results=[]
for text in load_json(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 request=load_json(text)
 try:
  value=validate_plugin_host_policy(request['policy']) if request['operation']=='validate' else authorize_plugin_host_policy(request['manifest'],request['capabilityId'],request['policy'])
  result={'accepted':True,'resultSha256':hashlib.sha256(canonical_json(value).encode()).hexdigest()}
 except ValidationError as error:result={'accepted':False,'code':error.code,'path':error.path}
 results.append(result)
print(json.dumps(results,ensure_ascii=False,separators=(',',':')))`;

test("326 frozen host permission cases retain Node and independent Python outcomes", () => {
  assert.equal(vectors.cases.length, 326); assert.equal(vectors.cases.filter(entry => entry.expected.accepted).length, 92);
  assert.equal(new Set(vectors.cases.map(entry => entry.name)).size, vectors.cases.length);
  const requests = vectors.cases.map(requestText), expected = vectors.cases.map(entry => entry.expected);
  assert.deepEqual(requests.map(assess), expected);
  const result = run(["-c", bulk, core], JSON.stringify(requests));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("host permission CLI bounds input and separates validation from static authorization", () => {
  const { policy, manifest, capabilityId } = vectors.template, script = join(core, "plugin_host_policy.py");
  for (const input of [{ operation: "validate", policy }, { operation: "authorize", manifest, capabilityId, policy }]) {
    const result = run([script], JSON.stringify(input)); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), input.operation === "validate" ? { valid: true } : { capability: authorizePluginHostPolicy(manifest, capabilityId, policy) });
  }
  for (const [args, input] of [[[], Buffer.from([0xff])], [[], '{"secret":"NEVER_ECHO_BODY"}'],
    [[], '{"operation":"validate","operation":"authorize"}'], [["NEVER_ECHO_ARGUMENT"], "{}"], [[], " ".repeat(8 * 1024 * 1024 + 1)]]) {
    const result = run([script, ...args], input); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, '{"error":{"code":"PLUGIN_HOST_POLICY_INPUT_INVALID","path":"/"}}\n');
  }
});

test("copied production Python alone reproduces all 326 fixed host permission cases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-host-policy-"));
  try {
    const runtime = join(directory, "portable-core"), empty = join(directory, "empty-path"); await mkdir(runtime); await mkdir(empty);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
    const result = spawnSync(executable, ["-B", "-c", bulk, runtime], { cwd: directory, env,
      input: JSON.stringify(vectors.cases.map(requestText)), encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), vectors.cases.map(entry => entry.expected));
    console.info(`Production-only host permission modules: ${modules.length}; fixed cases: ${vectors.cases.length}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
