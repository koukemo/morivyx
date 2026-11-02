import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readGraphPackage, readYamlRecord } from "../packages/kernel/src/package-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const portable = join(repository, "packages/portable-core");
const bytes = await readFile(new URL("./fixtures/first-public-packages.json", import.meta.url));
const corpus = JSON.parse(bytes);
const python = process.env.MORIVYX_REFERENCE_PYTHON || "python3";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fields = ["schemaLock", "revision", "elements", "approvals", "changeSets", "migrations"];

function logical(value) {
  return { ...Object.fromEntries(fields.map(key => [key, value[key]])),
    reports: value.reports.map(({ valid, type, digest, report }) => ({ valid, type, digest, report })) };
}

function invoke(script, args, input, { expected = 0, executable = python, ...options } = {}) {
  const result = spawnSync(executable, ["-B", script, ...args], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  if (result.status === 0 || script.endsWith("portable_cli.py") && result.stdout) {
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  }
  assert.equal(result.stdout, "");
  return JSON.parse(result.stderr);
}

const cli = (operation, input, options) => invoke(join(portable, "portable_cli.py"), [operation], input, options);

async function materialize(directory, files) {
  for (const [path, source] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, { flag: "wx" });
  }
}

async function snapshot(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(path, name + "/"));
    else { assert.equal(entry.isFile(), true); files[name] = await readFile(path, "utf8"); }
  }
  return files;
}

test("first public corpus binds released original bytes and frozen independent expectations", () => {
  assert.equal(sha(bytes), "152adc984bc8c1e3ec5fa4e5e410375ef1a7f73b56294af0940a956c04d1cbf7");
  assert.equal(corpus.format, "morivyx.test.first-public-packages/1");
  assert.equal(corpus.repository, "koukemo/morivyx");
  assert.equal(corpus.commit, "306dec450c30c3dd5945ca4f0ffb787b50dc4193");
  assert.equal(corpus.tagObject, "84ec87cb665977f7604505db6ee220b1acece8db");
  assert.equal(corpus.sourceManifestSha256, "3b5509a0b3e289d42122e89bc0ad0f18e08387cf915afc09c22f316fee7b19de");
  assert.equal(corpus.expectationReader.sourceCommit, corpus.commit);
  assert.equal(corpus.expectationReader.productionModules, 26);
  assert.equal(Object.keys(corpus.sourceFiles).length, 42);
  assert.deepEqual(corpus.snapshots.map(s => [s.name, Object.keys(s.files).length, s.expectedValidation.valid]),
    [["package-v1", 5, false], ["package-v1-roundtrip", 9, false], ["complete-core", 5, true]]);
  for (const source of corpus.snapshots) {
    assert.deepEqual(Object.keys(source.files).sort(), Object.keys(source.fileSha256).sort());
    for (const [path, text] of Object.entries(source.files)) assert.equal(sha(text), source.fileSha256[path]);
    if (!source.expectedValidation.valid) {
      assert.deepEqual(source.expectedValidation.issues.map(i => [i.code, i.phase]), [["SCHEMA_LOCK_MISSING", 2]]);
    }
    assert.equal(source.expectedValidation.validation.signaturesValidated, false);
    assert.equal(source.expectedValidation.validation.packageValidated, false);
  }
});

test("released packages retain logical records, digests, validation scope and canonical output", async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-first-public-read-"));
  try {
    for (const source of corpus.snapshots) {
      const directory = join(root, source.name, ".morivyx");
      await materialize(directory, source.files);
      const node = await readGraphPackage(directory), independent = cli("read-package", source.files);
      assert.deepEqual(logical(node), source.expectedLogical);
      assert.deepEqual(logical(independent), source.expectedLogical);
      for (const value of [node, independent]) {
        assert.equal(value.calculatedRootDigest, source.expectedRootDigest);
        assert.equal(value.calculatedSchemaLockDigest, source.expectedSchemaLockDigest);
      }
      const expectedStatus = source.expectedValidation.valid ? 0 : 1;
      const validation = cli("validate-package", { files: source.files }, { expected: expectedStatus });
      assert.deepEqual(validation, source.expectedValidation);
      const { validation: scope, ...expectedNode } = source.expectedValidation;
      assert.deepEqual(await validatePackage(directory), expectedNode);
      const nodeOutput = {};
      for (const path of Object.keys(source.files)) nodeOutput[path] = serializeYamlRecord(await readYamlRecord(join(directory, path)));
      assert.deepEqual(nodeOutput, source.expectedExport);
      assert.deepEqual(cli("export-package", source.files), source.expectedExport);
      assert.deepEqual(await snapshot(directory), source.files);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("released originals can be removed before isolated Python restoration and both readers agree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-first-public-restore-")));
  try {
    const runtime = join(root, "runtime"), empty = join(root, "empty-path"), originals = join(root, "originals");
    await mkdir(runtime); await mkdir(empty); await mkdir(originals);
    for (const name of await readdir(portable)) {
      if (name.endsWith(".py") && !name.startsWith("test_")) await copyFile(join(portable, name), join(runtime, name));
    }
    const probe = spawnSync(python, ["-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(probe.error); assert.equal(probe.status, 0); assert.equal(probe.stderr, "");
    const selectedPython = probe.stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env, timeout: 5_000 }).error?.code, "ENOENT");
    const backups = [];
    for (const source of corpus.snapshots) {
      const directory = join(originals, source.name, ".morivyx");
      await materialize(directory, source.files);
      const exported = cli("export-package", source.files);
      assert.deepEqual(exported, source.expectedExport);
      assert.deepEqual(await snapshot(directory), source.files);
      backups.push({ source, exported });
    }
    await rm(originals, { recursive: true });
    await assert.rejects(stat(originals), { code: "ENOENT" });
    for (const { source, exported } of backups) {
      const parent = join(root, source.name); await mkdir(parent);
      const target = join(parent, ".morivyx");
      const options = { executable: selectedPython, env, cwd: empty };
      const restored = invoke(join(runtime, "package_restore.py"), [target], exported, options);
      assert.equal(restored.restored, true);
      assert.equal(restored.filesWritten, Object.keys(exported).length);
      assert.deepEqual(await snapshot(target), exported);
      assert.deepEqual(logical(await readGraphPackage(target)), source.expectedExportLogical);
      const read = invoke(join(runtime, "package_records.py"), [target, "--export"], undefined, options);
      assert.deepEqual(logical(read), source.expectedExportLogical);
      assert.equal(read.calculatedRootDigest, source.expectedRootDigest);
      assert.equal(read.calculatedSchemaLockDigest, source.expectedSchemaLockDigest);
      const validation = invoke(join(runtime, "portable_cli.py"), ["validate-package"], { files: exported },
        { ...options, expected: source.expectedValidation.valid ? 0 : 1 });
      assert.deepEqual(validation, source.expectedValidation);
      const refused = invoke(join(runtime, "package_restore.py"), [target], exported, { ...options, expected: 1 });
      assert.equal(refused.error.code, "PACKAGE_RESTORE_TARGET_UNAVAILABLE");
      assert.deepEqual(await snapshot(target), exported);
    }
    assert.deepEqual(await readdir(empty), []);
    assert.ok((await readdir(runtime)).every(n => n.endsWith(".py") && !n.startsWith("test_")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("damaged or incomplete released data cannot produce a successful read, export or restore", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-first-public-reject-")));
  try {
    for (const source of corpus.snapshots) {
      const missing = { ...source.files }; delete missing["revision.yaml"];
      const entity = Object.keys(source.files).find(path => path.startsWith("graph/entities/"));
      assert.ok(entity);
      const damaged = { ...source.files, [entity]: source.files[entity].replace(/revision: "sha256:[0-9a-f]{64}"/, 'revision: "sha256:' + "0".repeat(64) + '"') };
      assert.notDeepEqual(damaged, source.files);
      const malformed = { ...source.files, "schema.lock.yaml": "unparsed: [\n" };
      for (const [index, files] of [missing, damaged, malformed].entries()) {
        const directory = join(root, source.name, String(index));
        await materialize(directory, files);
        await assert.rejects(readGraphPackage(directory));
        for (const operation of ["read-package", "export-package"]) {
          const result = cli(operation, files, { expected: 1 });
          assert.equal(result.error.code, "PORTABLE_INPUT_INVALID");
        }
        const target = join(root, source.name + "-refused-" + index);
        const result = invoke(join(portable, "package_restore.py"), [target], files, { expected: 1 });
        assert.equal(result.error.code, "PACKAGE_RESTORE_INPUT_INVALID");
        await assert.rejects(stat(target), { code: "ENOENT" });
        assert.deepEqual(await snapshot(directory), files);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
