import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import test from "node:test";

export const sha = value => createHash("sha256").update(value).digest("hex");
let original;
async function api() {
  return original ??= import(new URL("../packages/kernel/src/plugin-container.js", import.meta.url));
}
export function edit(value, changes = []) {
  value = structuredClone(value);
  for (const { path, value: next, remove } of changes) {
    let parent = value;
    for (const key of path.slice(0, -1)) parent = parent[key];
    if (remove) delete parent[path.at(-1)]; else parent[path.at(-1)] = structuredClone(next);
  }
  return value;
}
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteGetter = Object.fromEntries(["buffer", "byteOffset", "byteLength"].map(key =>
  [key, Object.getOwnPropertyDescriptor(typedPrototype, key).get]));
function snapshot(value, seen = new Set()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") return { type: typeof value };
  if (types.isProxy(value)) return { type: "proxy" };
  if (types.isUint8Array(value)) {
    try {
      const buffer = Reflect.apply(byteGetter.buffer, value, []);
      const offset = Reflect.apply(byteGetter.byteOffset, value, []), length = Reflect.apply(byteGetter.byteLength, value, []);
      return { type: "bytes", shared: types.isSharedArrayBuffer(buffer), offset, length,
        sha256: sha(Buffer.from(new Uint8Array(buffer, offset, length))) };
    } catch { return { type: "detached-bytes" }; }
  }
  if (seen.has(value)) return { type: "cycle" };
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value), result = {};
  for (const key of Object.keys(descriptors)) {
    const entry = descriptors[key];
    result[key] = Object.hasOwn(entry, "value") ? snapshot(entry.value, seen) : { type: "accessor" };
  }
  seen.delete(value);
  return result;
}
async function tree(root) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), key = prefix + name, info = await lstat(child);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) { files[key] = { type: "directory", mode: info.mode & 0o777 }; await walk(child, key + "/"); }
      else files[key] = { type: "file", mode: info.mode & 0o777, bytes: info.size, sha256: sha(await readFile(child)) };
    }
  }
  await walk(root); return files;
}
function normalized(value, root, nonce, stagingName) {
  if (typeof value === "string") {
    let result = value.replaceAll(root, "ROOT");
    if (stagingName) result = result.replaceAll(stagingName, "STAGING");
    if (nonce) result = result.replaceAll(nonce, "NONCE");
    return result;
  }
  if (Array.isArray(value)) return value.map(item => normalized(item, root, nonce, stagingName));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [normalized(key, root, nonce, stagingName), normalized(item, root, nonce, stagingName)]));
  return value;
}
export async function nodeContainerCase(entry, fixture) {
  const source = await api(), spec = JSON.parse(entry.inputText);
  const outer = await realpath(await mkdtemp(join(tmpdir(), "morivyx-container-case-")));
  const productRoot = join(outer, "product"); await mkdir(productRoot);
  const previousTmp = process.env.TMPDIR, mask = process.umask(spec.umask ?? 0o022);
  process.env.TMPDIR = productRoot;
  const calls = [], rawTimings = [], controller = new AbortController();
  let info, staged, nonce, removed = false, foreignCalls = 0;
  const result = edit(fixture.receipt.result, spec.resultEdits);
  let value = Object.hasOwn(spec, "input") ? structuredClone(spec.input) : structuredClone(fixture.input);
  if (!Object.hasOwn(spec, "input")) value.files = value.files.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) }));
  value = edit(value, spec.inputEdits);
  let options = Object.hasOwn(spec, "options") ? structuredClone(spec.options) : {};
  const state = { controller, inspectCount: 0, grantTimeout: Math.min(value?.policy?.capability?.resources?.timeoutMs ?? 5000, 30000) };
  const transport = async (args, settings) => {
    if (args[1] === "ls") state.finished = true;
    if (args[0] === "container" && args[1] === "inspect" && state.inspectCount++ > 0) state.finished = true;
    const cleanup = state.finished === true || (args[0] === "container" && args[1] === "rm");
    const grantTimeout = state.grantTimeout;
    const maximum = cleanup ? 5000 : args[1] === "start" ? grantTimeout : Math.min(5000, grantTimeout);
    rawTimings.push({ operation: args.slice(0, 2), timeoutMs: settings.timeoutMs, maximum });
    assert.ok(settings.timeoutMs > 0 && settings.timeoutMs <= maximum, "timeout outside declared boundary");
    calls.push({ args: structuredClone(args), settings: { timeout: cleanup ? settings.timeoutMs : "positive-within-bound",
      maxOutputBytes: settings.maxOutputBytes, signalPresent: settings.signal !== undefined,
      signalAborted: settings.signal?.aborted ?? null,
      ...(Object.hasOwn(settings, "input") ? { inputBytes: Buffer.byteLength(settings.input), inputSha256: sha(settings.input) } : {}) } });
    if (spec.abortPhase === args[0] || spec.abortPhase === args[1]) controller.abort();
    if (args[0] === "info") return Object.hasOwn(spec, "serverResponse") ? structuredClone(spec.serverResponse) : {
      code: 0, stdout: JSON.stringify(edit(fixture.server, spec.serverEdits)) };
    if (args[0] === "image") return Object.hasOwn(spec, "imageResponse") ? structuredClone(spec.imageResponse) : {
      code: 0, stdout: value.imageId };
    if (args[1] === "create") {
      const flag = key => args[args.indexOf(key) + 1];
      staged = flag("--mount").match(/source=([^,]+)/u)[1]; nonce = flag("--label").split("=")[1];
      info = { Id: fixture.receipt.isolation.containerId, Image: value.imageId,
        Config: { Labels: { "morivyx.run": nonce }, User: "65534:65534", WorkingDir: "/input" },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
          SecurityOpt: ["no-new-privileges=true"], Memory: Number(flag("--memory")), MemorySwap: Number(flag("--memory-swap")),
          PidsLimit: 32, NanoCpus: 1000000000, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "none", CgroupnsMode: "private" },
        Mounts: [{ Type: "bind", Source: staged, Destination: "/input", RW: false }] };
      state.stagedFiles = await tree(staged);
      if (controller.signal.aborted) state.finished = true;
      if (spec.throwPhase === "create") { state.finished = true; const error = new Error("owned transport failure"); error.code = spec.throwCode ?? "OWNED_FAILURE"; throw error; }
      return Object.hasOwn(spec, "createResponse") ? structuredClone(spec.createResponse) : { code: 0, stdout: info.Id };
    }
    if (args[1] === "inspect") {
      if (Object.hasOwn(spec, "inspectResponse")) return structuredClone(spec.inspectResponse);
      return { code: 0, stdout: JSON.stringify([edit(info, spec.infoEdits)]) };
    }
    if (args[1] === "ls") return Object.hasOwn(spec, "listResponse") ? structuredClone(spec.listResponse) : {
      code: 0, stdout: info ? fixture.receipt.isolation.containerId : "" };
    if (args[1] === "start") {
      state.finished = true;
      if (spec.throwPhase === "start") { state.finished = true; const error = new Error("owned transport failure"); error.code = spec.throwCode ?? "OWNED_FAILURE"; throw error; }
      if (controller.signal.aborted) state.finished = true;
      return Object.hasOwn(spec, "startResponse") ? structuredClone(spec.startResponse) : { code: 0, stdout: JSON.stringify(result) };
    }
    if (args[1] === "rm") {
      const output = Object.hasOwn(spec, "removeResponse") ? structuredClone(spec.removeResponse) : { code: 0, stdout: info.Id };
      removed = output?.code === 0; return output;
    }
    throw new Error("unexpected owned transport operation");
  };
  let cancelTimer;
  try {
    if (spec.requestPadding !== undefined) value.request.input.padding = "x".repeat(spec.requestPadding);
    if (spec.fileBytesLength !== undefined) value.files[0].bytes = new Uint8Array(spec.fileBytesLength).fill(120);
    if (spec.fileCount !== undefined) value.files = Array.from({ length: spec.fileCount }, (_, i) => ({ ...value.files[0], path: `${i}.txt` }));
    if (spec.filePaths) value.files = spec.filePaths.map(path => ({ ...value.files[0], path }));
    if (spec.byteShape === "view") { const bytes = new Uint8Array([0, 115, 111, 117, 114, 99, 101, 10, 0]); value.files[0].bytes = bytes.subarray(1, 8); }
    if (spec.byteShape === "shared") value.files[0].bytes = new Uint8Array(new SharedArrayBuffer(1));
    if (spec.byteShape === "buffer") value.files[0].bytes = Buffer.from("source\n");
    if (spec.byteShape === "dataview") value.files[0].bytes = new DataView(new ArrayBuffer(1));
    if (spec.byteShape === "clamped") value.files[0].bytes = new Uint8ClampedArray(1);
    if (spec.byteShape === "detached") { const bytes = new Uint8Array(1); structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); value.files[0].bytes = bytes; }
    if (spec.byteShape === "shadow-getters") for (const key of ["buffer", "byteLength", "byteOffset"]) Object.defineProperty(value.files[0].bytes, key, { get() { foreignCalls++; throw new Error("foreign accessor"); } });
    if (spec.foreign === "input-proxy") value = new Proxy(value, { get() { foreignCalls++; throw new Error("foreign proxy"); } });
    if (spec.foreign === "input-accessor") Object.defineProperty(value, "files", { enumerable: true, get() { foreignCalls++; throw new Error("foreign accessor"); } });
    if (spec.foreign === "file-accessor") Object.defineProperty(value.files[0], "bytes", { enumerable: true, get() { foreignCalls++; throw new Error("foreign accessor"); } });
    if (spec.foreign === "file-list-accessor") Object.defineProperty(value.files, "0", { enumerable: true, get() { foreignCalls++; throw new Error("foreign accessor"); } });
    if (spec.foreign === "sparse-files") value.files = Array(1);
    if (spec.foreign === "null-prototype") value = Object.assign(Object.create(null), value);
    if (options !== null && typeof options === "object" && !Array.isArray(options)) {
      if (spec.nativeScenario) {
        assert.ok(["invalid", "output", "timeout", "utf8", "cancel"].includes(spec.nativeScenario));
        const helper = join(outer, "owned-engine");
        const script = spec.nativeScenario === "invalid" ? "printf 'not-json'" :
          spec.nativeScenario === "utf8" ? "printf '\\377'" : spec.nativeScenario === "output" ?
            "i=0; while [ \"$i\" -lt 3000 ]; do printf '%0100d' 0; i=$((i+1)); done" : "while :; do :; done";
        await writeFile(helper, "#!/bin/sh\n" + script + "\n", { mode: 0o755 });
        options.dockerPath = helper;
        if (spec.nativeScenario === "cancel") {
          options.signal = controller.signal; cancelTimer = setTimeout(() => controller.abort(), 100);
        }
      } else if (!Object.hasOwn(options, "transport")) options.transport = transport;
      if (spec.abortPhase) options.signal = controller.signal;
      if (spec.abortPhase === "before") controller.abort();
    }
    if (spec.foreign === "options-accessor") Object.defineProperty(options, "transport", { enumerable: true, get() { foreignCalls++; throw new Error("foreign accessor"); } });
    const beforeInput = snapshot(value), before = await tree(productRoot);
    let outcome;
    try {
      const pending = source.runPluginContainer(value, options);
      if (spec.mutateAfterCall) {
        value.request.runId = "changed"; value.files[0].bytes.fill(0); value.files[0].path = "changed";
        value.policy.capability.resources.maxOutputBytes = 1;
      }
      if (spec.mutateOptionsAfterCall) { options.transport = () => { throw new Error("replaced adapter"); }; options.dockerPath = "relative"; options.signal = {}; }
      outcome = { kind: "return", value: await pending };
    } catch (error) {
      state.finished = true;
      outcome = { kind: "throw", name: error.name };
      for (const key of ["code", "path", "details", "isolation"]) if (Object.hasOwn(error, key)) outcome[key] = error[key];
    }
    const after = await tree(productRoot);
    for (const timing of rawTimings) assert.ok(timing.timeoutMs > 0 && timing.timeoutMs <= timing.maximum,
      `${entry.id}: adapter timeout ${timing.timeoutMs} exceeds ${timing.maximum} for ${timing.operation.join(" ")}`);
    let stagingName = staged ? basename(dirname(staged)) : null;
    if (!stagingName && typeof outcome.path === "string" && outcome.path.startsWith(productRoot + "/"))
      stagingName = outcome.path.slice(productRoot.length + 1).split("/")[0];
    if (stagingName) assert.match(stagingName, /^morivyx-isolated-[A-Za-z0-9]{6}$/u);
    return { output: normalized({ ...outcome, inputUnchanged: JSON.stringify(snapshot(value)) === JSON.stringify(beforeInput),
      foreignCalls, calls, stagedFiles: state.stagedFiles ?? null, removed, before, after }, outer, nonce, stagingName), rawTimings };
  } finally {
    clearTimeout(cancelTimer);
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    process.umask(mask); await rm(outer, { recursive: true, force: true });
  }
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main && process.argv.includes("--node-replay")) {
  const fixture = JSON.parse(await readFile(new URL("../packages/portable-core/fixtures/plugin-container-vectors.json", import.meta.url), "utf8"));
  for (const [path, digest] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), digest, path);
  for (const entry of fixture.cases) assert.deepEqual((await nodeContainerCase(entry, fixture)).output, entry.expected, entry.id);
  process.stdout.write(JSON.stringify({ valid: true, count: fixture.cases.length }) + "\n");
} else if (main) {
  const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
  test("frozen container inputs and original outcomes retain their digests", async () => {
    const bytes = await readFile(new URL("../packages/portable-core/fixtures/plugin-container-vectors.json", import.meta.url));
    assert.equal(sha(bytes), "951401aacb717e69f1d33209f649e42c4b61076163e0c8ea871cb9f8d006de3e");
    const fixture = JSON.parse(bytes);
    assert.equal(fixture.count, 652);
    assert.equal(fixture.cases.length, fixture.count);
    for (const entry of fixture.cases) {
      assert.equal(sha(entry.inputText), entry.inputSha256, entry.id);
      assert.equal(sha(JSON.stringify(entry.expected)), entry.outputSha256, entry.id);
    }
  });
  const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  function runPython(args, { cwd = core, env = process.env, executable = python, input } = {}) {
    const child = spawnSync(executable, ["-B", ...args], { cwd, env, input, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
  }
  async function verifyReplay(text) {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/plugin-container-vectors.json"), "utf8"));
    const rows = JSON.parse(text); assert.equal(rows.length, 652);
    for (let index = 0; index < rows.length; index++) {
      assert.equal(rows[index].id, fixture.cases[index].id);
      assert.deepEqual(rows[index].outcome, fixture.cases[index].expected, rows[index].id);
    }
  }
  test("Python reproduces every frozen container outcome and filesystem state", async () => {
    assert.match(runPython(["-m", "unittest", "test_plugin_container"]).stderr, /Ran 3 tests/);
    await verifyReplay(runPython(["test_plugin_container.py", "--replay"]).stdout);
  });
  test("46 public production modules reproduce every case without Node or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "morivyx-container-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
      assert.equal(modules.length, 46);
      for (const name of [...modules, "test_plugin_container.py"]) await cp(join(core, name), join(root, name));
      await mkdir(join(root, "fixtures"));
      await cp(join(core, "fixtures/plugin-container-vectors.json"), join(root, "fixtures/plugin-container-vectors.json"));
      const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      await verifyReplay(runPython(["test_plugin_container.py", "--replay", "--isolated"], {
        executable, cwd: root, env: { PATH: "", PYTHONIOENCODING: "utf-8" },
      }).stdout);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  let hasNodeSource = false;
  try { await access(new URL("../packages/kernel/src/plugin-container.js", import.meta.url)); hasNodeSource = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasNodeSource) test("Node reproduces the preimplementation frozen reference", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--node-replay"], {
      encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { valid: true, count: 652 });
  });
  if (hasNodeSource) test("additional configuration shapes retain exact acceptance and cleanup behavior", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/plugin-container-vectors.json"), "utf8"));
    const entries = configurationProbes();
    const expected = [];
    for (const entry of entries) expected.push({ id: entry.id, outcome: (await nodeContainerCase(entry, fixture)).output });
    const actual = JSON.parse(runPython(["test_plugin_container.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.equal(entries.length, 20);
    for (let index = 0; index < entries.length; index++) assert.deepEqual(actual[index], expected[index], entries[index].id);
  });
}

export function configurationProbes() {
    const shapes = [["drop-lowercase", ["HostConfig", "CapDrop"], ["all"]],
      ["add-empty-string", ["HostConfig", "CapAdd"], ""], ["add-zero-length-record", ["HostConfig", "CapAdd"], { length: 0 }],
      ["add-array", ["HostConfig", "CapAdd"], []], ["security-short", ["HostConfig", "SecurityOpt"], ["no-new-privileges"]],
      ["memory-bool", ["HostConfig", "Memory"], true], ["swap-bool", ["HostConfig", "MemorySwap"], true],
      ["pids-bool", ["HostConfig", "PidsLimit"], true], ["cpu-bool", ["HostConfig", "NanoCpus"], true],
      ["readonly-number", ["HostConfig", "ReadonlyRootfs"], 1], ["privileged-number", ["HostConfig", "Privileged"], 0],
      ["mount-readonly-number", ["Mounts", 0, "RW"], 0], ["mount-extra", ["Mounts", 0, "Extra"], true],
      ["host-extra", ["HostConfig", "Extra"], true], ["label-extra", ["Config", "Labels", "other"], "owned"],
      ["mount-null", ["Mounts", 0], null], ["add-number", ["HostConfig", "CapAdd"], 0],
      ["add-false-length-record", ["HostConfig", "CapAdd"], { length: false }]];
    return [...shapes.map(([name, path, value]) => ({ id: `additional/${name}`, inputText: JSON.stringify({ infoEdits: [{ path, value }] }) })),
      ...[0, 0o077].map(umask => ({ id: `additional/nested-umask-${umask}`, inputText: JSON.stringify({ umask, filePaths: ["a/b/c/source.txt"] }) }))];
}
