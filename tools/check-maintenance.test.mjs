import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MaintenanceError, runMaintenance } from "./check-maintenance.mjs";

const helper = fileURLToPath(new URL("./check-maintenance.mjs", import.meta.url));
async function fixture(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-maintenance-")));
  const files = ["packages/kernel/test/core.test.js", "tools/b.test.mjs", "tools/a.test.mjs", "packages/portable-core/test_core.py"];
  try {
    for (const directory of ["packages/kernel/test", "packages/portable-core", "tools"]) await mkdir(join(root, directory), { recursive: true });
    for (const file of files) await writeFile(join(root, file), "");
    await callback(root, files);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("all six stages use one explicit Python and pass literal arguments without a shell", () => fixture(async root => {
  const calls = [], output = [], python = join(root, "Python with spaces; literal", "python3");
  const env = { PATH: "/explicit/original", CONTROL: "retained" };
  const result = await runMaintenance({ root, python, env, write: value => output.push(value),
    execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0, signal: null }; } });
  assert.deepEqual(result, { valid: true, stages: 6, python });
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.options.cwd, root); assert.equal(call.options.shell, false);
    assert.equal(call.options.env.MORIVYX_REFERENCE_PYTHON, python);
    assert.equal(call.options.env.CONTROL, "retained"); assert.equal(call.options.stdio, "inherit");
  }
  for (const index of [0, 3, 4]) assert.equal(calls[index].command, python);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[1].args, ["test", "--prefix", "packages/kernel"]);
  assert.deepEqual(calls[2].args, ["--test", join(root, "tools/a.test.mjs"), join(root, "tools/b.test.mjs")]);
  assert.deepEqual(calls[3].args, ["-B", "-m", "unittest", "discover", "-s", "packages/portable-core", "-p", "test_*.py"]);
  assert.deepEqual(calls[4].args, ["-B", "tools/check-portable-vectors.py"]);
  assert.deepEqual(calls[5].args, ["tools/check-documentation.mjs"]);
  assert.equal(env.PATH, "/explicit/original"); assert.equal(Object.hasOwn(env, "MORIVYX_REFERENCE_PYTHON"), false);
  assert.match(output.join(""), /Maintenance checks passed: 6 stages/);
}));

test("failure in any stage stops every later stage and preserves its nonzero exit", async t => {
  for (let failed = 0; failed < 6; failed++) await t.test(`stage ${failed + 1}`, () => fixture(async root => {
    let calls = 0; const output = [];
    await assert.rejects(runMaintenance({ root, write: value => output.push(value), execute: () => ({ status: calls++ === failed ? 7 : 0 }) }),
      error => error instanceof MaintenanceError && error.exitCode === 7);
    assert.equal(calls, failed + 1); assert.doesNotMatch(output.join(""), /checks passed/);
  }));
});

test("signals, startup errors, thrown errors and missing statuses never count as success", async () => {
  for (const failure of [{ status: null, signal: "SIGTERM" }, { status: 0, error: new Error("startup") }, {}, null, "throw"]) {
    await fixture(async root => {
      let calls = 0;
      await assert.rejects(runMaintenance({ root, write: () => {}, execute: () => { calls++; if (failure === "throw") throw Error("startup"); return failure; } }), MaintenanceError);
      assert.equal(calls, 1);
    });
  }
});

test("each mandatory test group must contain real files before any command starts", async () => {
  for (const directory of ["packages/kernel/test", "tools", "packages/portable-core"]) await fixture(async root => {
    await rm(join(root, directory), { recursive: true }); await mkdir(join(root, directory));
    await mkdir(join(root, directory, directory === "tools" ? "fake.test.mjs" : directory.endsWith("test") ? "fake.test.js" : "test_fake.py"));
    let calls = 0;
    await assert.rejects(runMaintenance({ root, write: () => {}, execute: () => { calls++; return { status: 0 }; } }), /No test files found/);
    assert.equal(calls, 0);
  });
});

test("CLI rejects invalid arguments and missing Python before Core starts", () => fixture(async root => {
  for (const args of [["--unknown"], ["--python"], ["--python", ""], ["--python", "--unknown"]]) {
    const result = spawnSync(process.execPath, [helper, ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.status, 2); assert.equal(result.stdout, "");
  }
  const result = spawnSync(process.execPath, [helper, "--python", join(root, "missing-python")], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.match(result.stderr, /Python runtime/);
  assert.match(result.stdout, /\[1\/6\]/); assert.doesNotMatch(result.stdout, /\[2\/6\]|checks passed/);
}));

test("help runs from another directory and through an explicit symlink", { skip: process.platform === "win32" }, () => fixture(async root => {
  const alias = join(root, "maintenance alias.mjs"); await symlink(helper, alias);
  for (const path of [helper, alias]) {
    const result = spawnSync(process.execPath, [path, "--help"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.status, 0); assert.match(result.stdout, /^Usage: node tools\/check-maintenance\.mjs/);
    assert.equal(result.stderr, "");
  }
}));
