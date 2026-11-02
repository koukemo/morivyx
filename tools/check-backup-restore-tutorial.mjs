import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.argv[2] ?? "python3";
const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-backup-tutorial-")));
const sha = (data) => createHash("sha256").update(data).digest("hex");
function execute(command, args, { cwd = repository, env = process.env, expected = 0, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  if (expected === 0) { assert.equal(result.stderr, ""); return JSON.parse(result.stdout); }
  assert.equal(result.stdout, "");
  return JSON.parse(result.stderr);
}
async function snapshot(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(path, relative + "/"));
    else { assert(entry.isFile()); result[relative] = (await readFile(path)).toString("base64"); }
  }
  return result;
}
const node = (...args) => execute(process.execPath, args);
try {
  const sample = join(root, "sample");
  assert.equal(node("examples/getting-started/prepare.mjs", sample).valid, true);
  const created = node("packages/kernel/src/cli.js", "create-decision", join(sample, "base"), join(sample, "decision.yaml"), join(sample, "after"));
  const original = await snapshot(sample);
  const nestedOutput = execute(python, ["-B", "examples/backup-restore/export.py", join(sample, "base/.morivyx"), join(sample, "base/.morivyx/backup.json")], { expected: 1 });
  assert.equal(nestedOutput.error.code, "BACKUP_OUTPUT_IN_SOURCE");
  const sourceAlias = join(root, "source-alias");
  await symlink(join(sample, "base/.morivyx"), sourceAlias);
  const aliasOutput = execute(python, ["-B", "examples/backup-restore/export.py", join(sample, "base/.morivyx"), join(sourceAlias, "backup.json")], { expected: 1 });
  assert.equal(aliasOutput.error.code, "BACKUP_OUTPUT_IN_SOURCE");
  let caseAliasChecked = false;
  try {
    const alias = join(sample, "base/.MORIVYX"), aliasInfo = await stat(alias);
    const originalInfo = await stat(join(sample, "base/.morivyx"));
    if (aliasInfo.dev === originalInfo.dev && aliasInfo.ino === originalInfo.ino) {
      const refused = execute(python, ["-B", "examples/backup-restore/export.py", join(sample, "base/.morivyx"), join(alias, "backup.json")], { expected: 1 });
      assert.equal(refused.error.code, "BACKUP_OUTPUT_IN_SOURCE");
      caseAliasChecked = true;
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.deepEqual(await snapshot(sample), original);
  const backups = [];
  for (const name of ["base", "after"]) {
    const path = join(root, `${name}.json`);
    const receipt = execute(python, ["-B", "examples/backup-restore/export.py", join(sample, name, ".morivyx"), path]);
    const data = await readFile(path);
    assert.equal(receipt.backupCreated, true);
    assert.equal(receipt.backupSha256, sha(data));
    assert.equal(receipt.backupBytes, data.length);
    assert.equal(receipt.files, Object.keys(JSON.parse(data)).length);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const before = sha(data);
    const refusal = execute(python, ["-B", "examples/backup-restore/export.py", join(sample, name, ".morivyx"), path], { expected: 1 });
    assert.equal(refusal.error.code, "BACKUP_OUTPUT_EXISTS");
    assert.equal(sha(await readFile(path)), before);
    backups.push({ name, path, receipt, files: JSON.parse(data) });
  }
  assert.deepEqual(await snapshot(sample), original);
  const isolated = join(root, "isolated"), empty = join(root, "empty-path");
  await mkdir(isolated); await mkdir(empty);
  const runtime = join(isolated, "packages/portable-core");
  await mkdir(runtime, { recursive: true });
  for (const entry of await readdir(join(repository, "packages/portable-core"))) {
    if ((entry.endsWith(".py") && !entry.startsWith("test_")) || entry === "core-schema.yaml") {
      await copyFile(join(repository, "packages/portable-core", entry), join(runtime, entry));
    }
  }
  const example = join(isolated, "examples/backup-restore");
  await mkdir(example, { recursive: true });
  for (const name of ["export.py", "restore.py"]) await copyFile(join(repository, "examples/backup-restore", name), join(example, name));
  const executable = spawnSync(python, ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(executable.status, 0);
  const selectedPython = executable.stdout.trim();
  const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
  await rm(sample, { recursive: true });
  const restore = (path, target, digest, expected = 0) => execute(selectedPython, ["-B", join(example, "restore.py"), path, target, "--sha256", digest], { cwd: isolated, env, expected });
  const parent = join(isolated, "restored");
  await mkdir(parent);
  const badPinTarget = join(parent, "bad-pin");
  assert.equal(restore(backups[0].path, badPinTarget, "not-a-digest", 1).error.code, "BACKUP_PIN_INVALID");
  await assert.rejects(stat(badPinTarget), { code: "ENOENT" });
  for (const [name, data, code] of [
    ["duplicate", Buffer.from('{"revision.yaml":"","revision.yaml":""}'), "BACKUP_INPUT_INVALID"],
    ["oversized", Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), "BACKUP_INPUT_INVALID"],
  ]) {
    const path = join(isolated, `${name}.json`), target = join(parent, name);
    await writeFile(path, data);
    assert.equal(restore(path, target, sha(data), 1).error.code, code);
    await assert.rejects(stat(target), { code: "ENOENT" });
  }
  for (const backup of backups) {
    const folder = join(parent, backup.name); await mkdir(folder);
    const target = join(folder, ".morivyx"), wrong = join(folder, "wrong-pin");
    assert.equal(restore(backup.path, wrong, "0".repeat(64), 1).error.code, "BACKUP_DIGEST_MISMATCH");
    await assert.rejects(stat(wrong), { code: "ENOENT" });
    const receipt = restore(backup.path, target, backup.receipt.backupSha256);
    assert.equal(receipt.restored, true);
    assert.equal(receipt.filesWritten, backup.receipt.files);
    assert.equal(receipt.rootDigest, backup.receipt.rootDigest);
    assert.equal(receipt.schemaLockDigest, backup.receipt.schemaLockDigest);
    assert.equal(receipt.revision, backup.receipt.graphRevision);
    const actual = await snapshot(target);
    assert.deepEqual(actual, Object.fromEntries(Object.entries(backup.files).map(([name, text]) => [name, Buffer.from(text).toString("base64")])));
    assert.equal(restore(backup.path, target, backup.receipt.backupSha256, 1).error.code, "PACKAGE_RESTORE_TARGET_UNAVAILABLE");
    assert.deepEqual(await snapshot(target), actual);
    const read = execute(selectedPython, ["-B", join(runtime, "package_records.py"), target], { cwd: isolated, env });
    assert.equal(read.calculatedRootDigest, backup.receipt.rootDigest);
    assert.equal(read.calculatedSchemaLockDigest, backup.receipt.schemaLockDigest);
    const exportedAgain = join(isolated, `${backup.name}-again.json`);
    const again = execute(selectedPython, ["-B", join(example, "export.py"), target, exportedAgain], { cwd: isolated, env });
    assert.equal(again.backupSha256, backup.receipt.backupSha256);
  }
  const base = join(parent, "base/.morivyx"), after = join(parent, "after/.morivyx");
  const checked = execute(selectedPython, ["-B", join(runtime, "package_validation.py"), after, "--previous", base], { cwd: isolated, env });
  assert.equal(checked.valid, true);
  assert.equal(checked.validation.graphConstraintsValidated, true);
  assert.equal(checked.validation.signaturesValidated, false);
  assert.equal(checked.validation.historyAncestryValidated, false);
  assert.equal((await validatePackage(join(parent, "after"))).valid, true);
  const decoded = await readGraphPackage(join(parent, "after"));
  assert.equal(decoded.revision.rootDigest, created.rootDigest);
  assert.equal(decoded.elements.length, 2);
  console.log(JSON.stringify({ valid: true, packages: backups.length, files: backups.map(b => b.receipt.files),
    sourceUnchangedBeforeRemoval: true, sourceRemovedBeforeRestore: true, nodeAndGitAbsentFromChildPath: true,
    restoredBytesMatchExport: true, rootAndSchemaDigestsMatch: true, existingBackupsAndTargetsUnchanged: true,
    wrongPinsCreateNoTarget: true, malformedInputsCreateNoTarget: true, outputsInsideSourceRefused: true, caseAliasChecked,
    python: selectedPython, node: process.versions.node }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
