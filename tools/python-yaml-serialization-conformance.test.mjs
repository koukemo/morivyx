import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";

export const sha = value => createHash("sha256").update(value).digest("hex");
const root = fileURLToPath(new URL("../", import.meta.url));
export function yamlInput(spec, templates) {
  let value = Object.hasOwn(spec, "value") ? structuredClone(spec.value) : structuredClone(templates[spec.template]);
  for (const edit of spec.edits ?? []) {
    let parent = value;
    for (const key of edit.path.slice(0, -1)) parent = parent[key];
    const key = edit.path.at(-1);
    if (edit.remove) delete parent[key];
    else Object.defineProperty(parent, key, { value: structuredClone(edit.value), enumerable: true, configurable: true, writable: true });
  }
  if (spec.special === "negative-zero") value.probe = -0;
  if (spec.special === "nan") value.probe = NaN;
  if (spec.special === "infinity") value.probe = Infinity;
  if (spec.special === "cycle") value.probe = value;
  if (spec.special === "alias") { const shared = { text: "e\u0301" }; value.probe = [shared, shared]; }
  if (spec.depth) { let nested = "leaf"; for (let i = 0; i < spec.depth; i++) nested = [nested]; value.probe = nested; }
  return value;
}
export function fingerprint(value) {
  const seen = new Map(), pending = [], rows = [];
  function reference(item) {
    if (item !== null && typeof item === "object") {
      if (!seen.has(item)) { seen.set(item, pending.length); pending.push(item); }
      return ["ref", seen.get(item)];
    }
    return [typeof item, typeof item === "number" ? Object.is(item, -0) ? "-0" : String(item) : item];
  }
  const first = reference(value);
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]; rows.push(Array.isArray(item) ? ["array", item.map(reference)] : ["object", Object.entries(item).map(([k, v]) => [k, reference(v)])]);
  }
  return JSON.stringify([first, rows]);
}
export function nodeYamlCase(spec, templates) {
  const input = yamlInput(spec, templates), before = fingerprint(input);
  let result;
  try { result = { ok: true, source: serializeYamlRecord(input) }; }
  catch (error) { result = { ok: false, code: error.code ?? null, path: error.path ?? null }; }
  return { ...result, unchanged: fingerprint(input) === before };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bytes = await readFile(join(root, "packages/portable-core/fixtures/yaml-serialization-vectors.json"));
  const frozen = JSON.parse(bytes), core = join(root, "packages/portable-core");
  const selected = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  const resolvePython = spawnSync(selected, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolvePython.status, 0, resolvePython.stderr);
  const python = resolvePython.stdout.trim(), env = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  function run(args, cwd = core, input) {
    const out = spawnSync(python, ["-B", ...args], { cwd, env, input, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(out.error, undefined); assert.equal(out.status, 0, out.stderr); return out;
  }
  test("the original writer retains all pre-implementation bytes, rejection paths and inputs", async () => {
    assert.equal(frozen.count, frozen.cases.length);
    for (const [path, expected] of Object.entries(frozen.reference.sources)) assert.equal(sha(await readFile(join(root, path))), expected, path);
    for (const entry of frozen.cases) assert.deepEqual(nodeYamlCase(entry.input, frozen.templates), entry.expected, entry.id);
    assert.equal(new Set(frozen.formats).size, 13);
  });
  test("independent Python reproduces the complete frozen corpus", () => {
    const out = run(["-m", "unittest", "test_yaml_serialization"]); assert.match(out.stderr, /OK/);
    assert.deepEqual(JSON.parse(run(["test_yaml_serialization.py", "--replay"]).stdout), frozen.cases.map(entry => entry.expected));
  });
  test("the 47 public production modules replay without Node, Git or private code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-hermetic-"));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_yaml_serialization.py"]) await writeFile(join(directory, name), await readFile(join(core, name)));
      await mkdir(join(directory, "fixtures")); await writeFile(join(directory, "fixtures/yaml-serialization-vectors.json"), bytes);
      for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
      const before = (await readdir(directory)).sort();
      assert.deepEqual(JSON.parse(run(["test_yaml_serialization.py", "--replay"], directory).stdout), frozen.cases.map(entry => entry.expected));
      assert.deepEqual((await readdir(directory)).sort(), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
