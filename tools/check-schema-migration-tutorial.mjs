import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { assertSupportedNodeVersion } from "../packages/kernel/src/node-runtime.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";

assertSupportedNodeVersion();
const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.argv[2] ?? "python3";
const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-migration-tutorial-")));
const cli = "packages/kernel/src/cli.js";
const prepare = "examples/schema-migration/prepare.mjs";
function execute(command, args, { status = 0, json = true, env = process.env, cwd = repository } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return json ? JSON.parse(result.stdout) : result;
}
const node = (args, options) => execute(process.execPath, args, options);
async function snapshot(path) {
  const values = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    values[entry.name] = entry.isDirectory() ? await snapshot(child) : (await readFile(child)).toString("base64");
  }
  return values;
}
const absent = path => assert.rejects(lstat(path), { code: "ENOENT" });
try {
  const sample = join(root, "sample with spaces");
  node(["examples/getting-started/prepare.mjs", sample]);
  const base = join(sample, "base"), plan = join(root, "plan with spaces"), target = join(root, "migrated");
  const sourceSnapshot = await snapshot(base);
  const prepared = node([prepare, base, plan]);
  assert.equal(prepared.prepared, true);
  assert.deepEqual(prepared.diffKinds.toSorted(), ["entity_revised", "schema_changed"]);
  assert.notEqual(prepared.sourceSchemaLockDigest, prepared.targetSchemaLockDigest);
  assert.equal(node([cli, "report", join(plan, "diff.yaml")]).valid, true);
  const planSnapshot = await snapshot(plan);
  node([prepare, base, plan], { status: 1, json: false });
  assert.deepEqual(await snapshot(plan), planSnapshot);
  const nested = join(base, "nested-plan");
  node([prepare, base, nested], { status: 1, json: false });
  await absent(nested);
  if (process.platform !== "win32") {
    const alias = join(root, "source-alias"); await symlink(base, alias, "dir");
    node([prepare, base, join(alias, "alias-plan")], { status: 1, json: false });
    await absent(join(base, "alias-plan"));
  }
  const migration = await readYamlRecord(join(plan, "migration.yaml"));
  for (const [name, field] of [["rules.json", "rulesDigest"], ["mapping.json", "mappingDigest"]]) {
    assert.equal(migration[field], `sha256:${createHash("sha256").update(await readFile(join(plan, name))).digest("hex")}`);
  }
  const migrate = (output, input = plan, status = 0) => node([cli, "migrate", base,
    join(input, "migration.yaml"), join(input, "changeset.yaml"), join(input, "diff.yaml"),
    join(input, "revision.yaml"), output, "--target-schema", join(input, "target"),
    "--candidates", join(input, "candidates")], { status });
  const saved = migrate(target);
  assert.equal(saved.valid, true);
  assert.equal(node([cli, "validate", target]).valid, true);
  const before = await readGraphPackage(base), after = await readGraphPackage(target);
  assert.equal(after.revision.id, "graph:tutorial-migrated");
  assert.equal(after.revision.parentRevision, before.revision.id);
  assert.notEqual(after.revision.schemaLockDigest, before.revision.schemaLockDigest);
  assert.equal(after.elements.length, 1);
  const restoredElement = structuredClone(after.elements[0]);
  assert.equal(restoredElement.typeVersion, "0.2");
  assert.equal(restoredElement.attributes.migrationNote, "説明用の移行で加えた注記。");
  delete restoredElement.attributes.migrationNote;
  restoredElement.typeVersion = before.elements[0].typeVersion;
  restoredElement.revision = before.elements[0].revision;
  assert.deepEqual(restoredElement, before.elements[0]);
  assert.equal(after.migrations.at(-1).id, migration.id);
  assert.equal(after.changeSets.at(-1).id, migration.changeSetId);
  assert.equal(after.reports.at(-1).report.id, (await readYamlRecord(join(plan, "diff.yaml"))).id);
  const targetSnapshot = await snapshot(target);
  assert.equal(migrate(target, plan, 1).valid, false);
  assert.deepEqual(await snapshot(target), targetSnapshot);
  assert.equal(migrate(base, plan, 1).valid, false);

  const rejected = [];
  for (const kind of ["target-lock", "candidate", "missing-candidate"]) {
    const bad = join(root, `bad-${kind}`), output = join(root, `rejected-${kind}`);
    await cp(plan, bad, { recursive: true });
    if (kind === "target-lock") {
      const path = join(bad, "target/schema.lock.yaml"), value = await readYamlRecord(path);
      value.schemas[0].digest = `sha256:${"0".repeat(64)}`;
      await writeFile(path, serializeYamlRecord(value));
    } else if (kind === "candidate") {
      const path = join(bad, "candidates/artifact.yaml"), value = await readYamlRecord(path);
      value.attributes.migrationNote = "changed without updating its revision";
      await writeFile(path, serializeYamlRecord(value));
    } else await rm(join(bad, "candidates/artifact.yaml"));
    const badSnapshot = await snapshot(bad), report = migrate(output, bad, 1);
    assert.equal(report.valid, false); assert.ok(report.issues.length > 0);
    await absent(output);
    assert.deepEqual(await snapshot(bad), badSnapshot);
    rejected.push({ kind, codes: report.issues.map(issue => issue.code) });
  }
  assert.deepEqual(await snapshot(base), sourceSnapshot);
  assert.deepEqual(await snapshot(plan), planSnapshot);
  assert.deepEqual(await snapshot(target), targetSnapshot);

  const isolated = join(root, "python-only"), runtime = join(isolated, "portable-core"), empty = join(isolated, "empty-path");
  await mkdir(runtime, { recursive: true }); await mkdir(empty);
  const modules = (await readdir(join(repository, "packages/portable-core"))).filter(name => name.endsWith(".py") && !name.startsWith("test_"));
  for (const name of modules) await copyFile(join(repository, "packages/portable-core", name), join(runtime, name));
  await cp(base, join(isolated, "base"), { recursive: true });
  await cp(target, join(isolated, "target"), { recursive: true });
  const selected = execute(python, ["-c", "import sys;print(sys.executable)"], { json: false }).stdout.trim();
  const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of ["node", "git"]) assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
  const packagePath = join(isolated, "target/.morivyx");
  const checked = execute(selected, ["-B", join(runtime, "package_validation.py"), packagePath, "--previous", join(isolated, "base/.morivyx")], { cwd: isolated, env });
  assert.equal(checked.valid, true);
  assert.equal(checked.validation.graphConstraintsValidated, true);
  assert.equal(checked.validation.signaturesValidated, false);
  assert.equal(checked.validation.historyAncestryValidated, false);
  const decoded = execute(selected, ["-B", join(runtime, "package_records.py"), packagePath, "--export"], { cwd: isolated, env });
  assert.equal(decoded.calculatedRootDigest, after.calculatedRootDigest);
  assert.equal(decoded.calculatedSchemaLockDigest, after.calculatedSchemaLockDigest);
  assert.deepEqual(decoded.elements, after.elements);
  for (const field of ["revision", "schemaLock", "migrations", "changeSets", "approvals"]) {
    assert.deepEqual(decoded[field], after[field]);
  }
  assert.deepEqual(decoded.reports.map(entry => entry.report), after.reports.map(entry => entry.report));
  assert.deepEqual(await snapshot(join(isolated, "base")), sourceSnapshot);
  assert.deepEqual(await snapshot(join(isolated, "target")), targetSnapshot);
  assert.deepEqual(await snapshot(base), sourceSnapshot);
  assert.deepEqual(await snapshot(target), targetSnapshot);
  console.log(JSON.stringify({ valid: true, elements: after.elements.length, diffKinds: prepared.diffKinds,
    sourceUnchanged: true, existingDestinationUnchanged: true, planUnchanged: true,
    nestedPlansRefused: true, rejected, rejectedTargetsAbsent: true,
    pythonPackageVerifiedWithoutNodeOrGit: true, pythonModules: modules.length,
    python: selected, node: process.versions.node }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
