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
  return reference ??= Promise.all(["import-snapshot-revision", "import-baseline", "import-snapshot-record", "package-reader"]
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
export async function nodeRevisionCase(entry, fixture) {
  const source = await api(), spec = JSON.parse(entry.inputText);
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-reimport-case-")));
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
    const request = Object.hasOwn(spec, "request") ? spec.request : edit(fixture.requests[spec.adapter ?? "repository"], spec.requestEdits);
    if (spec.expandRoot !== undefined) request.runRequest.input.repositoryRoot = "x".repeat(spec.expandRoot);
    base = Object.hasOwn(spec, "base") ? spec.base : edit(base, spec.baseEdits);
    const before = await tree(root), originalRequest = JSON.stringify(request), originalBase = JSON.stringify(base);
    let outcome;
    try {
      let value;
      if (entry.operation === "validate") {
        value = source.validateImportSnapshotRevisionRequest(request);
        outcome = { kind: "return", valueSha256: sha(JSON.stringify(value)), sameInput: value === request };
      } else if (entry.operation === "prepare") {
        outcome = { kind: "return", value: source.prepareImportSnapshotRevision(base, request) };
      } else if (entry.operation === "baseline") {
        outcome = { kind: "return", value: source.restoreImportBaseline(base, request) };
      } else if (entry.operation === "observations") {
        outcome = { kind: "return", value: source.importFollowsObservations(base, request.artifactId,
          request.runResult.output.retrievedAt, request.recordedAt) };
      } else {
        const input = Object.hasOwn(spec, "input") ? spec.input : { basePath: spec.basePath ?? "base", outputPath: spec.outputPath ?? "output", request };
        if (input && typeof input === "object") for (const key of ["basePath", "outputPath"])
          if (typeof input[key] === "string" && input[key]) pathInside(root, input[key]);
        const pending = source.writeReimportedSnapshotPackage(input);
        if (spec.mutateAfterCall && input?.request) { input.request.baselineArtifactRevision = "bad"; input.request.runResult.output.digest = "sha256:" + "0".repeat(64); }
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
  const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-revision-vectors.json"), "utf8"));
  for (const [path, digest] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), digest, path);
  for (const entry of fixture.cases) assert.deepEqual(await nodeRevisionCase(entry, fixture), entry.expected, entry.id);
  process.stdout.write(JSON.stringify({ valid: true, count: fixture.cases.length }) + "\n");
} else if (main) {
  test("frozen reimport requests and reference outcomes retain their digests", async () => {
    const bytes = await readFile(join(core, "fixtures/import-snapshot-revision-vectors.json"));
    assert.equal(sha(bytes), "26d0acf3f592142243c76c420c1c3e518e6e550d2fc7f5b2294c0cf01451d062");
    const fixture = JSON.parse(bytes);
    assert.equal(fixture.count, 575);
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
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-revision-vectors.json"), "utf8"));
    const rows = JSON.parse(text); assert.equal(rows.length, 575);
    for (let index = 0; index < rows.length; index++) {
      assert.equal(rows[index].id, fixture.cases[index].id);
      assert.deepEqual(rows[index].outcome, fixture.cases[index].expected, rows[index].id);
    }
  }
  test("Python reproduces every frozen reimport, rejection and filesystem outcome", async () => {
    assert.match(runPython(["-m", "unittest", "test_import_snapshot_revision"]).stderr, /Ran 8 tests/);
    await verifyReplay(runPython(["test_import_snapshot_revision.py", "--replay"]).stdout);
  });
  test("45 public production modules reproduce every case without Node or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "morivyx-reimport-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
      assert.equal(modules.length, 45);
      for (const name of [...modules, "test_import_snapshot_revision.py"]) await cp(join(core, name), join(root, name));
      await mkdir(join(root, "fixtures"));
      await cp(join(core, "fixtures/import-snapshot-revision-vectors.json"), join(root, "fixtures/import-snapshot-revision-vectors.json"));
      const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      await verifyReplay(runPython(["test_import_snapshot_revision.py", "--replay", "--isolated"], {
        executable, cwd: root, env: { PATH: "", PYTHONIOENCODING: "utf-8" },
      }).stdout);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  let hasNodeSource = false;
  try { await access(new URL("../packages/kernel/src/import-snapshot-revision.js", import.meta.url)); hasNodeSource = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasNodeSource) test("Node reproduces the preimplementation frozen reference", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--node-replay"], {
      encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { valid: true, count: 575 });
  });
  if (hasNodeSource) test("incomplete history records preserve native refusal and missing-field distinctions", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-revision-vectors.json"), "utf8"));
    const shapes = [["null-history", ["changeSets", 1], null],
      ["empty-record", ["changeSets", 0, "provenance", "importSnapshot"], {}],
      ["missing-op", ["changeSets", 0, "operations"], [{}]], ["null-op", ["changeSets", 0, "operations"], [null]]];
    const entries = Object.keys(fixture.initialRequests).flatMap(adapter => shapes.flatMap(([name, path, value]) =>
      ["prepare", "baseline", "observations"].map(operation => ({ id: `${adapter}/${operation}/${name}`, operation,
        inputText: JSON.stringify({ adapter, baseEdits: [{ path, value }] }) }))));
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: await nodeRevisionCase(entry, fixture) });
    const actual = JSON.parse(runPython(["test_import_snapshot_revision.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.equal(entries.length, 48); assert.deepEqual(actual, expected);
  });
}
