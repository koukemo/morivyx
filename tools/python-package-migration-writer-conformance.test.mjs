import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeMigratedPackage } from "../packages/kernel/src/package-writer.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { canonicalJson, schemaDefinitionDigest, schemaLockDigest } from "../packages/kernel/src/canonical.js";
import { migrationSemanticDiffDigest } from "../packages/kernel/src/semantic-diff.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function owned(root, name) {
  assert.equal(typeof name, "string");
  assert.equal(isAbsolute(name), false);
  assert.equal(name.split(/[\\/]/u).includes(".."), false);
  const path = resolve(root, name);
  assert.ok(path === root || path.startsWith(root + sep));
  return path;
}
async function snapshot(root) {
  const result = {};
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), key = prefix + name, info = await lstat(path);
      if (info.isSymbolicLink()) result[key] = { kind: "link", target: await readlink(path) };
      else if (info.isDirectory()) { result[key] = { kind: "directory", mode: info.mode & 0o777 }; await walk(path, key + "/"); }
      else if (info.isFile()) result[key] = { kind: "file", bytes: info.size, sha256: hash(await readFile(path)), mode: info.mode & 0o777, links: info.nlink };
      else throw new Error("unexpected fixture file kind");
    }
  }
  await walk(root, "");
  return result;
}

// Each case owns its root. Faults replace only built-in file operations within
// this serial replay and are restored before observation or final cleanup.
export async function nodeMigrationWriterCase(spec, baseFiles) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-migration-writer-")));
  const cwd = process.cwd(), mask = process.umask(0o022), original = {}, temporaryNames = [];
  const base = join(root, "base"), output = join(root, "output");
  const normalizeString = value => {
    let text = value.split(root).join("ROOT");
    for (const name of temporaryNames) text = text.split(name).join(".output-TEMP.tmp");
    return text;
  };
  function normalize(value) {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [normalizeString(k), normalize(v)]));
    return value;
  }
  function restore() {
    for (const [key, value] of Object.entries(original)) fs.promises[key] = value;
    syncBuiltinESMExports();
  }
  try {
    for (const [name, source] of Object.entries(baseFiles)) {
      const path = owned(join(base, ".morivyx"), name);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, source);
    }
    for (const mutation of spec.mutations ?? []) {
      const path = owned(join(base, ".morivyx"), mutation.path);
      if (mutation.kind === "remove") await rm(path, { recursive: true, force: true });
      else {
        await mkdir(dirname(path), { recursive: true });
        if (mutation.kind === "write") await writeFile(path, mutation.source);
        else if (mutation.kind === "directory") await mkdir(path, { recursive: true });
        else if (mutation.kind === "symlink") { owned(dirname(path), mutation.target); await symlink(mutation.target, path); }
        else throw new Error("unknown mutation");
      }
    }
    if (spec.layout === "missing-base") await rm(base, { recursive: true });
    if (spec.layout === "base-link") await symlink("base", join(root, "alias"));
    if (spec.layout === "output-directory") await mkdir(output);
    if (spec.layout === "output-file") await writeFile(output, "owned-existing");
    if (spec.layout === "output-link") await symlink("base", output);
    if (spec.layout === "dangling-output") await symlink("absent", output);
    if (spec.layout === "parent-file") await writeFile(join(root, "parent-file"), "owned-parent");
    if (spec.layout === "output-alias-in-base") await symlink("base", join(root, "alias"));
    const request = structuredClone(spec.request);
    if (request && typeof request === "object" && !Array.isArray(request)) {
      if (!spec.omitBase) request.basePath = Object.hasOwn(spec, "baseValue") ? spec.baseValue : spec.layout === "base-link" ? join(root, "alias") : spec.baseMetadata ? join(base, ".morivyx") : base;
      if (!spec.omitOutput) request.outputPath = Object.hasOwn(spec, "outputValue") ? spec.outputValue : spec.outputRelative ? "output" : spec.layout === "output-inside" ? join(base, "nested") : spec.layout === "metadata-output" ? join(root, ".morivyx") : spec.layout === "parent-file" ? join(root, "parent-file", "output") : spec.layout === "output-alias-in-base" ? join(root, "alias", "output") : output;
    }
    process.chdir(root); process.umask(spec.umask ?? 0o022);
    const before = await snapshot(root), faults = [];
    let inputBefore = JSON.stringify(request);
    let injected = 0, published = false;
    for (const key of ["mkdir", "cp", "open", "rename", "rm", "readdir"]) {
      original[key] = fs.promises[key];
      fs.promises[key] = async (...args) => {
        const path = typeof args[0] === "string" ? args[0] : "";
        const isStage = dirname(path) === root && /^\.output-\d+-[0-9a-f-]{36}\.tmp$/u.test(path.slice(root.length + 1));
        if (key === "mkdir" && isStage && !temporaryNames.includes(path.slice(root.length + 1))) temporaryNames.push(path.slice(root.length + 1));
        const staged = temporaryNames.some(name => path === join(root, name) || path.startsWith(join(root, name) + sep));
        const shouldFail = (spec.fault === "mkdir-stage" && key === "mkdir" && isStage) ||
          (spec.fault === "copy" && key === "cp") ||
          (spec.fault === "write-record" && key === "open" && staged && path.includes("/graph/")) ||
          (spec.fault === "readback" && key === "readdir" && staged) ||
          (spec.fault === "rename-publish" && key === "rename") ||
          (["remove-stage-after-publish", "remove-stage-twice"].includes(spec.fault) && key === "rm" && isStage && published);
        const limit = spec.fault === "remove-stage-twice" ? 2 : 1;
        if (shouldFail && injected < limit) {
          injected++; faults.push({ operation: key, path });
          const error = new Error("owned fixture fault"); error.code = "EACCES"; error.path = path; throw error;
        }
        const result = await original[key](...args);
        if (key === "rename") published = true;
        return result;
      };
    }
    syncBuiltinESMExports();
    let outcome;
    try {
      const pending = writeMigratedPackage(request);
      if (spec.afterCall === "root-output-replaced") request.outputPath = join(root, "replacement");
      if (spec.afterCall === "root-record-replaced") request.migration = null;
      if (spec.afterCall === "root-candidates-replaced") request.candidateElements = [];
      if (spec.afterCall === "nested-record-changed") request.migration.targetSchemaLockDigest = "sha256:" + "a".repeat(64);
      if (spec.afterCall === "nested-candidate-changed") request.candidateElements[0].revision = "sha256:" + "b".repeat(64);
      inputBefore = JSON.stringify(request);
      outcome = { ok: true, result: await pending };
    }
    catch (error) { outcome = { ok: false, code: error.code ?? null, path: error.path ?? null }; }
    finally { restore(); }
    assert.equal(JSON.stringify(request), inputBefore);
    let reread = null;
    if (outcome.ok) {
      const { directory, ...projection } = await readGraphPackage(outcome.result.outputPath);
      reread = { sha256: hash(canonicalJson(projection)), counts: Object.fromEntries(["elements", "approvals", "changeSets", "migrations", "reports"].map(key => [key, projection[key].length])) };
    }
    return normalize({ outcome, inputUnchanged: true, before, after: await snapshot(root), reread, faults });
  } finally {
    restore(); process.chdir(cwd); process.umask(mask); await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
  const bytes = await readFile(join(core, "fixtures/package-migration-writer-vectors.json"));
  const frozen = JSON.parse(bytes);
  const clean = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  const selected = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  const resolved = spawnSync(selected, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const python = resolved.stdout.trim();
  function run(args, cwd = core, input) {
    const result = spawnSync(python, ["-B", ...args], { cwd, env: clean, input, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return result;
  }
  function replay(output) {
    const results = JSON.parse(output); assert.equal(results.length, frozen.count);
    results.forEach((value, index) => { const { id, ...actual } = value; assert.equal(id, frozen.cases[index].id); assert.deepEqual(actual, frozen.cases[index].expected, id); });
  }
  test("the original migration writer reproduces every pre-implementation result", async () => {
    assert.equal(hash(bytes), "90e1ffd76d284176de463446ade3a3785ccee12639164d30c653424158069887");
    for (const [path, expected] of Object.entries(frozen.sources)) assert.equal(hash(await readFile(new URL("../" + path, import.meta.url))), expected, path);
    for (const entry of frozen.cases) assert.deepEqual(await nodeMigrationWriterCase(entry.input, frozen.baseFiles), entry.expected, entry.id);
  });
  test("independent Python matches all saved bytes, refusals and cleanup results", () => {
    assert.match(run(["-m", "unittest", "test_package_migration_writer"]).stderr, /Ran 4 tests/);
    replay(run(["test_package_migration_writer.py", "--replay"]).stdout);
  });
  test("47 public production modules replay without Node, Git or private code", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "morivyx-migration-hermetic-")));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
      assert.equal(modules.length, 47);
      for (const name of modules) await writeFile(join(directory, name), await readFile(join(core, name)));
      await writeFile(join(directory, "test_package_migration_writer.py"), await readFile(join(core, "test_package_migration_writer.py")));
      await mkdir(join(directory, "fixtures")); await writeFile(join(directory, "fixtures/package-migration-writer-vectors.json"), bytes);
      for (const name of ["node", "git", "python3"]) assert.equal(spawnSync(name, ["--version"], { env: clean }).error?.code, "ENOENT");
      const before = await snapshot(directory);
      replay(run(["test_package_migration_writer.py", "--replay"], directory).stdout);
      assert.deepEqual(await snapshot(directory), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("additional target definition boundaries retain original results", async () => {
    const probes = [];
    const add = (id, mutate) => { const request = structuredClone(frozen.template); mutate(request); probes.push({ id, request }); };
    const rebind = request => {
      request.targetSchemaLock.schemas = request.targetSchemaDefinitions.map(value => ({ schemaId: value.schemaId, version: value.version, digest: schemaDefinitionDigest(value) }));
      const digest = schemaLockDigest(request.targetSchemaLock);
      request.changeSet.schemaLockDigest = digest; request.migration.targetSchemaLockDigest = digest;
      request.resultingRevision.schemaLockDigest = digest; request.plannedSemanticDiff.targetSchemaLockDigest = digest;
      request.migration.plannedSemanticDiffDigest = migrationSemanticDiffDigest(request.plannedSemanticDiff);
    };
    add("unbounded-relation-count", request => {
      request.targetSchemaDefinitions[0].relationTypes = [{ predicate: "core.related", sourceTypes: ["core.observation"], targetTypes: ["core.observation"], minCount: 0, maxCount: null, cycle: "allowed" }]; rebind(request);
    });
    add("target-graph-validation", request => { request.targetSchemaDefinitions[0].entityTypes[0].requiredAttributes.push("unavailable"); request.targetSchemaDefinitions[0].entityTypes[0].requiredAttributes.sort(); rebind(request); });
    for (const afterCall of ["root-output-replaced", "root-record-replaced", "root-candidates-replaced", "nested-record-changed", "nested-candidate-changed"]) probes.push({ id: afterCall, request: structuredClone(frozen.template), afterCall });
    const observations = [];
    for (const probe of probes) {
      const spec = { request: probe.request, ...(probe.afterCall ? { afterCall: probe.afterCall } : {}) };
      const expected = await nodeMigrationWriterCase(spec, frozen.baseFiles);
      const actual = JSON.parse(run(["test_package_migration_writer.py", "--probe"], core, JSON.stringify({ spec, baseFiles: frozen.baseFiles })).stdout);
      assert.deepEqual(actual, expected, probe.id);
      observations.push({ id: probe.id, inputSha256: hash(canonicalJson(spec)), expectedSha256: hash(canonicalJson(expected)),
        actualSha256: hash(canonicalJson(actual)), outcome: expected.outcome, identical: true });
    }
    console.info(JSON.stringify({ migrationWriterAdditionalProbes: observations }));
  });
}
