import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const core = join(repository, "packages/portable-core"), example = join(repository, "examples/backup-restore");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const vectors = JSON.parse(await readFile(join(core, "fixtures/portable-cli-vectors.json"), "utf8"));
const files = structuredClone(vectors.cases.find(value => value.name === "package-read").input);
const reportDirectory = join(repository, "packages/kernel/test/fixtures/package-v1-roundtrip/.morivyx/reports");
const reportName = (await readdir(reportDirectory)).find(name => name.endsWith(".yaml"));
files["reports/保持する別名.yaml"] = (await readFile(join(reportDirectory, reportName), "utf8")).replace("\n", "\n\n");
for (const path of ["schema.lock.yaml", Object.keys(files).find(path => path.startsWith("graph/entities/"))])
  files[path] = files[path].replace("\n", "\n\n");
function run(args, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.ifError(result.error); return result;
}
function success(result) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); return JSON.parse(result.stdout); }
function failure(result, code) {
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, JSON.stringify({ error: { code } }) + "\n");
}
async function materialize(directory, mapping) {
  for (const [name, text] of Object.entries(mapping)) { const path = join(directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
}
async function snapshot(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name), key = prefix + name, info = await lstat(full);
      if (info.isDirectory()) await visit(full, key + "/"); else result[key] = info.isSymbolicLink() ? "SYMLINK" : await readFile(full);
    }
  }
  await visit(directory); return result;
}
async function fixture(callback) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "morivyx-source-backup-")));
  try { const source = join(directory, "source with spaces/.morivyx"); await materialize(source, files); await callback({ directory, source }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const absent = path => assert.rejects(lstat(path), { code: "ENOENT" });

test("default backup bytes retain the previous result while raw export preserves every source", async () => {
  await fixture(async ({ directory, source }) => {
    const before = await snapshot(source), canonical = join(directory, "canonical.json"), raw = join(directory, "raw.json");
    const normal = success(run([join(example, "export.py"), source, canonical]));
    // Frozen from export.py at public main 847d9a15, before this option existed.
    assert.equal(normal.backupSha256, "687171d99e6a0b08b64ab4075ea22264d3f47f62634da6a46b1779726095aeec");
    assert.equal(normal.backupBytes, 14152); assert.equal(normal.sourceBytesPreserved, false);
    const receipt = success(run([join(example, "export.py"), source, raw, "--preserve-source"]));
    const data = await readFile(raw); assert.equal(receipt.backupSha256, sha(data)); assert.equal(receipt.backupBytes, data.length);
    assert.equal(receipt.sourceBytesPreserved, true); assert.equal(receipt.files, Object.keys(before).length);
    assert.notEqual(receipt.backupSha256, normal.backupSha256);
    const decoded = JSON.parse(data);
    assert.deepEqual(Object.keys(decoded).sort(), Object.keys(before).sort());
    for (const [name, body] of Object.entries(before)) assert.deepEqual(Buffer.from(decoded[name]), body, name);
    assert.equal(receipt.rootDigest, normal.rootDigest); assert.equal(receipt.schemaLockDigest, normal.schemaLockDigest);
    assert.equal((await lstat(raw)).mode & 0o777, 0o600);
    failure(run([join(example, "export.py"), source, raw, "--preserve-source"]), "BACKUP_OUTPUT_EXISTS");
    assert.deepEqual(await readFile(raw), data); assert.deepEqual(await snapshot(source), before);
  });
});

test("raw backup survives removal of the source using only copied Core and a trusted whole-file pin", async () => {
  await fixture(async ({ directory, source }) => {
    const before = await snapshot(source), runtime = join(directory, "runtime"), copiedCore = join(runtime, "packages/portable-core"), copiedExample = join(runtime, "examples/backup-restore"), empty = join(directory, "empty-bin");
    await mkdir(copiedCore, { recursive: true }); await mkdir(copiedExample, { recursive: true }); await mkdir(empty);
    for (const name of await readdir(core)) if (name.endsWith(".py") && !name.startsWith("test_")) await copyFile(join(core, name), join(copiedCore, name));
    for (const name of ["export.py", "restore.py"]) await copyFile(join(example, name), join(copiedExample, name));
    const executable = run(["-c", "import sys;print(sys.executable)"]).stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1" };
    for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
    function isolated(args) { const result = spawnSync(executable, ["-B", ...args], { cwd: runtime, env, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); assert.ifError(result.error); return result; }
    const backup = join(directory, "raw.json"), receipt = success(isolated([join(copiedExample, "export.py"), source, backup, "--preserve-source"]));
    const data = await readFile(backup); assert.equal(receipt.backupSha256, sha(data)); assert.equal(receipt.sourceBytesPreserved, true);
    assert.deepEqual(await snapshot(source), before); await rm(dirname(source), { recursive: true }); await absent(source);
    const parent = join(directory, "restored"); await mkdir(parent); const target = join(parent, ".morivyx");
    const restore = (input, destination, pin) => isolated([join(copiedExample, "restore.py"), input, destination, "--sha256", pin]);
    const wrong = join(parent, "wrong"); failure(restore(backup, wrong, "0".repeat(64)), "BACKUP_DIGEST_MISMATCH"); await absent(wrong);
    const restored = success(restore(backup, target, receipt.backupSha256)); assert.equal(restored.restored, true);
    assert.equal(restored.rootDigest, receipt.rootDigest); assert.equal(restored.schemaLockDigest, receipt.schemaLockDigest);
    assert.deepEqual(await snapshot(target), before); assert.equal((await validatePackage(parent)).valid, true);
    const read = await readGraphPackage(parent); assert.equal(read.calculatedRootDigest, receipt.rootDigest);
    const checked = success(isolated([join(copiedCore, "package_validation.py"), target])); assert.equal(checked.valid, true);
    failure(restore(backup, target, receipt.backupSha256), "PACKAGE_RESTORE_TARGET_UNAVAILABLE"); assert.deepEqual(await snapshot(target), before);
    const tampered = join(directory, "tampered.json"); await writeFile(tampered, Buffer.concat([data, Buffer.from(" ")]));
    failure(restore(tampered, wrong, receipt.backupSha256), "BACKUP_DIGEST_MISMATCH"); await absent(wrong);
    const malformed = join(directory, "malformed.json"), malformedData = Buffer.from('{"revision.yaml":"x","revision.yaml":"x"}'); await writeFile(malformed, malformedData);
    failure(restore(malformed, wrong, sha(malformedData)), "BACKUP_INPUT_INVALID"); await absent(wrong);
  });
});

test("preserving sources retains refusal of nested outputs and corrupt or linked records", async () => {
  await fixture(async ({ directory, source }) => {
    const before = await snapshot(source), backup = join(directory, "refused.json");
    failure(run([join(example, "export.py"), source, join(source, "backup.json"), "--preserve-source"]), "BACKUP_OUTPUT_IN_SOURCE");
    assert.deepEqual(await snapshot(source), before);
    const path = join(source, "revision.yaml"), original = await readFile(path);
    await writeFile(path, "{}\n"); failure(run([join(example, "export.py"), source, backup, "--preserve-source"]), "BACKUP_EXPORT_FAILED"); await absent(backup);
    await writeFile(path, original); const external = join(directory, "revision.yaml"); await writeFile(external, original); await rm(path); await symlink(external, path);
    failure(run([join(example, "export.py"), source, backup, "--preserve-source"]), "BACKUP_EXPORT_FAILED"); await absent(backup);
    assert.deepEqual(await readFile(external), original);
  });
});

test("preserved-text expansion beyond the archive limit fails before opening the backup", async () => {
  await fixture(async ({ directory, source }) => {
    for (let index = 0; index < 9; index++) await writeFile(join(source, `schemas/opaque-${index}.yaml`), "x".repeat(999999) + "\n");
    const before = await snapshot(source), backup = join(directory, "oversized.json");
    failure(run([join(example, "export.py"), source, backup, "--preserve-source"]), "BACKUP_EXPORT_FAILED");
    await absent(backup); assert.deepEqual(await snapshot(source), before);
  });
});
