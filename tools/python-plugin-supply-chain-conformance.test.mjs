import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { verifyPluginSupplyChain } from "../packages/kernel/src/plugin-supply-chain.js";

const root = fileURLToPath(new URL("../", import.meta.url)), core = join(root, "packages/portable-core");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const vectors = JSON.parse(await readFile(join(core, "fixtures/plugin-supply-chain-vectors.json"), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
function edited(value, edits) {
  for (const edit of edits) {
    if (!edit.path.length) { value = structuredClone(edit.value); continue; }
    let owner = value; for (const key of edit.path.slice(0, -1)) owner = owner[key];
    if (edit.delete) delete owner[edit.path.at(-1)]; else owner[edit.path.at(-1)] = structuredClone(edit.value);
  }
  return value;
}
function inputFor(entry) {
  let value = structuredClone(vectors.template);
  if (entry.manifestSpec) value.manifest = edited(structuredClone(vectors.manifestTemplates[entry.manifestSpec.template]), entry.manifestSpec.edits);
  value = edited(value, entry.edits);
  if (value && typeof value === "object" && !Array.isArray(value) && value.artifacts && typeof value.artifacts === "object" && !Array.isArray(value.artifacts)) {
    for (const [key, data] of Object.entries(value.artifacts)) {
      if (data?.base64 !== undefined) value.artifacts[key] = Buffer.from(data.base64, "base64");
      else if (data?.repeat) value.artifacts[key] = Buffer.alloc(data.repeat.length, data.repeat.byte);
      else if (data?.view) { const bytes = Buffer.from(data.view.base64, "base64"); value.artifacts[key] = bytes.subarray(data.view.offset, data.view.offset + data.view.length); }
      else if (data && Object.hasOwn(data, "invalid")) value.artifacts[key] = data.invalid;
    }
  }
  return value;
}
function assess(input) {
  const report = verifyPluginSupplyChain(input);
  return { status: report.status, codes: report.issues.map(issue => issue.code), reportSha256: sha(canonicalJson(report)), reportJsonSha256: sha(JSON.stringify(report)) };
}
function run(args, input, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.ifError(result.error); return result;
}
const bulk = `import base64,copy,hashlib,json,sys
sys.path.insert(0,sys.argv[1])
from canonical import canonical_json
from plugin_supply_chain import verify_plugin_supply_chain
v=json.load(sys.stdin)
def edited(value,edits):
 for edit in edits:
  if not edit['path']:value=copy.deepcopy(edit['value']);continue
  owner=value
  for key in edit['path'][:-1]:owner=owner[key]
  key=edit['path'][-1]
  if edit.get('delete'):del owner[key]
  elif type(owner) is list and key==len(owner):owner.append(copy.deepcopy(edit['value']))
  else:owner[key]=copy.deepcopy(edit['value'])
 return value
results=[]
for entry in v['cases']:
 value=copy.deepcopy(v['template'])
 if 'manifestSpec' in entry:
  spec=entry['manifestSpec'];value['manifest']=edited(copy.deepcopy(v['manifestTemplates'][spec['template']]),spec['edits'])
 value=edited(value,entry['edits'])
 if type(value) is dict and type(value.get('artifacts')) is dict:
  for name,data in list(value['artifacts'].items()):
   if type(data) is not dict:continue
   if 'base64' in data:value['artifacts'][name]=base64.b64decode(data['base64'])
   elif 'repeat' in data:value['artifacts'][name]=bytes([data['repeat']['byte']])*data['repeat']['length']
   elif 'view' in data:
    d=data['view'];value['artifacts'][name]=memoryview(base64.b64decode(d['base64']))[d['offset']:d['offset']+d['length']]
   elif 'invalid' in data:value['artifacts'][name]=data['invalid']
 report=verify_plugin_supply_chain(value)
 raw=json.dumps(report,ensure_ascii=False,allow_nan=False,separators=(',',':'))
 results.append({'status':report['status'],'codes':[issue['code'] for issue in report['issues']],'reportSha256':hashlib.sha256(canonical_json(report).encode()).hexdigest(),'reportJsonSha256':hashlib.sha256(raw.encode()).hexdigest()})
print(json.dumps(results,separators=(',',':')))`;

test("frozen artifact reports retain their reference version, sources and unique cases", async () => {
  assert.equal(vectors.reference.commit, "7e519d357a7412f2a8d68ea114884b7a5250e2aa");
  assert.equal(vectors.reference.node, "26.13.0");
  for (const [name, expected] of Object.entries(vectors.reference.sourceSha256)) assert.equal(sha(await readFile(join(root, "packages/kernel/src", name))), expected, name);
  assert.equal(vectors.cases.length, 354); assert.equal(new Set(vectors.cases.map(entry => entry.id)).size, 354);
  assert.deepEqual(Object.fromEntries(["matched", "mismatch", "incomplete", "invalid"].map(status => [status, vectors.cases.filter(entry => entry.expected.status === status).length])),
    { matched: 13, mismatch: 48, incomplete: 4, invalid: 289 });
});

test("all 354 Node and independent Python reports match frozen logical and raw JSON values", () => {
  const expected = vectors.cases.map(entry => entry.expected);
  assert.deepEqual(vectors.cases.map(entry => assess(inputFor(entry))), expected);
  const result = run(["-c", bulk, core], JSON.stringify(vectors));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("bounded base64 CLI returns evidence separately from fixed input failures", () => {
  const script = join(core, "plugin_supply_chain.py");
  for (const name of ["base", "all-sidecars", "missing/package", "mismatch/package", "pin/null"]) {
    const input = inputFor(vectors.cases.find(entry => entry.id === name));
    const request = { operation: "verify", manifest: input.manifest, expectedPackageDigest: input.expectedPackageDigest,
      artifacts: Object.fromEntries(Object.entries(input.artifacts).map(([key, bytes]) => [key, bytes.toString("base64")])) };
    const result = run([script], JSON.stringify(request));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), { report: verifyPluginSupplyChain(input) });
  }
  const request = { operation: "verify", manifest: vectors.template.manifest, expectedPackageDigest: vectors.template.expectedPackageDigest, artifacts: { package: "YR==" } };
  for (const [args, input] of [[[], JSON.stringify(request)], [[], Buffer.from([255])], [[], '{"operation":"verify","operation":"verify"}'], [["NEVER_ECHO_ARGUMENT"], "{}"]]) {
    const result = run([script, ...args], input); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, '{"error":{"code":"PLUGIN_SUPPLY_CHAIN_INPUT_INVALID","path":"/"}}\n');
  }
});

test("copied production Python alone reproduces all 354 artifact reports without Node or Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-plugin-supply-"));
  try {
    const runtime = join(directory, "portable-core"), empty = join(directory, "empty-path"); await mkdir(runtime); await mkdir(empty);
    const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") &&
      !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name));
    for (const name of modules) await copyFile(join(core, name), join(runtime, name));
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
    const result = spawnSync(executable, ["-B", "-c", bulk, runtime], { cwd: directory, env,
      input: JSON.stringify(vectors), encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), vectors.cases.map(entry => entry.expected));
    console.info(`Production-only artifact modules: ${modules.length}; fixed reports: 354`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
