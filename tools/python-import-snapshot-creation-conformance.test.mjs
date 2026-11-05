import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
let reference;
async function nodeReference() {
  return reference ??= Promise.all(["import-snapshot-creation", "package-writer", "package-reader", "canonical"]
    .map(name => import(new URL(`../packages/kernel/src/${name}.js`, import.meta.url))))
    .then(modules => Object.assign({}, ...modules));
}
function owned(root, relative) {
  assert.equal(typeof relative, "string"); assert.equal(isAbsolute(relative), false);
  assert.equal(relative.split(/[\\/]/u).includes(".."), false);
  const path = resolve(root, relative); assert.ok(path.startsWith(root + sep)); return path;
}
function operationPath(root, value) {
  if (typeof value !== "string" || !value) return;
  assert.equal(isAbsolute(value), false);
  const path = resolve(root, value); assert.ok(path === root || path.startsWith(root + sep));
}
function operationInput(root, value) {
  if (value && typeof value === "object") for (const key of ["basePath", "outputPath"]) operationPath(root, value[key]);
}
function normalized(value, root) {
  if (typeof value === "string") return value.replaceAll(root, "ROOT")
    .replace(/\.[^/]+-[0-9]+-[0-9a-f-]{36}\.tmp/gu, ".OUTPUT-TEMP.tmp");
  if (Array.isArray(value)) return value.map(item => normalized(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item, root)]));
  return value;
}
export async function snapshotTree(root) {
  const result = {};
  async function walk(path, prefix) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), key = prefix + name, stat = await lstat(child);
      if (stat.isSymbolicLink()) result[key] = { kind: "link", target: await readlink(child) };
      else if (stat.isDirectory()) { result[key] = { kind: "directory" }; await walk(child, key + "/"); }
      else result[key] = { kind: "file", bytes: stat.size, sha256: sha(await readFile(child)), mode: stat.mode & 0o777 };
    }
  }
  await walk(root, ""); return result;
}
function edit(base, changes = []) {
  const output = structuredClone(base);
  for (const { path, value, remove } of changes) {
    let owner = output; for (const key of path.slice(0, -1)) owner = owner[key];
    if (remove) delete owner[path.at(-1)]; else owner[path.at(-1)] = structuredClone(value);
  }
  return output;
}
export async function nodeSnapshotCase(entry, fixture) {
  const api = await nodeReference(), spec = JSON.parse(entry.inputText);
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-snapshot-case-")));
  const previous = process.cwd(), mask = process.umask(0o022);
  try {
    for (const [name, text] of Object.entries(spec.baseSet ? fixture.baseSets[spec.baseSet] : fixture.baseFiles)) {
      const path = owned(root, "base/" + name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
    }
    let base = await api.readGraphPackage(join(root, "base"));
    for (const setup of spec.setup ?? []) {
      const path = owned(root, setup.path); await mkdir(dirname(path), { recursive: true });
      if (setup.kind === "directory" || setup.kind === "replace-directory") {
        if (setup.kind === "replace-directory") await rm(path, { recursive: true, force: true });
        await mkdir(path);
      }
      else if (setup.kind === "link") {
        assert.equal(isAbsolute(setup.target), false);
        const target = resolve(dirname(path), setup.target); assert.ok(target === root || target.startsWith(root + sep));
        await symlink(setup.target, path);
      }
      else await writeFile(path, setup.text ?? "owned fixture\n");
    }
    process.chdir(root);
    const request = Object.hasOwn(spec, "request") ? spec.request : edit(fixture.requests[spec.adapter ?? "repository"], spec.requestEdits);
    if (spec.expandRepositoryRoot !== undefined) request.runRequest.input.repositoryRoot = "x".repeat(spec.expandRepositoryRoot);
    if (Object.hasOwn(spec, "base")) base = spec.base;
    else base = edit(base, spec.baseEdits);
    const before = await snapshotTree(root), inputBefore = JSON.stringify(request);
    let outcome;
    try {
      let value;
      if (entry.operation === "validate") {
        value = api.validateImportSnapshotCreationRequest(request);
        outcome = { kind: "return", valueSha256: sha(JSON.stringify(value)), sameInput: value === request };
      } else if (entry.operation === "prepare") {
        value = api.prepareImportSnapshotCreation(base, request); outcome = { kind: "return", value };
      } else {
        const outputPath = Object.hasOwn(spec, "outputPath") ? spec.outputPath : "output";
        const basePath = spec.basePath ?? "base";
        if (entry.operation === "write-import") {
          const input = Object.hasOwn(spec, "input") ? spec.input : { basePath, outputPath, request };
          operationInput(root, input);
          const pending = api.writeImportedSnapshotPackage(input);
          if (spec.mutateAfterCall && input?.request) input.request.artifactId = input.request.actor;
          value = await pending;
        } else {
          const prepared = spec.writerInput ? null : api.prepareImportSnapshotCreation(base, request);
          let input = spec.writerInput ? { ...structuredClone(spec.writerInput), basePath, outputPath } :
            { basePath, outputPath, changeSet: prepared.changeSet,
              candidateElements: [prepared.candidateElement], resultingRevision: prepared.resultingRevision };
          input = Object.hasOwn(spec, "input") ? spec.input : edit(input, spec.writerEdits);
          operationInput(root, input);
          const pending = api.writeAppliedPackage(input);
          if (spec.mutateWriterRoot === "replace") Object.assign(input, { basePath: "missing", outputPath: "replaced", changeSet: null,
            candidateElements: [], resultingRevision: null, appliedChangeSetIds: false });
          if (spec.mutateWriterRoot === "nested") input.candidateElements.length = 0;
          value = await pending;
        }
        outcome = { kind: "return", value };
      }
    } catch (error) {
      outcome = { kind: "throw", name: error.name };
      for (const key of ["code", "path"]) if (Object.hasOwn(error, key)) outcome[key] = error[key];
    }
    const after = await snapshotTree(root);
    return normalized({ ...outcome, requestUnchanged: JSON.stringify(request) === inputBefore,
      before, after, baseUnchanged: JSON.stringify(Object.fromEntries(Object.entries(before).filter(([k]) => k.startsWith("base/")))) ===
        JSON.stringify(Object.fromEntries(Object.entries(after).filter(([k]) => k.startsWith("base/")))) }, root);
  } finally { process.chdir(previous); process.umask(mask); await rm(root, { recursive: true, force: true }); }
}

if (process.argv.includes("--node-replay")) {
  const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"), "utf8"));
  for (const [path, digest] of Object.entries(fixture.sources))
    assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), digest, path);
  for (const entry of fixture.cases) assert.deepEqual(await nodeSnapshotCase(entry, fixture), entry.expected, entry.id);
  process.stdout.write(JSON.stringify({ valid: true, count: fixture.cases.length }) + "\n");
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  test("frozen snapshot creation inputs and raw filesystem outcomes retain their digests", async () => {
    const bytes = await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"));
    assert.equal(sha(bytes), "2871c20d18e90152cad47c47168908bdaf76b7809c7ea49481b924832b7d1a07");
    const fixture = JSON.parse(bytes);
    assert.equal(fixture.count, 424);
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
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"), "utf8"));
    const rows = JSON.parse(text); assert.equal(rows.length, 424);
    for (let index = 0; index < rows.length; index++) {
      assert.equal(rows[index].id, fixture.cases[index].id);
      assert.deepEqual(rows[index].outcome, fixture.cases[index].expected, rows[index].id);
    }
  }
  test("Python reproduces all frozen proposal, persistence, rejection and cleanup outcomes", async () => {
    assert.match(runPython(["-m", "unittest", "test_import_snapshot_creation"]).stderr, /Ran 8 tests/);
    await verifyReplay(runPython(["test_import_snapshot_creation.py", "--replay"]).stdout);
  });
  test("46 public production modules reproduce every frozen case without Node or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "morivyx-snapshot-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
      assert.equal(modules.length, 46);
      for (const name of [...modules, "test_import_snapshot_creation.py"]) await cp(join(core, name), join(root, name));
      await mkdir(join(root, "fixtures"));
      await cp(join(core, "fixtures/import-snapshot-creation-vectors.json"), join(root, "fixtures/import-snapshot-creation-vectors.json"));
      const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      await verifyReplay(runPython(["test_import_snapshot_creation.py", "--replay", "--isolated"], {
        executable, cwd: root, env: { PATH: "", PYTHONIOENCODING: "utf-8" },
      }).stdout);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  let hasNodeSource = false;
  try { await access(new URL("../packages/kernel/src/import-snapshot-creation.js", import.meta.url)); hasNodeSource = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasNodeSource) test("current Node implementation reproduces the independently frozen reference", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--node-replay"], {
      encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { valid: true, count: 424 });
  });
  if (hasNodeSource) test("generic writer retains nullable extensions, normalization and serialization diagnostics", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"), "utf8"));
    const original = JSON.parse(fixture.cases.find(entry => entry.id === "write-applied/revise").inputText);
    const api = await nodeReference(), entries = [];
    for (const [index, fields] of [
      { extensions: { "owned/example": null } },
      { extensions: { "owned/example": { nested: [null, "e\u0301", "x\u0000y", "x\u2028y"] } } },
      { attributes: { mediaType: null } },
      { attributes: { mediaType: "e\u0301" } },
      { extensions: { "owned/example": { "<<": "ordinary data" } } },
    ].entries()) {
      const spec = structuredClone(original), input = spec.writerInput, candidate = input.candidateElements[0];
      for (const [key, value] of Object.entries(fields)) candidate[key] = { ...candidate[key], ...value };
      candidate.revision = api.revisionId(candidate);
      input.changeSet.operations[0].afterRevision = candidate.revision;
      input.changeSet.resultingRootDigest = input.resultingRevision.rootDigest = api.graphRootDigest([candidate]);
      entries.push({ id: `writer-probe-${index}`, operation: "write-applied", inputText: JSON.stringify(spec) });
    }
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: await nodeSnapshotCase(entry, fixture) });
    const actual = JSON.parse(runPython(["test_import_snapshot_creation.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.deepEqual(actual, expected);
  });
  if (hasNodeSource) test("writer captures root fields at call time and retains nested candidate references", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"), "utf8"));
    const entries = ["replace", "nested"].map(mode => ({ id: `call-capture-${mode}`, operation: "write-applied",
      inputText: JSON.stringify({ mutateWriterRoot: mode }) }));
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: await nodeSnapshotCase(entry, fixture) });
    assert.equal(expected[0].outcome.kind, "return");
    assert.equal(expected[1].outcome.code, "CHANGESET_PRECONDITION_FAILED");
    const actual = JSON.parse(runPython(["test_import_snapshot_creation.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.deepEqual(actual, expected);
  });
  if (hasNodeSource) test("unlocked unusual Schema names and a locked directory remain validation failures", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/import-snapshot-creation-vectors.json"), "utf8"));
    const entries = ["ordinary.yaml", "owned\\extra.yaml", "owned\nextra.yaml"].map((name, index) => ({
      id: `schema-extra-${index}`, operation: "write-applied", inputText: JSON.stringify({ setup: [{ path: "base/.morivyx/schemas/" + name, text: "owned invalid schema\n" }] }),
    }));
    entries.push({ id: "schema-locked-directory", operation: "write-applied", inputText: JSON.stringify({
      setup: [{ path: "base/.morivyx/schemas/morivyx.core@0.1.yaml", kind: "replace-directory" }],
    }) });
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: await nodeSnapshotCase(entry, fixture) });
    for (const row of expected) assert.equal(row.outcome.code, "CHANGESET_TARGET_VALIDATION_FAILED");
    const actual = JSON.parse(runPython(["test_import_snapshot_creation.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.deepEqual(actual, expected);
  });
}
