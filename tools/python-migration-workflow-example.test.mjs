import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { writeMigratedPackage } from "../packages/kernel/src/package-writer.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/portable-core"), script = join(root, "examples/python-migrations/workflow.py");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3", limit = 8 * 1024 * 1024;
const sample = JSON.parse(await readFile(join(root, "examples/python-migrations/sample.json"), "utf8"));
function run(args, input, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined); return result;
}
async function materialize(directory, mapping) {
  for (const [name, source] of Object.entries(mapping)) { const path = join(directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
}
async function snapshot(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) { const full = join(path, name), key = prefix + name, info = await lstat(full);
      if (info.isDirectory()) await visit(full, key + "/"); else if (info.isSymbolicLink()) result[key] = "SYMLINK"; else result[key] = await readFile(full);
    }
  }
  await visit(directory); return result;
}
async function fixture(callback, files = sample.sourceFiles) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "morivyx-python-migration-")));
  try {
    const sourceProject = join(directory, "source with spaces"), source = join(sourceProject, ".morivyx");
    await materialize(source, files); const before = await snapshot(source);
    await callback({ directory, source, sourceProject });
    assert.deepEqual(await snapshot(source), before, "migration keeps all source bytes unchanged");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function rejected(result, stage) {
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, JSON.stringify({ error: { code: "EXAMPLE_MIGRATION_FAILED", stage } }) + "\n");
}
async function target(directory, name) { const parent = join(directory, name); await mkdir(parent); return join(parent, ".morivyx"); }

test("six accepted migration plans persist the same records and digests as the Node writer", async () => {
  const generated = run(["-c", "import json,sys;sys.path.insert(0,sys.argv[1]);from test_package_migration import cases;print(json.dumps(cases()))", core], "");
  assert.equal(generated.status, 0, generated.stderr);
  const cases = JSON.parse(generated.stdout); assert.equal(cases.length, 43);
  for (const value of cases) {
    // Filesystem sources cannot omit their mapping or contain a ../ mapping key.
    if (["missing-sourceFiles", "source-path"].includes(value.name)) continue;
    const { sourceFiles, ...request } = value.input;
    await fixture(async ({ directory, source, sourceProject }) => {
      const destination = await target(directory, "python-result");
      const result = run([script, source, destination], JSON.stringify(request));
      if (!value.expected.accepted) {
        rejected(result, ["source-revision", "source-surrogate-key", "source-surrogate-value"].includes(value.name) ? "source" : "plan");
        assert.deepEqual(await readdir(dirname(destination)), []); return;
      }
      assert.equal(result.status, 0, value.name + ": " + result.stderr); assert.equal(result.stderr, "");
      const receipt = JSON.parse(result.stdout), actual = await readGraphPackage(dirname(destination));
      const schemaDirectory = join(directory, "target-schemas"); await materialize(schemaDirectory, request.targetSchemaSources);
      const targetSchemaDefinitions = await Promise.all(Object.keys(request.targetSchemaSources).map(name => readYamlRecord(join(schemaDirectory, name))));
      const nodeOutput = join(directory, "node-result");
      await writeMigratedPackage({ ...request, basePath: sourceProject, outputPath: nodeOutput, targetSchemaDefinitions });
      const expected = await readGraphPackage(nodeOutput);
      for (const field of ["elements", "changeSets", "migrations", "revision", "schemaLock", "approvals"])
        assert.equal(canonicalJson(actual[field]), canonicalJson(expected[field]), value.name + ": " + field);
      assert.equal(canonicalJson(actual.reports.map(entry => entry.report)), canonicalJson(expected.reports.map(entry => entry.report)));
      assert.equal(receipt.restored, true); assert.equal(receipt.target.graphRevision, actual.revision.id);
      assert.equal(receipt.target.rootDigest, actual.calculatedRootDigest); assert.equal(receipt.target.schemaLockDigest, actual.calculatedSchemaLockDigest);
      assert.equal(receipt.checks.plannedDiffRecalculated, true); assert.equal(receipt.checks.adoptionAuthorityValidated, false);
      assert.equal(receipt.checks.rulesAndMappingAuthenticated, false); assert.equal(receipt.checks.signaturesValidated, false);
      assert.equal((await validatePackage(dirname(destination))).valid, true);
      for (const [path, body] of Object.entries(sourceFiles)) {
        if (path.startsWith("reports/")) assert.equal(await readFile(join(destination, path), "utf8"), body);
      }
    }, sourceFiles ?? sample.sourceFiles);
  }
});

test("malformed requests and source overrides fail without output or diagnostic disclosure", async () => {
  await fixture(async ({ directory, source }) => {
    const inputs = ["{", Buffer.from([0xff]), '{"x":1,"x":2}', " ".repeat(limit + 1)];
    for (const [index, input] of inputs.entries()) {
      const destination = await target(directory, "invalid-" + index);
      rejected(run([script, source, destination], input), "input"); assert.deepEqual(await readdir(dirname(destination)), []);
    }
    const destination = await target(directory, "override");
    rejected(run([script, source, destination], JSON.stringify({ ...sample.request, sourceFiles: sample.sourceFiles })), "plan");
    assert.deepEqual(await readdir(dirname(destination)), []);
  });
});

test("existing, linked and nested destinations are refused with their bytes retained", async () => {
  await fixture(async ({ directory, source }) => {
    const existing = join(directory, "existing"); await mkdir(existing); await writeFile(join(existing, "keep"), "unchanged");
    const regular = join(directory, "regular"); await writeFile(regular, "unchanged");
    const linked = join(directory, "linked"), dangling = join(directory, "dangling"); await symlink(existing, linked); await symlink(join(directory, "absent"), dangling);
    const before = await snapshot(existing);
    const destinations = [source, join(source, "nested"), join(source, "missing/nested"), existing, regular, linked, dangling, join(directory, "missing/new"), join(linked, "new")];
    let caseAliasChecked = false;
    try { const alias = source.toUpperCase(), a = await lstat(source), b = await lstat(alias);
      if (a.dev === b.dev && a.ino === b.ino) { destinations.push(join(alias, "case-alias")); caseAliasChecked = true; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const destination of destinations) rejected(run([script, source, destination], JSON.stringify(sample.request)), "restore");
    console.info(`Protected migration destinations: ${destinations.length}; case alias checked: ${caseAliasChecked}`);
    assert.deepEqual(await snapshot(existing), before); assert.equal(await readFile(regular, "utf8"), "unchanged");
  });
});

test("interrupted migration leaves unreadable output and no success response", async () => {
  await fixture(async ({ directory, source }) => {
    const destination = await target(directory, "interrupted");
    const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('workflow',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
import package_restore
original=package_restore._write_file;count=0
def interrupted(*args):
 global count
 count+=1
 if count==2:raise OSError('NEVER_ECHO_INTERNAL_FAILURE')
 return original(*args)
package_restore._write_file=interrupted
sys.argv=[sys.argv[1],sys.argv[2],sys.argv[3]]
sys.exit(module.main())`;
    rejected(run(["-c", code, script, source, destination], JSON.stringify(sample.request)), "restore");
    assert.equal((await lstat(join(destination, ".morivyx-restore-incomplete"))).isSymbolicLink(), true);
    await assert.rejects(readGraphPackage(dirname(destination)));
    const checked = run([join(core, "package_records.py"), destination], ""); assert.equal(checked.status, 1); assert.equal(checked.stdout, "");
    const before = await snapshot(destination);
    rejected(run([script, source, destination], JSON.stringify(sample.request)), "restore");
    assert.deepEqual(await snapshot(destination), before);
  });
});

test("copied migration example and public Core run without Node, Git or a checkout", async () => {
  await fixture(async ({ directory, source }) => {
    const runtime = join(directory, "runtime"), copiedCore = join(runtime, "packages/portable-core"), copiedScript = join(runtime, "examples/python-migrations/workflow.py"), empty = join(directory, "empty-bin");
    await mkdir(copiedCore, { recursive: true }); await mkdir(dirname(copiedScript), { recursive: true }); await mkdir(empty);
    for (const name of await readdir(core)) if (name.endsWith(".py") && !name.startsWith("test_") && !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name)) await copyFile(join(core, name), join(copiedCore, name));
    await copyFile(script, copiedScript);
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONNOUSERSITE: "1" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    const destination = await target(directory, "isolated-result");
    const result = spawnSync(executable, ["-B", copiedScript, source, destination], { cwd: runtime, env, input: JSON.stringify(sample.request), encoding: "utf8", timeout: 60_000, maxBuffer: limit });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).target.rootDigest, (await readGraphPackage(dirname(destination))).calculatedRootDigest);
  });
});
