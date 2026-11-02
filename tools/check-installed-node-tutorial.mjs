import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), "morivyx-installed-node-")));
const source = join(temporary, "source", "kernel");
const distribution = join(temporary, "distribution");
const app = join(temporary, "app");
const sample = join(temporary, "sample");
const after = join(sample, "after");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  npm_config_cache: join(temporary, "npm-cache"),
  npm_config_update_notifier: "false",
};
function execute(command, args, cwd = temporary, expected = 0) {
  const result = spawnSync(command, args, {
    cwd, env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  if (expected === 0) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0);
  return result;
}
const node = (args, cwd = temporary) => JSON.parse(execute(process.execPath, args, cwd).stdout);
const runNpm = (args, cwd) => execute(npm, args, cwd);
async function snapshot(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await snapshot(path, `${prefix}${entry.name}/`));
    else entries.push([`${prefix}${entry.name}`, (await readFile(path)).toString("base64")]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
try {
  await mkdir(distribution);
  await mkdir(source, { recursive: true });
  for (const name of ["src", "package.json", "LICENSE", "NOTICE"]) {
    await cp(join(repository, "packages/kernel", name), join(source, name), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  assert.equal(manifest.name, "@morivyx/kernel");
  assert.equal(node([join(repository, "examples/getting-started/prepare.mjs"), sample]).valid, true);
  const created = node([join(repository, "packages/kernel/src/cli.js"), "create-decision", join(sample, "base"),
    join(sample, "decision.yaml"), after]);
  const original = await snapshot(sample);
  const [packed] = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", distribution], source).stdout);
  const archive = join(distribution, packed.filename);
  const archiveBytes = await readFile(archive);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  assert.equal(packed.integrity, `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`);
  for (const path of [...Object.values(manifest.exports), ...Object.values(manifest.bin)]) {
    assert(packed.files.some(file => file.path === path.replace(/^\.\//, "")));
  }
  await rm(join(temporary, "source"), { recursive: true });
  await assert.rejects(lstat(source), { code: "ENOENT" });
  await cp(join(repository, "examples/installed-node"), app, { recursive: true });
  const installed = runNpm(["install", archive, "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund"], app);
  assert.equal(installed.status, 0);
  assert.equal(runNpm(["config", "get", "engine-strict"], app).stdout.trim(), "true");
  assert.equal(runNpm(["config", "get", "ignore-scripts"], app).stdout.trim(), "true");
  const installedKernel = join(app, "node_modules/@morivyx/kernel");
  const installedYaml = join(app, "node_modules/yaml");
  for (const directory of [installedKernel, installedYaml]) {
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert((await realpath(directory)).startsWith(`${app}/node_modules/`));
  }
  for (const { path } of packed.files) {
    assert.deepEqual(await readFile(join(installedKernel, path)),
      path === "package.json" ? await readFile(join(repository, "packages/kernel/package.json"))
        : await readFile(join(repository, "packages/kernel", path)));
  }
  const lockPath = join(app, "package-lock.json");
  const lockBytes = await readFile(lockPath);
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.packages["node_modules/@morivyx/kernel"].integrity, packed.integrity);
  assert.equal(lock.packages["node_modules/yaml"].version, manifest.dependencies.yaml);
  assert.equal(lock.packages["node_modules/@morivyx/kernel"].link, undefined);
  const resolved = node(["--input-type=module", "-e", `console.log(JSON.stringify([
    import.meta.resolve('@morivyx/kernel'), import.meta.resolve('@morivyx/kernel/validator')]))`], app);
  assert(resolved.every(url => fileURLToPath(url).startsWith(`${installedKernel}/src/`)));
  const result = node([join(app, "read-package.mjs"), after], app);
  assert.equal(result.valid, true);
  assert.equal(result.graphRevision, "graph:tutorial-decision");
  assert.equal(result.rootDigest, created.rootDigest);
  assert.equal(result.elements.length, 2);
  const decision = result.elements.find(element => element.type === "core.decision");
  assert.equal(decision.attributes.question, "設定の保存形式を何にするか？");
  assert.equal(decision.lifecycle, "draft");
  assert.equal(decision.reviewState, "unreviewed");
  const cli = join(app, "node_modules/.bin/morivyx");
  assert((await realpath(cli)).startsWith(`${installedKernel}/src/`));
  assert.equal(node([cli, "validate", after], app).valid, true);
  assert.equal(node([cli, "inspect", after], app).rootDigest.calculated, result.rootDigest);
  const invalid = join(temporary, "missing-schema");
  await cp(after, invalid, { recursive: true });
  await rm(join(invalid, ".morivyx/schemas"), { recursive: true });
  const refused = execute(process.execPath, [join(app, "read-package.mjs"), invalid], app, 1);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  const diagnostic = JSON.parse(refused.stderr);
  assert.equal(diagnostic.valid, false);
  assert(diagnostic.issues.some(issue => issue.code === "SCHEMA_LOCK_MISSING"));
  const cliRefused = execute(process.execPath, [cli, "validate", invalid], app, 1);
  assert.equal(JSON.parse(cliRefused.stdout).valid, false);
  const noArgument = execute(process.execPath, [join(app, "read-package.mjs")], app, 1);
  assert.equal(noArgument.status, 1);
  assert.match(noArgument.stderr, /^Usage:/);
  // npm ci must really recreate the dependencies; a surviving installation is not evidence.
  await rm(join(app, "node_modules"), { recursive: true });
  runNpm(["ci", "--offline", "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund"], app);
  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.deepEqual(node([join(app, "read-package.mjs"), after], app), result);
  assert.equal(node([cli, "validate", after], app).valid, true);
  assert.deepEqual(await snapshot(sample), original);
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), archiveSha256);
  console.log(JSON.stringify({ valid: true, workflow: "pack-install-read-validate-ci", node: process.version,
    npm: runNpm(["--version"], app).stdout.trim(), packedFiles: packed.files.length,
    sourceCopyRemovedBeforeInstall: true, installedPackagesAreCopies: true,
    publicImportsResolveInsideConsumer: true, installedCliValidated: true,
    missingSchemaRefused: true, missingArgumentRefused: true,
    reinstalledFromLockAndCache: true, lockAndArchiveUnchanged: true, sampleUnchanged: true,
    elements: result.elements.length, yaml: manifest.dependencies.yaml }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
