import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, lstat, readlink, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

export const sha = value => createHash("sha256").update(value).digest("hex");
const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
let reference;
async function api() {
  return reference ??= Promise.all(["import-availability", "package-reader"]
    .map(name => import(new URL(`../packages/kernel/src/${name}.js`, import.meta.url))))
    .then(modules => Object.assign({}, ...modules));
}
export function edit(value, changes = []) {
  value = structuredClone(value);
  for (const { path, value: next, remove } of changes) {
    let parent = value; for (const key of path.slice(0, -1)) parent = parent[key];
    if (remove) delete parent[path.at(-1)]; else parent[path.at(-1)] = structuredClone(next);
  }
  return value;
}
function pathInside(root, name) {
  assert.equal(typeof name, "string"); assert.equal(isAbsolute(name), false);
  const path = resolve(root, name); assert.ok(path === root || path.startsWith(root + sep)); return path;
}
function normalize(value, root) {
  if (typeof value === "string") return value.replaceAll(root, "ROOT").replace(/\.[^/]+-[0-9]+-[0-9a-f-]{36}\.tmp/gu, ".OUTPUT-TEMP.tmp");
  if (Array.isArray(value)) return value.map(item => normalize(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, root)]));
  return value;
}
async function tree(root) {
  const result = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), key = prefix + name, info = await lstat(child);
      if (info.isSymbolicLink()) result[key] = { kind: "link", target: await readlink(child) };
      else if (info.isDirectory()) { result[key] = { kind: "directory" }; await walk(child, key + "/"); }
      else result[key] = { kind: "file", bytes: info.size, sha256: sha(await readFile(child)), mode: info.mode & 0o777 };
    }
  }
  await walk(root); return result;
}
export async function nodeAvailabilityCase(entry, fixture) {
  const source = await api(), spec = JSON.parse(entry.inputText);
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-availability-case-")));
  const previous = process.cwd(), mask = process.umask(0o022);
  try {
    for (const [name, text] of Object.entries(fixture.baseSets[spec.baseSet ?? spec.adapter ?? "repository"])) {
      const path = pathInside(root, "base/" + name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
    }
    let base = await source.readGraphPackage(join(root, "base"));
    for (const setup of spec.setup ?? []) {
      const path = pathInside(root, setup.path); assert.notEqual(path, root);
      await mkdir(dirname(path), { recursive: true });
      if (setup.kind === "directory") await mkdir(path);
      else if (setup.kind === "link") {
        assert.equal(isAbsolute(setup.target), false);
        const target = resolve(dirname(path), setup.target); assert.ok(target === root || target.startsWith(root + sep));
        await symlink(setup.target, path);
      } else await writeFile(path, setup.text ?? "owned\n");
    }
    process.chdir(root);
    const request = Object.hasOwn(spec, "request") ? spec.request : edit(fixture.requests[spec.requestSet ?? spec.adapter ?? "repository"], spec.requestEdits);
    if (spec.expandRoot !== undefined) request.runRequest.input.repositoryRoot = "x".repeat(spec.expandRoot);
    base = Object.hasOwn(spec, "base") ? spec.base : edit(base, spec.baseEdits);
    const before = await tree(root), originalRequest = JSON.stringify(request), originalBase = JSON.stringify(base);
    let outcome;
    try {
      let value;
      if (entry.operation === "validate") {
        value = source.validateImportAvailabilityRequest(request);
        outcome = { kind: "return", valueSha256: sha(JSON.stringify(value)), sameInput: value === request };
      } else if (entry.operation === "prepare") {
        outcome = { kind: "return", value: source.prepareImportAvailability(base, request) };
      } else {
        const input = Object.hasOwn(spec, "input") ? spec.input : { basePath: Object.hasOwn(spec, "basePath") ? spec.basePath : "base", outputPath: Object.hasOwn(spec, "outputPath") ? spec.outputPath : "output", request };
        if (input && typeof input === "object") for (const key of ["basePath", "outputPath"])
          if (typeof input[key] === "string" && input[key]) pathInside(root, input[key]);
        const pending = source.writeImportAvailabilityPackage(input);
        if (spec.mutateAfterCall && input?.request) { input.request.observationId = input.request.actor; input.request.runResult.failure.code = "OWNED_MUTATED"; }
        if (spec.mutateRootAfterCall && input && typeof input === "object") { input.basePath = "missing"; input.outputPath = "replaced"; }
        value = await pending; outcome = { kind: "return", value };
      }
    } catch (error) {
      outcome = { kind: "throw", name: error.name };
      for (const key of ["code", "path"]) if (Object.hasOwn(error, key)) outcome[key] = error[key];
    }
    const after = await tree(root), basePart = value => Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("base/")));
    return normalize({ ...outcome, requestUnchanged: JSON.stringify(request) === originalRequest,
      logicalBaseUnchanged: JSON.stringify(base) === originalBase, before, after,
      baseUnchanged: JSON.stringify(basePart(before)) === JSON.stringify(basePart(after)) }, root);
  } finally { process.chdir(previous); process.umask(mask); await rm(root, { recursive: true, force: true }); }
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main && process.argv.includes("--node-replay")) {
  const fixture = JSON.parse(await readFile(join(core, "fixtures/import-availability-vectors.json"), "utf8"));
  for (const [path, digest] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), digest, path);
  for (const entry of fixture.cases) assert.deepEqual(await nodeAvailabilityCase(entry, fixture), entry.expected, entry.id);
  process.stdout.write(JSON.stringify({ valid: true, count: fixture.cases.length }) + "\n");
} else if (main) {
  test("frozen availability requests and raw filesystem outcomes retain their digests", async () => {
    const bytes = await readFile(join(core, "fixtures/import-availability-vectors.json"));
    assert.equal(sha(bytes), "2ca0536df89447a196180cde60fa7fc4a426cfd42992c4f927817635d4c34c39");
    const fixture = JSON.parse(bytes);
    assert.equal(fixture.count, 825);
    assert.equal(fixture.count, fixture.cases.length);
    for (const entry of fixture.cases) {
      assert.equal(sha(entry.inputText), entry.inputSha256, entry.id);
      assert.equal(sha(JSON.stringify(entry.expected)), entry.outputSha256, entry.id);
    }
  });
  const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  function runPython(args, { cwd = core, env = process.env, executable = python, input } = {}) {
    const child = spawnSync(executable, ["-B", ...args], { cwd, env, input, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
  }
  async function verifyReplay(text) {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-availability-vectors.json"), "utf8"));
    const rows = JSON.parse(text); assert.equal(rows.length, 825);
    for (let index = 0; index < rows.length; index++) {
      assert.equal(rows[index].id, fixture.cases[index].id);
      assert.deepEqual(rows[index].outcome, fixture.cases[index].expected, rows[index].id);
    }
  }
  test("Python reproduces every frozen availability, rejection and filesystem outcome", async () => {
    assert.match(runPython(["-m", "unittest", "test_import_availability"]).stderr, /Ran 10 tests/);
    await verifyReplay(runPython(["test_import_availability.py", "--replay"]).stdout);
  });
  test("47 public production modules reproduce every case without Node or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "morivyx-availability-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_import_availability.py"]) await cp(join(core, name), join(root, name));
      await mkdir(join(root, "fixtures"));
      await cp(join(core, "fixtures/import-availability-vectors.json"), join(root, "fixtures/import-availability-vectors.json"));
      const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      await verifyReplay(runPython(["test_import_availability.py", "--replay", "--isolated"], {
        executable, cwd: root, env: { PATH: "", PYTHONIOENCODING: "utf-8" },
      }).stdout);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  let hasNodeSource = false;
  try { await access(new URL("../packages/kernel/src/import-availability.js", import.meta.url)); hasNodeSource = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasNodeSource) test("Node reproduces the preimplementation frozen reference", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--node-replay"], {
      encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { valid: true, count: 825 });
  });
  if (hasNodeSource) test("incomplete base projections retain native diagnostics and baseline distinctions", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-availability-vectors.json"), "utf8"));
    const shapes = [["missing-artifact-revision", ["elements", 0, "revision"], null, true],
      ["null-artifact-revision", ["elements", 0, "revision"], null], ["false-artifact-revision", ["elements", 0, "revision"], false],
      ["missing-schema-digest", ["calculatedSchemaLockDigest"], null, true], ["object-schemas", ["schemaLock", "schemas"], {}],
      ["null-schemas", ["schemaLock", "schemas"], null], ["null-schema-entry", ["schemaLock", "schemas"], [null]],
      ["object-operations", ["changeSets", 1], { provenance: { importSnapshot: {} }, operations: {} }],
      ["array-saved", ["changeSets", 1], { provenance: { importSnapshot: [] }, operations: [] }],
      ["missing-schema-version", ["schemaLock", "schemas", 0, "version"], null, true],
      ["missing-base-root", ["revision", "rootDigest"], null, true], ["empty-observation", ["changeSets", 1], { provenance: { importAvailability: {} } }]];
    const entries = ["repository", "github", "figma", "openapi"].flatMap(adapter => shapes.map(([name, path, value, remove = false]) => ({
      id: `${adapter}/${name}`, operation: "prepare", inputText: JSON.stringify({ adapter, baseEdits: [{ path, value, remove }] }) })));
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: await nodeAvailabilityCase(entry, fixture) });
    const actual = JSON.parse(runPython(["test_import_availability.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.equal(entries.length, 48); assert.deepEqual(actual, expected);
  });
}
