import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const kernelDirectory = join(scriptDirectory, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const manifest = JSON.parse(
  await readFile(join(kernelDirectory, "package.json"), "utf8"),
);
assert.equal(manifest.license, "Apache-2.0");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "morivyx-npm-pack-"),
);
const cacheDirectory = join(temporaryDirectory, "npm-cache");
const consumerDirectory = join(temporaryDirectory, "consumer");

function runNpm(arguments_, cwd) {
  return spawnSync(npmCommand, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: cacheDirectory,
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

try {
  const packed = runNpm(
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryDirectory,
    ],
    kernelDirectory,
  );

  assertSucceeded(packed);
  const [tarball] = JSON.parse(packed.stdout);
  const filesByPath = new Map(
    tarball.files.map((file) => [file.path, file]),
  );
  const publicTargets = [
    ...Object.values(manifest.exports),
    ...Object.values(manifest.bin),
  ].map((target) => target.replace(/^\.\//, ""));

  assert.ok(filesByPath.has("package.json"));
  for (const target of publicTargets) {
    assert.ok(filesByPath.has(target), `tarball is missing ${target}`);
  }
  for (const target of Object.values(manifest.bin)) {
    const path = target.replace(/^\.\//, "");
    assert.notEqual(
      filesByPath.get(path).mode & 0o111,
      0,
      `${path} is not executable`,
    );
  }
  assert.deepEqual(
    tarball.files
      .map((file) => file.path)
      .filter((path) => path !== "package.json" && !path.startsWith("src/"))
      .sort(),
    ["LICENSE", "NOTICE"],
  );

  await mkdir(consumerDirectory);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const localDependencies = Object.keys(manifest.dependencies ?? {}).map(
    (dependency) => join(kernelDirectory, "node_modules", dependency),
  );
  const installed = runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--no-save",
      ...localDependencies,
      join(temporaryDirectory, tarball.filename),
    ],
    consumerDirectory,
  );
  assertSucceeded(installed);

  for (const name of ["LICENSE", "NOTICE"]) {
    const repositoryBytes = await readFile(join(kernelDirectory, "..", "..", name));
    assert.deepEqual(await readFile(join(kernelDirectory, name)), repositoryBytes);
    assert.deepEqual(
      await readFile(join(consumerDirectory, "node_modules", manifest.name, name)),
      repositoryBytes,
    );
  }

  const publicExports = Object.keys(manifest.exports).map((target) =>
    target === "." ? manifest.name : `${manifest.name}${target.slice(1)}`,
  );
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
      for (const target of ${JSON.stringify(publicExports)}) {
        const module = await import(target);
        if (Object.keys(module).length === 0) throw new Error(target);
      }
      const { runNetworkImportContainer } = await import("@morivyx/kernel/network-import-container");
      assert.equal(typeof runNetworkImportContainer, "function");
      await assert.rejects(
        () => runNetworkImportContainer(null),
        (error) => error.code === "NETWORK_IMPORT_INPUT_INVALID",
      );
      const { prepareProposalReview } = await import("@morivyx/kernel/proposal-review");
      assert.equal(typeof prepareProposalReview, "function");
      await assert.rejects(
        () => prepareProposalReview(null),
        (error) => error.code === "PROPOSAL_REVIEW_INPUT_INVALID",
      );
      const { assessApprovals } = await import("@morivyx/kernel/approval-assessment");
      assert.equal(typeof assessApprovals, "function");
      assert.throws(() => assessApprovals([], null), { code: "APPROVAL_ASSESSMENT_INVALID" });`,
    ],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
    },
  );
  assertSucceeded(imported);

  const runCli = (arguments_) =>
    runNpm(
      [
        "exec",
        "--offline",
        "--yes=false",
        "--",
        "morivyx",
        ...arguments_,
      ],
      consumerDirectory,
    );
  const help = runCli(["--help"]);
  const version = runCli(["--version"]);
  const invalid = runCli(["unknown"]);
  assertSucceeded(help);
  assert.match(help.stdout, /^使用方法:\n/);
  assertSucceeded(version);
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^使用方法:\n/);

  console.log(
    `Package distribution audit passed: ${tarball.files.length} files; ${publicTargets.length} public targets; ${publicExports.length} installed exports.`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
