import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateGraphRevision } from "../packages/kernel/src/graph-revision.js";

const portable = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
const bytes = await readFile(join(portable, "fixtures/graph-revision-vectors.json"));
const fixture = JSON.parse(bytes);
const hash = value => createHash("sha256").update(value).digest("hex");
const pin = "579b3328862b96cc15fd58a6d7cf9a89f46e67346215bc28ae523255f515700f";
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
function run(args, input, cwd = portable, env = process.env) {
  const child = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
}
function verify(output) {
  assert.equal(output.results.length, fixture.count);
  for (let index = 0; index < fixture.count; index++) {
    const expected = fixture.vectors[index], actual = output.results[index];
    assert.deepEqual(actual.outcome, expected.expected, expected.name);
    assert.equal(actual.outputText, expected.outputText, expected.name);
    assert.equal(hash(actual.outputText), expected.outputSha256, expected.name);
  }
}
const input = JSON.stringify(fixture.vectors.map(value => value.inputText));

test("GraphRevision source pins and all frozen diagnostics still match the original public function", async () => {
  assert.equal(hash(bytes), pin); assert.equal(fixture.count, 2644); assert.equal(fixture.vectors.length, fixture.count);
  assert.equal(fixture.referenceCommit, "a9b7d8a424e8f7814672cddfa3f2ccce0308c5e2");
  assert.equal(fixture.runtime, "26.13.0");
  for (const [path, expected] of Object.entries(fixture.sources))
    assert.equal(hash(await readFile(new URL("../" + path, import.meta.url))), expected, path);
  for (const vector of fixture.vectors) {
    assert.equal(hash(vector.inputText), vector.inputSha256, vector.name);
    assert.equal(hash(vector.outputText), vector.outputSha256, vector.name);
    const value = JSON.parse(vector.inputText), before = JSON.stringify(value); let actual;
    try {
      const result = Object.hasOwn(value, "filePath") ? validateGraphRevision(value.revision, value.filePath) : validateGraphRevision(value.revision);
      actual = { valid: true, sameInput: result === value.revision, value: result };
    } catch (error) {
      actual = { valid: false, name: error.name };
      if (Object.hasOwn(error, "code")) actual.code = error.code;
      if (Object.hasOwn(error, "path")) actual.path = error.path;
    }
    assert.deepEqual(actual, vector.expected, vector.name);
    assert.equal(JSON.stringify(actual), vector.outputText, vector.name);
    assert.equal(JSON.stringify(value), before, vector.name);
  }
  assert.equal(fixture.vectors.filter(value => value.expected.valid).length, 225);
  assert.equal(fixture.vectors.filter(value => value.expected.name === "TypeError").length, 142);
});

test("independent GraphRevision matches all raw outcomes and retains the existing record checks", () => {
  assert.match(run(["-m", "unittest", "-v", "test_graph_revision"]).stderr, /Ran 6 tests/);
  assert.match(run(["-m", "unittest", "-v", "test_record_validation"]).stderr, /Ran 4 tests/);
  verify(JSON.parse(run(["test_graph_revision.py", "--vectors"], input).stdout));
});

test("only the public production modules and test driver reproduce every case without Node or Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-graph-revision-"));
  try {
    const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
    const modules = (await readdir(portable)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
    assert.equal(modules.length, 37);
    for (const name of [...modules, "test_graph_revision.py"]) await cp(join(portable, name), join(directory, name));
    const executable = run(["-c", "import sys; print(sys.executable)"]).stdout.trim();
    const child = spawnSync(executable, ["-B", "test_graph_revision.py", "--vectors"], { cwd: directory,
      env: { PATH: "", PYTHONIOENCODING: "utf-8" }, encoding: "utf8", input, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout); assert.equal(output.node, null); assert.equal(output.git, null); verify(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("binary64 source positions preserve the public function's decimal representation", () => {
  const base = JSON.parse(fixture.vectors[0].inputText).revision;
  const inputs = [], expected = [], bytes = Buffer.alloc(8);
  let state = 0x73519726;
  for (let index = 0; index < 8192; index++) {
    for (const offset of [0, 4]) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes.writeUInt32BE(state, offset);
    }
    const filePath = bytes.readDoubleBE();
    if (!Number.isFinite(filePath)) continue;
    const revision = { ...base, id: "bad" };
    let path;
    try { validateGraphRevision(revision, filePath); } catch (error) { path = error.path; }
    expected.push(path); inputs.push(JSON.stringify({ revision, filePath }));
  }
  const actual = JSON.parse(run(["test_graph_revision.py", "--vectors"], JSON.stringify(inputs)).stdout);
  assert.deepEqual(actual.results.map(value => value.outcome.path), expected);
});
