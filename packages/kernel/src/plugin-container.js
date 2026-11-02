import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { types } from "node:util";
import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";
import { createPluginExecutionGrant, validatePluginRunResult, PLUGIN_EXECUTION_GRANT_ENV } from "./plugin-communication.js";

export const PLUGIN_ISOLATED_RUN_FORMAT = "morivyx.plugin-isolated-run/0.1";
export const PLUGIN_CONTAINER_LIMITS = Object.freeze({
  maxFiles: 256, maxFileBytes: 1048576, maxTotalBytes: 8388608,
  maxRequestBytes: 1048576, maxGrantBytes: 65536, maxOutputBytes: 1048576,
  maxTimeoutMs: 30000, minMemoryBytes: 33554432, maxMemoryBytes: 268435456,
  defaultMemoryBytes: 134217728, pids: 32, cpus: 1, cleanupTimeoutMs: 5000,
});
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const CONTAINER = /^[0-9a-f]{64}$/;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteGetters = Object.fromEntries(["buffer", "byteOffset", "byteLength"].map(key =>
  [key, Object.getOwnPropertyDescriptor(typedArrayPrototype, key).get]));
function failure(code) {
  return new PackageError(`PLUGIN_ISOLATION_${code}`, "/isolation", "Pluginの隔離実行を完了できません。");
}
function assert(condition, code) { if (!condition) throw failure(code); }
function record(value, keys, required = keys) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return keys.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, "value");
  }) && required.every(key => Object.hasOwn(value, key));
}
function ownedBytes(value) {
  assert(types.isUint8Array(value), "INPUT_INVALID");
  const buffer = Reflect.apply(byteGetters.buffer, value, []);
  assert(!types.isSharedArrayBuffer(buffer), "INPUT_INVALID");
  const offset = Reflect.apply(byteGetters.byteOffset, value, []);
  const length = Reflect.apply(byteGetters.byteLength, value, []);
  assert(length <= PLUGIN_CONTAINER_LIMITS.maxFileBytes, "INPUT_LIMIT");
  try { return Buffer.from(new Uint8Array(buffer, offset, length)); }
  catch { throw failure("INPUT_INVALID"); }
}
function prepare(input) {
  assert(record(input, ["manifest", "request", "policy", "imageId", "files"]), "INPUT_INVALID");
  const initial = createPluginExecutionGrant(input.manifest, input.request, input.policy);
  assert(typeof input.imageId === "string" && IMAGE.test(input.imageId), "IMAGE_INVALID");
  assert(["graphRead", "network", "secrets", "devices"].every(key => initial.capability.permissions[key].length === 0),
    "PERMISSION_UNSUPPORTED");
  assert(!Object.hasOwn(initial.capability.resources, "maxCostUnits"), "RESOURCE_UNSUPPORTED");
  const memory = Math.min(initial.capability.resources.maxMemoryBytes ?? PLUGIN_CONTAINER_LIMITS.defaultMemoryBytes,
    PLUGIN_CONTAINER_LIMITS.maxMemoryBytes);
  assert(memory >= PLUGIN_CONTAINER_LIMITS.minMemoryBytes, "RESOURCE_UNSUPPORTED");
  const grant = { ...initial, capability: { ...initial.capability, resources: {
    ...initial.capability.resources,
    timeoutMs: Math.min(initial.capability.resources.timeoutMs, PLUGIN_CONTAINER_LIMITS.maxTimeoutMs),
    maxOutputBytes: Math.min(initial.capability.resources.maxOutputBytes, PLUGIN_CONTAINER_LIMITS.maxOutputBytes),
    maxMemoryBytes: memory,
  } } };
  const request = structuredClone(input.request);
  const requestText = `${JSON.stringify(request)}\n`;
  const grantText = canonicalJson(grant);
  assert(Buffer.byteLength(requestText) <= PLUGIN_CONTAINER_LIMITS.maxRequestBytes &&
    Buffer.byteLength(grantText) <= PLUGIN_CONTAINER_LIMITS.maxGrantBytes, "INPUT_LIMIT");
  assert(Array.isArray(input.files) && !types.isProxy(input.files) && input.files.length <= PLUGIN_CONTAINER_LIMITS.maxFiles, "INPUT_INVALID");
  // Dense data properties only; never evaluate an accessor in the file list.
  assert(Reflect.ownKeys(input.files).length === input.files.length + 1, "INPUT_INVALID");
  const paths = new Set(); const files = []; let total = 0;
  for (let index = 0; index < input.files.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.files, String(index));
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, "value"), "INPUT_INVALID");
    const file = descriptor.value;
    assert(record(file, ["path", "permission", "bytes"]), "INPUT_INVALID");
    assert(typeof file.path === "string" && file.path.length > 0 && file.path.length <= 1024 &&
      !isAbsolute(file.path) && !/[:\\\u0000-\u001f\u007f]/.test(file.path) &&
      file.path.split("/").every(part => part.length > 0 && part !== "." && part !== ".."), "PATH_INVALID");
    try { canonicalJson(file.path); } catch { throw failure("PATH_INVALID"); }
    assert(!paths.has(file.path), "PATH_INVALID");
    assert(typeof file.permission === "string" && initial.capability.permissions.fileRead.includes(file.permission), "PERMISSION_DENIED");
    const bytes = ownedBytes(file.bytes); total += bytes.length;
    assert(total <= PLUGIN_CONTAINER_LIMITS.maxTotalBytes, "INPUT_LIMIT");
    paths.add(file.path); files.push({ path: file.path, bytes });
  }
  for (const path of paths) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { assert(!paths.has(parts.join("/")), "PATH_INVALID"); parts.pop(); }
  }
  return { request, requestText, grantText, grant, files, imageId: input.imageId };
}

function invoke(command, args, options) {
  return new Promise((resolve, reject) => {
    let child; let timer; let settled = false; let size = 0;
    const stdout = []; const stderr = [];
    const abort = () => fail("CANCELLED");
    const fail = (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      child?.kill("SIGKILL"); reject(failure(code));
    };
    if (options.signal?.aborted) { fail("CANCELLED"); return; }
    try { child = spawn(command, args, { shell: false, cwd: options.cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { fail("UNAVAILABLE"); return; }
    timer = setTimeout(() => fail("TIMEOUT"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => fail("UNAVAILABLE"));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", chunk => {
        size += chunk.length;
        if (size > options.maxOutputBytes) { fail("OUTPUT_LIMIT"); return; }
        chunks.push(chunk);
      });
    }
    child.stdin.on("error", () => {}); // A rejected/terminated container may close stdin first.
    child.stdin.end(options.input ?? "");
    child.on("close", code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)); }
      catch { reject(failure("RESULT_INVALID")); return; }
      resolve({ code, stdout: text, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function verifyConfiguration(info, state, source) {
  assert(info !== null && typeof info === "object", "CONFIGURATION_MISMATCH");
  const h = info.HostConfig; const c = info.Config; const mounts = info.Mounts;
  const security = h?.SecurityOpt;
  assert(info.Id === state.id && info.Image === state.prepared.imageId && c?.Labels?.["morivyx.run"] === state.nonce &&
    c.User === "65534:65534" && c.WorkingDir === "/input" &&
    h?.NetworkMode === "none" && h.ReadonlyRootfs === true && h.Privileged === false &&
    Array.isArray(h.CapDrop) && h.CapDrop.length === 1 && typeof h.CapDrop[0] === "string" && h.CapDrop[0].toUpperCase() === "ALL" &&
    (h.CapAdd === null || h.CapAdd?.length === 0) &&
    Array.isArray(security) && security.length === 1 && security.some(value => value === "no-new-privileges" || value === "no-new-privileges=true") &&
    h.Memory === state.prepared.grant.capability.resources.maxMemoryBytes && h.MemorySwap === h.Memory &&
    h.PidsLimit === 32 && h.NanoCpus === 1000000000 && h.LogConfig?.Type === "none" &&
    h.PidMode === "" && h.IpcMode === "none" && h.CgroupnsMode === "private" &&
    Array.isArray(mounts) && mounts.length === 1 && mounts[0].Type === "bind" &&
    mounts[0].Source === source && mounts[0].Destination === "/input" && mounts[0].RW === false,
    "CONFIGURATION_MISMATCH");
}

export async function runPluginContainer(input, options = {}) {
  const prepared = prepare(input); // Snapshot all caller-owned data before the first await.
  assert(record(options, ["dockerPath", "transport", "signal"], []), "OPTIONS_INVALID");
  const dockerPath = options.dockerPath ?? "/usr/bin/docker";
  assert(typeof dockerPath === "string" && isAbsolute(dockerPath) && !dockerPath.includes("\0"), "OPTIONS_INVALID");
  assert(options.transport === undefined || typeof options.transport === "function", "OPTIONS_INVALID");
  const injectedTransport = options.transport; const signal = options.signal;
  assert(signal === undefined || signal instanceof AbortSignal, "OPTIONS_INVALID");
  assert(!signal?.aborted, "CANCELLED");
  const root = await mkdtemp(join(tmpdir(), "morivyx-isolated-"));
  const source = join(root, "input"); const config = join(root, "config");
  const state = { prepared, nonce: randomUUID(), id: null, attempted: false };
  const name = `morivyx-plugin-${state.nonce}`;
  const deadline = Date.now() + prepared.grant.capability.resources.timeoutMs;
  const prefix = ["--host", "unix:///var/run/docker.sock", "--config", config];
  // transport is a trusted host/test adapter, never a field accepted from Plugin JSON.
  const transport = injectedTransport ?? ((args, settings) => invoke(dockerPath, [...prefix, ...args], { ...settings, cwd: root }));
  const control = async (args, cleanup = false) => {
    const timeoutMs = cleanup ? PLUGIN_CONTAINER_LIMITS.cleanupTimeoutMs : Math.min(5000, deadline - Date.now());
    assert(timeoutMs > 0, "TIMEOUT");
    assert(cleanup || !signal?.aborted, "CANCELLED");
    if (args[0] === "container" && args[1] === "create") state.attempted = true;
    return transport(args, { timeoutMs, maxOutputBytes: 262144, signal: cleanup ? undefined : signal });
  };
  let outcome; let operationError; let cleanupError;
  try {
    assert(!/[,\u0000-\u001f\u007f]/.test(source), "PATH_INVALID");
    await mkdir(source, { mode: 0o755 }); await mkdir(config, { mode: 0o700 });
    for (const file of prepared.files) {
      const destination = join(source, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o444 });
    }
    const server = await control(["info", "--format", "{{json .}}"]);
    let serverInfo; try { serverInfo = JSON.parse(server.stdout); } catch { throw failure("UNAVAILABLE"); }
    assert(server.code === 0 && serverInfo?.OSType === "linux" && serverInfo.MemoryLimit === true &&
      serverInfo.SwapLimit === true && serverInfo.PidsLimit === true && serverInfo.CpuCfsQuota === true &&
      Array.isArray(serverInfo.SecurityOptions) && serverInfo.SecurityOptions.some(value =>
        typeof value === "string" && value.startsWith("name=seccomp")), "UNAVAILABLE");
    const image = await control(["image", "inspect", prepared.imageId, "--format", "{{.Id}}"]);
    assert(image.code === 0 && image.stdout.trim() === prepared.imageId, "IMAGE_UNAVAILABLE");
    const resources = prepared.grant.capability.resources;
    const created = await control(["container", "create", "--pull=never", "--name", name,
      "--label", `morivyx.run=${state.nonce}`, "--interactive", "--network=none", "--read-only",
      "--user", "65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
      "--memory", String(resources.maxMemoryBytes), "--memory-swap", String(resources.maxMemoryBytes),
      "--pids-limit=32", "--cpus=1", "--ipc=none", "--cgroupns=private", "--log-driver=none",
      "--workdir=/input", "--mount", `type=bind,source=${source},target=/input,readonly,bind-propagation=rprivate`,
      "--env", `${PLUGIN_EXECUTION_GRANT_ENV}=${prepared.grantText}`, prepared.imageId]);
    assert(created.code === 0 && CONTAINER.test(created.stdout.trim()), "CREATE_FAILED");
    state.id = created.stdout.trim();
    const inspected = await control(["container", "inspect", state.id]);
    assert(inspected.code === 0, "CONFIGURATION_MISMATCH");
    let info; try { info = JSON.parse(inspected.stdout)[0]; } catch { throw failure("CONFIGURATION_MISMATCH"); }
    verifyConfiguration(info, state, source);
    const remaining = deadline - Date.now(); assert(remaining > 0, "TIMEOUT");
    assert(!signal?.aborted, "CANCELLED");
    const executed = await transport(["container", "start", "--attach", "--interactive", state.id],
      { input: prepared.requestText, timeoutMs: remaining, maxOutputBytes: resources.maxOutputBytes, signal });
    assert(executed.code === 0, "RUN_FAILED");
    const text = executed.stdout.trim(); assert(text.length > 0 && !text.includes("\n"), "RESULT_INVALID");
    let result;
    try { result = validatePluginRunResult(JSON.parse(text), prepared.request); }
    catch { throw failure("RESULT_INVALID"); }
    outcome = { format: PLUGIN_ISOLATED_RUN_FORMAT, result, isolation: {
      backend: "docker", imageId: prepared.imageId, containerId: state.id, network: "none",
      rootFilesystem: "read-only", inputFilesystem: "read-only", uid: 65534, gid: 65534,
      capabilities: [], noNewPrivileges: true, memoryBytes: resources.maxMemoryBytes,
      pidsLimit: 32, cpuLimit: 1, containerRemoved: true,
    } };
  } catch (error) { operationError = error; }
  finally {
    try {
      if (state.attempted) {
        if (state.id === null) {
          const listed = await control(["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], true);
          assert(listed.code === 0, "CLEANUP_FAILED");
          // A lost create response can race the daemon. An empty list cannot prove cancellation.
          assert(CONTAINER.test(listed.stdout.trim()), "CLEANUP_FAILED");
          state.id = listed.stdout.trim();
        }
        if (state.id !== null) {
          const inspected = await control(["container", "inspect", state.id], true);
          const found = inspected.code === 0 ? JSON.parse(inspected.stdout)[0] : null;
          assert(found?.Id === state.id && found?.Config?.Labels?.["morivyx.run"] === state.nonce, "CLEANUP_FAILED");
          const removed = await control(["container", "rm", "--force", "--volumes", state.id], true);
          assert(removed.code === 0, "CLEANUP_FAILED");
        }
      }
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanupError = failure("CLEANUP_FAILED");
      cleanupError.details = { containerId: state.id, containerName: name, stagingPath: root };
    }
  }
  if (cleanupError) throw cleanupError;
  if (operationError) {
    operationError.isolation = { containerId: state.id, containerRemoved: state.id !== null };
    throw operationError;
  }
  return outcome;
}
