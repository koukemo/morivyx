import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPluginExecutionGrant, runPluginProcess } from "../packages/kernel/src/plugin-communication.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = async name => JSON.parse(await readFile(join(root, "packages/kernel/test/fixtures", name), "utf8"));
const base = { manifest: await fixture("plugin-manifest/repository-importer.json"),
  request: await fixture("plugin-communication/request.json"), policy: await fixture("plugin-manifest/host-policy.json") };
const message = "Pluginプロセスの起動又は実行に失敗しました。";
function refused(operation, code, path) {
  assert.throws(operation, error => {
    assert.equal(error.code, code); assert.equal(error.path, path);
    assert.equal(error.message.includes("NEVER_ECHO"), false);
    if (code === "PLUGIN_RUN_FAILED") assert.equal(error.message, message);
    return true;
  });
}

test("NUL characters and sparse arguments are rejected before a child can start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-launch-invalid-"));
  try {
    const marker = join(directory, "started"), code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`;
    const sparse = ["--eval", code]; sparse.length = 3;
    for (const options of [{ command: "NEVER_ECHO_COMMAND\0" },
      { command: process.execPath, args: ["--eval", code, "NEVER_ECHO_ARGUMENT\0"] },
      { command: process.execPath, args: ["--eval", code], cwd: "NEVER_ECHO_CWD\0" },
      { command: process.execPath, args: sparse }]) {
      refused(() => runPluginProcess({ ...base, ...options }), "PLUGIN_RUN_INVALID", "/command");
    }
    const invalid = { command: "NEVER_ECHO_COMMAND\0" };
    refused(() => runPluginProcess({ ...base, ...invalid, manifest: null }), "PLUGIN_MANIFEST_INVALID", "/");
    refused(() => runPluginProcess({ ...base, ...invalid, policy: null }), "PLUGIN_HOST_POLICY_INVALID", "/policy");
    const policy = structuredClone(base.policy); policy.capability.resources.maxMemoryBytes = 1024;
    refused(() => runPluginProcess({ ...base, ...invalid, policy }), "PLUGIN_RUN_RESOURCE_UNSUPPORTED", "/policy/capability/resources");
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real missing paths and nonexecutable files return a fixed launch diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-launch-missing-"));
  try {
    const missing = join(directory, "NEVER_ECHO_MISSING"), denied = join(directory, "NEVER_ECHO_PERMISSION");
    await writeFile(denied, "not executable\n"); await chmod(denied, 0o600);
    for (const options of [{ command: missing }, { command: denied },
      { command: process.execPath, args: ["--version"], cwd: missing }]) {
      refused(() => runPluginProcess({ ...base, ...options }), "PLUGIN_RUN_FAILED", "/");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("synchronous launch exceptions and returned errors cannot expose their contents", () => {
  const original = childProcess.spawnSync;
  try {
    for (const kind of ["throw", "return"]) {
      childProcess.spawnSync = () => {
        if (kind === "throw") throw new Error("NEVER_ECHO_SYNCHRONOUS_BODY");
        return { error: new Error("NEVER_ECHO_RETURNED_BODY") };
      };
      syncBuiltinESMExports();
      refused(() => runPluginProcess({ ...base, command: process.execPath, args: ["--version"] }), "PLUGIN_RUN_FAILED", "/");
    }
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("successful results, reduced grants and actual timeout and output limits remain intact", () => {
  const previous = process.env.MORIVYX_TEST_LAUNCH_AMBIENT;
  process.env.MORIVYX_TEST_LAUNCH_AMBIENT = "NEVER_ECHO_AMBIENT";
  try {
    const policy = structuredClone(base.policy); policy.capability.resources.maxOutputBytes = 4096;
    const code = `const r=${JSON.stringify(base.request)};process.stdout.write(JSON.stringify({format:'morivyx.plugin-run-result/0.1',runId:r.runId,plugin:r.plugin,capabilityId:r.capability.id,status:'success',output:{grant:JSON.parse(process.env.MORIVYX_PLUGIN_EXECUTION_GRANT),ambient:Object.hasOwn(process.env,'MORIVYX_TEST_LAUNCH_AMBIENT')}}))`;
    const result = runPluginProcess({ ...base, policy, command: process.execPath, args: ["--eval", code] });
    assert.equal(result.status, "success"); assert.equal(result.output.ambient, false);
    assert.deepEqual(result.output.grant, createPluginExecutionGrant(base.manifest, base.request, policy));
    policy.capability.resources.maxOutputBytes = 64;
    refused(() => runPluginProcess({ ...base, policy, command: process.execPath, args: ["--eval", "process.stdout.write('x'.repeat(4096))"] }), "PLUGIN_RUN_FAILED", "/");
    policy.capability.resources.maxOutputBytes = 4096; policy.capability.resources.timeoutMs = 50;
    const started = Date.now();
    refused(() => runPluginProcess({ ...base, policy, command: process.execPath, args: ["--eval", "while(true){}"] }), "PLUGIN_RUN_FAILED", "/");
    assert.ok(Date.now() - started < 5000);
  } finally {
    if (previous === undefined) delete process.env.MORIVYX_TEST_LAUNCH_AMBIENT;
    else process.env.MORIVYX_TEST_LAUNCH_AMBIENT = previous;
  }
});
