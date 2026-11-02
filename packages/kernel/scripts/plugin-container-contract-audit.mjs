import assert from "node:assert/strict";
import { readFile, access, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPluginContainer } from "../src/plugin-container.js";

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await json("../test/fixtures/plugin-manifest/repository-importer.json");
const policy = await json("../test/fixtures/plugin-manifest/host-policy.json");
const fixed = await json("../test/fixtures/plugin-manifest/isolated-run.json");
const request = { format: "morivyx.plugin-run-request/0.1", runId: fixed.result.runId,
  plugin: fixed.result.plugin, capability: { id: fixed.result.capabilityId, effect: "read-only" }, input: {} };
const clone = structuredClone;
function input() {
  return { manifest: clone(manifest), policy: clone(policy), request: clone(request), imageId: fixed.isolation.imageId,
    files: [{ path: "source.txt", permission: "repository-root", bytes: Buffer.from("source\n") }] };
}
function engine({ changeInfo = value => value, changeServer = value => value, start, create, remove } = {}) {
  const calls = []; let info; let staged;
  const transport = async (args, settings) => {
    calls.push({ args, settings });
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify(changeServer({ OSType: "linux", MemoryLimit: true,
      SwapLimit: true, PidsLimit: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin"] })) };
    if (args[0] === "image") return { code: 0, stdout: fixed.isolation.imageId };
    if (args[1] === "create") {
      const value = flag => args[args.indexOf(flag) + 1];
      const mount = value("--mount"); staged = mount.match(/source=([^,]+)/)[1];
      const bytes = await readFile(`${staged}/source.txt`).catch(() => null);
      if (bytes) assert.equal(bytes.toString(), "source\n");
      assert.ok(args.includes("--pull=never")); assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--network=none")); assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--log-driver=none"));
      info = { Id: fixed.isolation.containerId, Image: fixed.isolation.imageId,
        Config: { Labels: { "morivyx.run": value("--label").split("=")[1] }, User: "65534:65534", WorkingDir: "/input" },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
          SecurityOpt: ["no-new-privileges=true"], Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")),
          PidsLimit: 32, NanoCpus: 1000000000, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "none", CgroupnsMode: "private" },
        Mounts: [{ Type: "bind", Source: staged, Destination: "/input", RW: false }] };
      return create ? create(info) : { code: 0, stdout: fixed.isolation.containerId };
    }
    if (args[1] === "inspect") return { code: 0, stdout: JSON.stringify([changeInfo(clone(info))]) };
    if (args[1] === "start") return start ? start(args, settings) : { code: 0, stdout: JSON.stringify(fixed.result) };
    if (args[1] === "rm") return remove ? remove(args) : { code: 0, stdout: fixed.isolation.containerId };
    if (args[1] === "ls") return { code: 0, stdout: info ? fixed.isolation.containerId : "" };
    throw new Error("unexpected Docker operation");
  };
  return { calls, transport, staged: () => staged };
}
const rejected = (operation, code) => assert.rejects(operation, error => error.code === code);
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await check("fixed receipt and contract follow confirmed configuration and cleanup", async () => {
  const e = engine(); const output = await runPluginContainer(input(), { transport: e.transport });
  assert.deepEqual(output, fixed);
  const schema = await json("../../../contracts/plugin-isolated-run@0.1.schema.json");
  const communication = await json("../../../contracts/plugin-communication@0.1.schema.json");
  assert.deepEqual(Object.keys(output), schema.required);
  assert.deepEqual(Object.keys(output.isolation), schema.properties.isolation.required);
  assert.equal(schema.properties.result.$ref, `${communication.$id}#/$defs/RunResult`);
  assert.equal(e.calls.at(-1).args[1], "rm");
  assert.ok(e.calls.at(-1).args.includes("--volumes"));
  await assert.rejects(access(e.staged()), { code: "ENOENT" });
});

await check("policy and image validation happen before any Docker call", async () => {
  for (const mutate of [v => { delete v.policy; }, v => { v.imageId = "node:latest"; },
    v => { v.extraArgs = ["--privileged"]; }, v => { v.policy.capability.permissions.fileRead = []; }]) {
    const value = input(); mutate(value); const e = engine();
    await assert.rejects(runPluginContainer(value, { transport: e.transport })); assert.equal(e.calls.length, 0);
  }
});

await check("unsupported permissions and resources fail before launch", async () => {
  for (const key of ["graphRead", "network", "secrets", "devices"]) {
    const value = input(); value.manifest.capabilities[0].permissions[key] = ["resource"];
    value.policy.capability.permissions[key] = ["resource"];
    await rejected(runPluginContainer(value), "PLUGIN_ISOLATION_PERMISSION_UNSUPPORTED");
  }
  const cost = input(); cost.policy.capability.resources.maxCostUnits = 1;
  await rejected(runPluginContainer(cost), "PLUGIN_ISOLATION_RESOURCE_UNSUPPORTED");
  const small = input(); small.policy.capability.resources.maxMemoryBytes = 1;
  await rejected(runPluginContainer(small), "PLUGIN_ISOLATION_RESOURCE_UNSUPPORTED");
});

await check("path escape duplicates and parent-file conflicts are rejected", async () => {
  for (const path of ["", "/a", "../a", "a/../b", "a//b", "a/./b", "a\\b", "a\0b", "a\nb", "\ud800"]) {
    const value = input(); value.files[0].path = path;
    await rejected(runPluginContainer(value), "PLUGIN_ISOLATION_PATH_INVALID");
  }
  for (const paths of [["a", "a"], ["a", "a/b"], ["a/b", "a"]]) {
    const value = input(); value.files = paths.map(path => ({ ...value.files[0], path }));
    await rejected(runPluginContainer(value), "PLUGIN_ISOLATION_PATH_INVALID");
  }
});

await check("file permission and byte shapes are validated", async () => {
  const forbidden = input(); forbidden.files[0].permission = "undeclared";
  await rejected(runPluginContainer(forbidden), "PLUGIN_ISOLATION_PERMISSION_DENIED");
  const detached = new Uint8Array(1); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const bytes of ["source", [], new Uint8Array(new SharedArrayBuffer(1)), detached]) {
    const value = input(); value.files[0].bytes = bytes;
    await rejected(runPluginContainer(value), "PLUGIN_ISOLATION_INPUT_INVALID");
  }
  const large = input(); large.files[0].bytes = Buffer.alloc(1048577);
  await rejected(runPluginContainer(large), "PLUGIN_ISOLATION_INPUT_LIMIT");
  const total = input(); total.files = Array.from({ length: 9 }, (_, i) =>
    ({ ...total.files[0], path: `${i}`, bytes: Buffer.alloc(1048576) }));
  await rejected(runPluginContainer(total), "PLUGIN_ISOLATION_INPUT_LIMIT");
});

await check("accessors sparse lists and unknown options are rejected", async () => {
  for (const locate of [v => [v, "files"], v => [v.files, "0"], v => [v.files[0], "bytes"]]) {
    const value = input(); const [object, key] = locate(value); let invoked = false;
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return "secret"; } });
    await assert.rejects(runPluginContainer(value)); assert.equal(invoked, false);
  }
  const sparse = input(); sparse.files = Array(1); await rejected(runPluginContainer(sparse), "PLUGIN_ISOLATION_INPUT_INVALID");
  for (const options of [{ args: ["--privileged"] }, { dockerPath: "docker" }, { transport: 1 }]) {
    await rejected(runPluginContainer(input(), options), "PLUGIN_ISOLATION_OPTIONS_INVALID");
  }
});

await check("server constraints and missing image do not fall back", async () => {
  for (const field of ["OSType", "MemoryLimit", "SwapLimit", "PidsLimit", "CpuCfsQuota", "SecurityOptions"]) {
    const e = engine({ changeServer: value => ({ ...value, [field]: field === "SecurityOptions" ? [] : false }) });
    await rejected(runPluginContainer(input(), { transport: e.transport }), "PLUGIN_ISOLATION_UNAVAILABLE");
    assert.equal(e.calls.some(c => c.args[1] === "create"), false);
  }
  const e = engine(); const transport = (args, settings) => args[0] === "image" ? { code: 1, stdout: "" } : e.transport(args, settings);
  await rejected(runPluginContainer(input(), { transport }), "PLUGIN_ISOLATION_IMAGE_UNAVAILABLE");
});

await check("actual configuration mismatches never start and are cleaned up", async () => {
  for (const changeInfo of [v => ({ ...v, Image: "different" }), v => ({ ...v, Mounts: [] }),
    v => { v.Mounts[0].RW = true; return v; }, v => { v.Config.User = "0"; return v; },
    v => { v.HostConfig.NetworkMode = "host"; return v; }, v => { v.HostConfig.ReadonlyRootfs = false; return v; },
    v => { v.HostConfig.Privileged = true; return v; }, v => { v.HostConfig.SecurityOpt = ["seccomp=unconfined"]; return v; },
    v => { v.HostConfig.PidsLimit = 0; return v; }]) {
    const e = engine({ changeInfo });
    await rejected(runPluginContainer(input(), { transport: e.transport }), "PLUGIN_ISOLATION_CONFIGURATION_MISMATCH");
    assert.equal(e.calls.some(c => c.args[1] === "start"), false);
    assert.equal(e.calls.at(-1).args[1], "rm");
  }
});

await check("create response loss recovers only the labeled container", async () => {
  const e = engine({ create: () => ({ code: 1, stdout: "" }) });
  await rejected(runPluginContainer(input(), { transport: e.transport }), "PLUGIN_ISOLATION_CREATE_FAILED");
  assert.ok(e.calls.some(c => c.args[1] === "ls"));
  assert.equal(e.calls.at(-1).args[1], "rm");
});

await check("run failures and invalid results still remove the container", async () => {
  for (const start of [() => ({ code: 7, stdout: "" }), () => ({ code: 0, stdout: "not json" }),
    () => ({ code: 0, stdout: `${JSON.stringify(fixed.result)}\n{}` }),
    () => ({ code: 0, stdout: JSON.stringify({ ...fixed.result, runId: "other" }) }),
    () => { const error = new Error("simulated timeout"); error.code = "PLUGIN_ISOLATION_TIMEOUT"; throw error; }]) {
    const e = engine({ start });
    await assert.rejects(runPluginContainer(input(), { transport: e.transport }), error => error.isolation.containerRemoved === true);
    assert.equal(e.calls.at(-1).args[1], "rm"); await assert.rejects(access(e.staged()), { code: "ENOENT" });
  }
});

await check("cleanup failure cannot be returned as successful isolation", async () => {
  const e = engine({ remove: () => ({ code: 1, stdout: "" }) });
  let root;
  await assert.rejects(runPluginContainer(input(), { transport: e.transport }), error => {
    root = error.details.stagingPath;
    return error.code === "PLUGIN_ISOLATION_CLEANUP_FAILED" && error.details.containerId === fixed.isolation.containerId;
  });
  await access(e.staged()); await rm(root, { recursive: true, force: true });
});

await check("all caller data is snapshotted before asynchronous work", async () => {
  const value = input(); const e = engine(); const pending = runPluginContainer(value, { transport: e.transport });
  value.files[0].bytes.fill(0); value.files[0].path = "changed"; value.request.runId = "changed";
  value.policy.capability.resources.maxOutputBytes = 1;
  assert.deepEqual(await pending, fixed);
});

await check("foreign ownership and unresolved creation never permit removal", async () => {
  for (const unknownCreation of [false, true]) {
    const e = engine({
      changeInfo: value => { if (!unknownCreation) value.Config.Labels["morivyx.run"] = "foreign"; return value; },
      create: unknownCreation ? () => ({ code: 1, stdout: "" }) : undefined,
    });
    const transport = (args, settings) => unknownCreation && args[1] === "ls" ? { code: 0, stdout: "" } : e.transport(args, settings);
    let root;
    await assert.rejects(runPluginContainer(input(), { transport }), error => {
      root = error.details.stagingPath; return error.code === "PLUGIN_ISOLATION_CLEANUP_FAILED";
    });
    assert.equal(e.calls.some(call => call.args[1] === "rm"), false);
    await rm(root, { recursive: true, force: true });
  }
});

await check("a missing real Docker executable fails without fallback", async () => {
  await rejected(runPluginContainer(input(), { dockerPath: "/morivyx-missing-fixture/docker" }), "PLUGIN_ISOLATION_UNAVAILABLE");
});

await check("cancellation before launch has no transport side effects", async () => {
  const controller = new AbortController(); controller.abort(); const e = engine();
  await rejected(runPluginContainer(input(), { signal: controller.signal, transport: e.transport }), "PLUGIN_ISOLATION_CANCELLED");
  assert.equal(e.calls.length, 0);
  await rejected(runPluginContainer(input(), { signal: {} }), "PLUGIN_ISOLATION_OPTIONS_INVALID");
});

await check("aborted signals are not used for cleanup", async () => {
  const controller = new AbortController();
  const e = engine({ start: () => {
    controller.abort(); const error = new Error("cancelled"); error.code = "PLUGIN_ISOLATION_CANCELLED"; throw error;
  } });
  await rejected(runPluginContainer(input(), { signal: controller.signal, transport: e.transport }), "PLUGIN_ISOLATION_CANCELLED");
  for (const call of e.calls.slice(-2)) assert.equal(call.settings.signal, undefined);
  assert.equal(e.calls.at(-1).args[1], "rm");
});

if (process.platform !== "win32") await check("real CLI pipes enforce time and output limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-cli-probe-"));
  try {
    for (const [name, code, expected] of [
      ["timeout", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);", "PLUGIN_ISOLATION_TIMEOUT"],
      ["output", "process.stdout.write('x'.repeat(300000));", "PLUGIN_ISOLATION_OUTPUT_LIMIT"],
      ["invalid", "process.stdout.write('not-json');", "PLUGIN_ISOLATION_UNAVAILABLE"],
    ]) {
      const path = join(root, name);
      await writeFile(path, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
      const value = input(); value.policy.capability.resources.timeoutMs = name === "timeout" ? 100 : 2000;
      await rejected(runPluginContainer(value, { dockerPath: path }), expected);
    }
    const path = join(root, "timeout"); const controller = new AbortController();
    const pending = runPluginContainer(input(), { dockerPath: path, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await rejected(pending, "PLUGIN_ISOLATION_CANCELLED"); } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

if (process.platform !== "win32") await check("native CLI rejects malformed UTF-8 and still removes owned containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-cli-utf8-"));
  try {
    const statePath = join(root, "state.json");
    const path = join(root, "docker");
    const expected = clone(fixed.result);
    expected.output = { note: "private-fixture-日本語と置換文字\uFFFD" };
    const valid = Buffer.from(JSON.stringify(expected));
    const offset = valid.indexOf(Buffer.from("\uFFFD"));
    const cases = [null, [255], [128], [192, 175], [227, 129], [237, 160, 128], [244, 144, 128, 128]];
    for (const invalid of cases) {
      const bytes = invalid === null ? valid : Buffer.concat([
        valid.subarray(0, offset), Buffer.from(invalid), valid.subarray(offset + 3),
      ]);
      const code = `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const id = ${JSON.stringify(fixed.isolation.containerId)};
const image = ${JSON.stringify(fixed.isolation.imageId)};
const args = process.argv.slice(6);
const value = flag => args[args.indexOf(flag) + 1];
const save = state => writeFileSync(statePath, JSON.stringify(state));
if (args[0] === "info") {
  process.stdout.write(JSON.stringify({ OSType: "linux", MemoryLimit: true, SwapLimit: true,
    PidsLimit: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin"] }));
} else if (args[0] === "image") { process.stdout.write(image);
} else if (args[1] === "create") {
  const source = value("--mount").match(/source=([^,]+)/)[1];
  const info = { Id: id, Image: image,
    Config: { Labels: { "morivyx.run": value("--label").split("=")[1] }, User: "65534:65534", WorkingDir: "/input" },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
      SecurityOpt: ["no-new-privileges=true"], Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")),
      PidsLimit: 32, NanoCpus: 1000000000, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "none", CgroupnsMode: "private" },
    Mounts: [{ Type: "bind", Source: source, Destination: "/input", RW: false }] };
  save({ info, source, removed: false }); process.stdout.write(id);
} else if (args[1] === "inspect") {
  process.stdout.write(JSON.stringify([JSON.parse(readFileSync(statePath, "utf8")).info]));
} else if (args[1] === "start") {
  process.stderr.write(Buffer.from([255]));
  process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"));
} else if (args[1] === "rm") {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.removed = true; save(state); process.stdout.write(id);
} else { process.exitCode = 1; }
`;
      await writeFile(path, code, { mode: 0o755 });
      if (invalid === null) {
        const output = await runPluginContainer(input(), { dockerPath: path });
        assert.deepEqual(output.result, expected);
        assert.equal(output.isolation.containerRemoved, true);
      } else {
        await assert.rejects(runPluginContainer(input(), { dockerPath: path }), error => {
          assert.equal(error.code, "PLUGIN_ISOLATION_RESULT_INVALID");
          assert.equal(error.isolation.containerRemoved, true);
          assert.equal(error.message.includes("private-fixture"), false);
          return true;
        });
      }
      const state = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(state.removed, true);
      await assert.rejects(access(state.source), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

console.log(`Plugin container contract audit passed: ${checks} checks (transport adapter; not OS isolation evidence).`);
