import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.argv[2] ?? "python3";
const temporary = await realpath(await mkdtemp(join(tmpdir(), "morivyx-validation-tutorial-")));
const sample = join(temporary, "sample with spaces");
const cli = "packages/kernel/src/cli.js";
let commandCount = 0;
function execute(command, args, status) {
  const result = spawnSync(command, args, {
    cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, `${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  commandCount++;
  return result;
}
function node(command, root, status, code) {
  const result = execute(process.execPath, [cli, command, root], status);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.equal(value.valid, status === 0);
  if (code) {
    assert(value.issues.some(issue => issue.code === code), JSON.stringify(value));
    assert(value.issues.every(issue => typeof issue.path === "string"));
  }
  return value;
}
function portable(script, root, status, code) {
  const result = execute(python, ["-B", `packages/portable-core/${script}.py`, root], status);
  if (status === 0 || code) {
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    if (code) {
      assert.equal(value.valid, false);
      assert(value.issues.some(issue => issue.code === code), JSON.stringify(value));
    }
    return value;
  }
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /package (?:read|validation) failed; no result produced/);
}
async function snapshot(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(path, relative + "/"));
    else files[relative] = (await readFile(path)).toString("base64");
  }
  return files;
}
try {
  const prepared = execute(process.execPath, ["examples/getting-started/prepare.mjs", sample], 0);
  assert.equal(JSON.parse(prepared.stdout).valid, true);
  const source = await snapshot(sample), base = join(sample, "base");
  const entity = ".morivyx/graph/entities/00000000-0000-4000-8000-000000000001.yaml";
  const originalEntity = await readFile(join(base, entity), "utf8");
  const changed = originalEntity.replace("urn:morivyx:example:storage-notes", "urn:morivyx:example:changed");
  assert.notEqual(changed, originalEntity, "negative fixture must really change the record");
  const badDigest = join(temporary, "changed record"), badYaml = join(temporary, "bad yaml");
  const missingSchema = join(temporary, "missing schema"), absent = join(temporary, "absent");
  for (const target of [badDigest, badYaml, missingSchema]) await cp(base, target, { recursive: true });
  await writeFile(join(badDigest, entity), changed);
  await writeFile(join(badYaml, entity), "format: [\n");
  await rm(join(missingSchema, ".morivyx/schemas"), { recursive: true });
  const before = await snapshot(temporary);
  assert.equal(node("inspect", base, 0).elementCount, 1);
  assert.deepEqual(node("validate", base, 0).issues, []);
  assert.equal(portable("package_records", join(base, ".morivyx"), 0).counts.elements, 1);
  const valid = portable("package_validation", join(base, ".morivyx"), 0);
  assert.equal(valid.valid, true);
  assert.equal(valid.validation.graphConstraintsValidated, true);
  assert.equal(valid.validation.signaturesValidated, false);
  const failures = [
    [absent, "PACKAGE_FILE_MISSING"],
    [badYaml, "PACKAGE_YAML_INVALID"],
    [badDigest, "REVISION_ID_MISMATCH"],
  ];
  for (const [root, code] of failures) {
    for (const command of ["inspect", "validate"]) node(command, root, 1, code);
    for (const script of ["package_records", "package_validation"]) portable(script, join(root, ".morivyx"), 1);
  }
  // A successful Node read is deliberately weaker than full Schema validation.
  assert.equal(node("inspect", missingSchema, 0).elementCount, 1);
  node("validate", missingSchema, 1, "SCHEMA_LOCK_MISSING");
  const schemaLessRead = portable("package_records", join(missingSchema, ".morivyx"), 0);
  assert.equal(schemaLessRead.validation.schemaValidated, false);
  assert.equal(schemaLessRead.validation.graphReferencesValidated, false);
  portable("package_validation", join(missingSchema, ".morivyx"), 1, "SCHEMA_LOCK_MISSING");
  const usage = execute(process.execPath, [cli, "validate", base, "--unknown"], 2);
  assert.equal(usage.stdout, ""); assert.match(usage.stderr, /使用方法/);
  const pyUsage = execute(python, ["-B", "packages/portable-core/package_validation.py", join(base, ".morivyx"), "--unknown"], 2);
  assert.equal(pyUsage.stdout, ""); assert.match(pyUsage.stderr, /usage:/i);
  for (const script of ["package_records", "package_validation"]) portable(script, base, 1);
  assert.deepEqual(await snapshot(temporary), before, "commands must not change or create input files");
  assert.deepEqual(await snapshot(sample), source, "the original sample must stay unchanged");
  console.log(JSON.stringify({ valid: true, workflow: "inspect-validate-and-diagnose", commandCount,
    sourceUnchanged: true, negativeCopiesUnchanged: true, absentInputNotCreated: true,
    pathsWithSpacesChecked: true, missingSchemaReadIsNotValidation: true,
    nodeErrors: failures.map(([, code]) => code).concat("SCHEMA_LOCK_MISSING"),
    nodeFailureJsonOnStdout: true, pythonReadFailureHasNoJson: true, usageExitCode: 2,
    node: process.version, python }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
