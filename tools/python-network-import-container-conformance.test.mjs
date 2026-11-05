import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { edit } from "./python-plugin-container-conformance.test.mjs";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const NETWORK_CONTAINER_PIN = "152d6a27d5df5c0618e9f1630d522a2f0c8b4b36a32b8defcd3014762976b843";
const copy = structuredClone;
const bytesSummary = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const NativeDate = Date;
function normalize(value, root, nonce, staging) {
  if (typeof value === "string") {
    let out = value.replaceAll(root, "ROOT");
    if (nonce) out = out.replaceAll(nonce, "NONCE");
    if (staging) out = out.replaceAll(staging, "STAGING");
    return out;
  }
  if (Array.isArray(value)) return value.map(x => normalize(x, root, nonce, staging));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [normalize(k, root, nonce, staging), normalize(v, root, nonce, staging)]));
  return value;
}
async function tree(root) {
  const result = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const p = join(path, name), key = prefix + name, st = await lstat(p);
      if (st.isSymbolicLink()) result[key] = { type: "symlink" };
      else if (st.isDirectory()) { result[key] = { type: "directory", mode: st.mode & 0o777 }; await walk(p, key + "/"); }
      else result[key] = { type: "file", mode: st.mode & 0o777, ...bytesSummary(await readFile(p)) };
    }
  }
  await walk(root); return result;
}
function diagnostic(error) {
  const out = { kind: "throw", name: error.name };
  for (const key of ["code", "path", "details", "isolation"]) if (Object.hasOwn(error, key)) out[key] = error[key];
  return out;
}
function summarizePacked(value) {
  return { inputDigest: value.inputDigest, files: value.files.map(f => ({ path: f.path, permission: f.permission,
    ...bytesSummary(f.bytes), ...(f.path === "network-input.json" ? { text: f.bytes.toString() } : {}) })) };
}
function foreign(value, spec, state) {
  const trap = () => { state.foreignCalls++; throw new Error("untrusted getter"); };
  if (spec.foreign === "proxy") return new Proxy(value, { get: trap });
  if (spec.foreign === "prototype") return Object.assign(Object.create({}), value);
  if (spec.foreign === "accessor") Object.defineProperty(value, spec.foreignKey ?? "request", { get: trap, enumerable: true });
  if (spec.foreign === "symbol") value[Symbol("extra")] = true;
  if (spec.foreign === "non-enumerable") Object.defineProperty(value, "hidden", { value: true });
  if (spec.foreign === "null-prototype") return Object.assign(Object.create(null), value);
  return value;
}

// Only actual root paths, engine nonces and staging names are replaced. Clock values are deliberately controlled.
export async function nodeNetworkCase(entry, fixture) {
  const spec = JSON.parse(entry.inputText), provider = spec.provider ?? "figma";
  const { runNetworkImportContainer } = await import("../packages/kernel/src/network-import-container.js");
  const convert = await import("../packages/kernel/src/network-import-conversion.js");
  const original = fixture.providers[provider];
  const outer = await realpath(await mkdtemp(join(tmpdir(), "morivyx-network-case-")));
  const productRoot = join(outer, "product"); await mkdir(productRoot);
  const previousTmp = process.env.TMPDIR, mask = process.umask(0o022), elapsedStart = performance.now();
  process.env.TMPDIR = productRoot;
  let clock = NativeDate.parse(fixture.time), staged, nonce, info, removed = false;
  class Clock extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  globalThis.Date = Clock;
  const controller = new AbortController(), calls = [], fetches = [], state = { foreignCalls: 0, cancels: 0, releases: 0 };
  let input = Object.hasOwn(spec, "input") ? copy(spec.input) : edit(original.input, spec.inputEdits);
  if (input?.execution?.artifacts?.package && Array.isArray(input.execution.artifacts.package))
    input.execution.artifacts.package = Uint8Array.from(input.execution.artifacts.package);
  if (spec.artifactShape === "shadow") for (const key of ["buffer", "byteOffset", "byteLength"]) Object.defineProperty(
    input.execution.artifacts.package, key, { get() { state.foreignCalls++; throw new Error("foreign byte getter"); } });
  let binding = edit(original.runtimeBinding, spec.bindingEdits), options;
  const engineImage = input?.execution?.imageId;
  if (spec.rebindManifest) {
    const { networkJsonDigest } = await import("../packages/kernel/src/network-import-input.js");
    binding.manifestDigest = networkJsonDigest(input.execution.manifest);
  }
  let baseline = edit(original.baseline, spec.resultEdits);
  const documents = new Map(original.responses.map(r => [r.path, r.text]));
  const packResponses = () => (spec.responses ?? original.responses.map(r => ({ path: r.path, text: r.text })))
    .map(r => ({ path: r.path, bytes: r.length === undefined ? Buffer.from(r.text ?? "") : Buffer.alloc(r.length, 120) }));
  const fetchImpl = async (url, settings) => {
    fetches.push({ url, method: settings.method, redirect: settings.redirect, headers: settings.headers,
      bodyPresent: settings.body !== undefined, signalPresent: settings.signal instanceof AbortSignal,
      signalAborted: settings.signal.aborted });
    if (spec.mutateAtFetch) { input.request.input.version = "changed"; input.acquisition.credential.token = "changed";
      input.execution.policy.capability.permissions.network.push("https://other.invalid"); binding.imageId = "invalid"; }
    if (spec.advanceMs) clock += spec.advanceMs;
    if (spec.abortPhase === "fetch") controller.abort();
    if (spec.fetchThrow) {
      const e = new Error("HOST_ONLY_FIXTURE_CREDENTIAL");
      if (spec.errorCodeAccessor) Object.defineProperty(e, "code", { get() { state.foreignCalls++; throw new Error("foreign code"); } });
      else if (spec.errorCodeInherited) Object.setPrototypeOf(e, Object.assign(Object.create(Error.prototype), { code: spec.fetchThrow }));
      else e.code = spec.fetchThrow;
      throw e;
    }
    const path = url.slice(`https://api.${provider}.com`.length), raw = spec.responseText ?? documents.get(path) ?? "{}";
    const bytes = spec.responseLength === undefined ? Buffer.from(raw) : Buffer.alloc(spec.responseLength, 120);
    let offset = 0, done = false;
    const reader = {
      async read() {
        if (spec.abortPhase === "read") controller.abort();
        if (spec.stream === "throw") throw new Error("HOST_ONLY_FIXTURE_CREDENTIAL");
        if (spec.stream === "hang") return new Promise(resolve => { state.finishRead = resolve; });
        if (spec.chunkShape && !done) { done = true; return { done: false, value: spec.chunkShape === "array" ? [] :
          spec.chunkShape === "shared" ? new Uint8Array(new SharedArrayBuffer(1)) : new Uint8ClampedArray(1) }; }
        if (offset >= bytes.length) return { done: true };
        const count = Math.min(spec.chunkBytes ?? bytes.length, bytes.length - offset);
        const chunk = bytes.subarray(offset, offset + count); offset += count;
        return { done: false, value: chunk };
      },
      async cancel() { state.cancels++; state.finishRead?.({ done: true }); },
      releaseLock() { state.releases++; if (spec.releaseThrow) throw new Error("owned release failure"); },
    };
    const headers = new Headers({ "content-type": "application/json", ...spec.headers });
    const response = { status: spec.status ?? 200, redirected: spec.redirected ?? false, url: spec.responseUrl ?? "", headers,
      body: spec.nullBody ? null : { getReader: () => reader, cancel: async () => { state.cancels++; } } };
    return response;
  };
  const transport = async (args, settings) => {
    assert.ok(settings.timeoutMs > 0 && settings.timeoutMs <= 30000);
    calls.push({ args: copy(args), settings: { timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes,
      signalPresent: settings.signal !== undefined, signalAborted: settings.signal?.aborted ?? null,
      ...(Object.hasOwn(settings, "input") ? { inputBytes: Buffer.byteLength(settings.input), inputSha256: sha(settings.input) } : {}) } });
    // Capture the actual engine name and staging path even when create itself throws.
    if (args[1] === "create") {
      staged = args[args.indexOf("--mount") + 1].match(/source=([^,]+)/u)[1];
      nonce = args[args.indexOf("--label") + 1].split("=")[1];
    }
    if (spec.abortPhase === args[0] || spec.abortPhase === args[1]) controller.abort();
    if (spec.throwPhase === args[0] || spec.throwPhase === args[1]) {
      const e = new Error("HOST_ONLY_FIXTURE_CREDENTIAL"); e.code = spec.throwCode ?? "OWNED_FAILURE"; throw e;
    }
    if (args[0] === "info") return spec.infoResponse ?? { code: 0, stdout: JSON.stringify(fixture.server) };
    if (args[0] === "image") return { code: 0, stdout: engineImage };
    if (args[1] === "create") {
      const flag = k => args[args.indexOf(k) + 1];
      staged = flag("--mount").match(/source=([^,]+)/u)[1]; nonce = flag("--label").split("=")[1];
      info = { Id: fixture.containerId, Image: engineImage,
        Config: { Labels: { "morivyx.run": nonce }, User: "65534:65534", WorkingDir: "/input" },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
          SecurityOpt: ["no-new-privileges=true"], Memory: Number(flag("--memory")), MemorySwap: Number(flag("--memory-swap")),
          PidsLimit: 32, NanoCpus: 1000000000, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "none", CgroupnsMode: "private" },
        Mounts: [{ Type: "bind", Source: staged, Destination: "/input", RW: false }] };
      state.stagedFiles = await tree(staged);
      return spec.createResponse ?? { code: 0, stdout: fixture.containerId };
    }
    if (args[1] === "inspect") return { code: 0, stdout: JSON.stringify([edit(info, spec.inspectEdits)]) };
    if (args[1] === "ls") return { code: 0, stdout: info ? fixture.containerId : "" };
    if (args[1] === "start") {
      if (spec.stagedChange === "extra") await writeFile(join(staged, "extra"), "unlisted");
      if (spec.stagedChange === "bytes") await writeFile(join(staged, "response-0-0.bin"), "tampered");
      if (spec.stagedChange === "symlink") { await rm(join(staged, "response-0-0.bin")); await symlink("network-input.json", join(staged, "response-0-0.bin")); }
      try {
        const actual = await convert.convertNetworkImportInput(JSON.parse(settings.input), staged);
        if (spec.resultEdits) baseline = edit(actual, spec.resultEdits); else baseline = actual;
        return spec.startResponse ?? { code: 0, stdout: JSON.stringify(baseline) };
      } catch (error) { state.workerFailure = diagnostic(error); return { code: 1, stdout: "" }; }
    }
    if (args[1] === "rm") { removed = !spec.failCleanup; return { code: removed ? 0 : 1, stdout: fixture.containerId }; }
    throw new Error("unexpected owned engine operation");
  };
  let before, inputBefore, outcome;
  try {
    if (spec.operation === "pack" || spec.operation === "read" || spec.operation === "convert") {
      const request = input.request, responses = packResponses();
      if (spec.responseForeign === "accessor") Object.defineProperty(responses[0], "bytes", { enumerable: true,
        get() { state.foreignCalls++; throw new Error("foreign bytes"); } });
      try {
        const packed = convert.packNetworkImportInput(request, responses, Object.hasOwn(spec, "time") ? spec.time : fixture.time);
        if (spec.operation === "pack") outcome = { kind: "return", value: summarizePacked(packed) };
        else {
          const dir = join(outer, "input"); await mkdir(dir);
          for (const f of packed.files) await writeFile(join(dir, f.path), f.bytes);
          if (spec.readChange === "extra") await writeFile(join(dir, "extra"), "extra");
          if (spec.readChange === "bytes") await writeFile(join(dir, "response-0-0.bin"), "tampered");
          if (spec.readChange === "symlink") { await rm(join(dir, "response-0-0.bin")); await symlink("network-input.json", join(dir, "response-0-0.bin")); }
          if (spec.indexEdits) {
            const path = join(dir, "network-input.json"), index = JSON.parse(await readFile(path));
            await writeFile(path, JSON.stringify(edit(index, spec.indexEdits)));
          }
          if (spec.operation === "convert") outcome = { kind: "return", value: await convert.convertNetworkImportInput(request, dir) };
          else {
            const v = await convert.readNetworkImportInput(request, dir);
            outcome = { kind: "return", value: { ...v, responses: v.responses.map(r => ({ path: r.path, ...bytesSummary(r.bytes) })) } };
          }
        }
      } catch (error) { outcome = diagnostic(error); }
      return { output: { ...outcome, foreignCalls: state.foreignCalls }, observation: { elapsedMs: performance.now() - elapsedStart } };
    }
    if (spec.foreign) input = foreign(input, spec, state);
    options = Object.hasOwn(spec, "options") ? copy(spec.options) : { runtimeBinding: binding };
    options = edit(options, spec.optionEdits);
    if (options !== null && typeof options === "object" && !Array.isArray(options)) {
      if (!Object.hasOwn(options, "fetchImpl")) options.fetchImpl = fetchImpl;
      if (!Object.hasOwn(options, "transport")) options.transport = transport;
      if (!Object.hasOwn(options, "now")) options.now = () => Object.hasOwn(spec, "time") ? spec.time : fixture.time;
      if (spec.abortPhase || spec.stream === "hang") options.signal = controller.signal;
      if (spec.optionForeign) options = foreign(options, { foreign: spec.optionForeign, foreignKey: "runtimeBinding" }, state);
    }
    if (spec.abortPhase === "before") controller.abort();
    inputBefore = spec.foreign ? null : JSON.stringify(input);
    before = await tree(productRoot);
    try {
      const pending = runNetworkImportContainer(input, options);
      if (spec.mutateAfterCall) {
        input.request.input.version = "changed"; input.acquisition.credential.token = "changed";
        input.execution.artifacts.package.fill(0); input.execution.imageId = "invalid";
        binding.imageId = "invalid";
        options.fetchImpl = () => { throw new Error("replaced fetch"); };
        options.transport = () => { throw new Error("replaced engine"); };
        options.now = () => "invalid";
      }
      outcome = { kind: "return", value: await pending };
    }
    catch (error) { outcome = diagnostic(error); }
    const after = await tree(productRoot), staging = staged ? basename(dirname(staged)) : null;
    return { output: normalize({ ...outcome, inputUnchanged: inputBefore === null ? null : JSON.stringify(input) === inputBefore,
      foreignCalls: state.foreignCalls, fetches, calls, cancels: state.cancels, releases: state.releases,
      listeners: getEventListeners(controller.signal, "abort").length,
      stagedFiles: state.stagedFiles ?? null, workerFailure: state.workerFailure ?? null, removed, before, after }, outer, nonce, staging),
      observation: { elapsedMs: performance.now() - elapsedStart, clockMode: "controlled-Date-fixed-or-explicit-fetch-advance",
        initialClock: fixture.time, finalClockMs: clock } };
  } finally {
    globalThis.Date = NativeDate;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    process.umask(mask); await rm(outer, { recursive: true, force: true });
  }
}

export function configurationProbes() {
  const cases = [{ id: "additional/native-artifact-getters", spec: { artifactShape: "shadow" } }];
  for (const [i, time] of ["0000-01-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-09-09T24:00:00.000Z",
    "2026-09-09", "2026", "2026-09-09T07:00:00.1239Z", "Wed, 09 Sep 2026 07:00:00 GMT", "not-a-date",
    "2026-09-09T07:00:00+15:00", "+010000-01-01T00:00:00.000Z"].entries()) {
    cases.push({ id: `additional/clock-${i}`, spec: { time } });
    cases.push({ id: `additional/pack-clock-${i}`, spec: { operation: "pack", time } });
  }
  for (const count of [0, 19, 20]) cases.push({ id: `additional/pack-count-${count}`,
    spec: { operation: "pack", responses: Array.from({ length: count }, (_, i) => ({ path: `/r-${i}`, text: "{}" })) } });
  cases.push({ id: "additional/pack-total", spec: { operation: "pack", responses: Array.from({ length: 4 }, (_, i) => ({ path: `/r-${i}`, length: 2097152 })) } });
  for (const [i, time] of ["2026-09-09T07:00:00", "2000-01-01T00:00:00", "0000-01-01T00:00:00",
    "0", "1", "99", "2026/09/09"].entries()) cases.push({ id: `additional/local-clock-${i}`, spec: { time } });
  for (const provider of ["figma", "github"]) cases.push({ id: `additional/capture-before-await-${provider}`,
    spec: { provider, mutateAfterCall: true } });
  return cases.map(({ id, spec }) => ({ id, inputText: JSON.stringify(spec) }));
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main && process.argv.includes("--node-replay")) {
  const fixture = JSON.parse(await readFile(new URL("../packages/portable-core/fixtures/network-import-container-vectors.json", import.meta.url)));
  for (const [path, digest] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), digest, path);
  for (const entry of fixture.cases) assert.deepEqual((await nodeNetworkCase(entry, fixture)).output, entry.expected, entry.id);
  process.stdout.write(JSON.stringify({ valid: true, count: fixture.cases.length }) + "\n");
} else if (main) {
  test("frozen network input and original outcomes retain their digests", async () => {
    const raw = await readFile(new URL("../packages/portable-core/fixtures/network-import-container-vectors.json", import.meta.url));
    assert.equal(sha(raw), NETWORK_CONTAINER_PIN);
    const fixture = JSON.parse(raw); assert.equal(fixture.count, 554); assert.equal(fixture.cases.length, 554);
    assert.equal(new Set(fixture.cases.map(e => e.id)).size, 554);
    for (const entry of fixture.cases) {
      assert.equal(sha(entry.inputText), entry.inputSha256, entry.id);
      assert.equal(sha(JSON.stringify(entry.expected)), entry.outputSha256, entry.id);
    }
  });
  const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
  const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  function runPython(args, { cwd = core, executable = python, env = process.env, input } = {}) {
    const child = spawnSync(executable, ["-B", ...args], { cwd, env, input, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
  }
  async function verifyReplay(text) {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/network-import-container-vectors.json")));
    const rows = JSON.parse(text); assert.equal(rows.length, 554);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].id, fixture.cases[i].id);
      assert.deepEqual(rows[i].outcome, fixture.cases[i].expected, rows[i].id);
    }
  }
  test("Python reproduces every network framing and acquisition-to-container outcome", async () => {
    assert.match(runPython(["-m", "unittest", "test_network_import_container"]).stderr, /Ran 7 tests/);
    await verifyReplay(runPython(["test_network_import_container.py", "--replay"]).stdout);
  });
  test("47 public production modules reproduce the frozen exchange without Node or Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "morivyx-network-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(n => n.endsWith(".py") && !n.startsWith("test_") && !privateFiles.has(n));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_network_import_container.py"]) await cp(join(core, name), join(root, name));
      await mkdir(join(root, "fixtures"));
      await cp(join(core, "fixtures/network-import-container-vectors.json"), join(root, "fixtures/network-import-container-vectors.json"));
      const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      await verifyReplay(runPython(["test_network_import_container.py", "--replay"], {
        executable, cwd: root, env: { PATH: "", PYTHONIOENCODING: "utf-8" },
      }).stdout);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  let hasNodeSource = false;
  try { await access(new URL("../packages/kernel/src/network-import-container.js", import.meta.url)); hasNodeSource = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasNodeSource) test("Node reproduces the frozen preimplementation reference", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--node-replay"], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { valid: true, count: 554 });
  });
  if (hasNodeSource) test("additional clock and native byte boundaries preserve original outcomes", async () => {
    const fixture = JSON.parse(await readFile(join(core, "fixtures/network-import-container-vectors.json")));
    const entries = configurationProbes(), expected = [];
    for (const e of entries) expected.push({ id: e.id, outcome: (await nodeNetworkCase(e, fixture)).output });
    const actual = JSON.parse(runPython(["test_network_import_container.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
    assert.equal(entries.length, 34); assert.deepEqual(actual, expected);
  });
}
