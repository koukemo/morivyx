import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFile, writeFile, access, rm, symlink, mkdtemp, cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runNetworkImportContainer } from "../src/network-import-container.js";
import { networkDigest, networkJsonDigest, networkJson, networkResponseList } from "../src/network-import-input.js";
import { packNetworkImportInput } from "../src/network-import-conversion.js";
import { importGitHubFile } from "../src/github-importer.js";
import { importFigmaNode } from "../src/figma-importer.js";
import { writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { readGraphPackage } from "../src/package-reader.js";
import { validatePackage } from "../src/validator.js";

// This adapter exercises the actual worker process, not OS isolation. Issue #689 owns Docker proof.
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const figmaRequest = await json("../test/fixtures/figma-importer/request.json");
const githubRequest = await json("../test/fixtures/github-importer/request.json");
const figmaResponse = await json("../test/fixtures/figma-importer/response.json");
const template = await json("../test/fixtures/figma-importer/manifest.json");
const worker = fileURLToPath(new URL("../src/network-import-stdio.js", import.meta.url));
const packageBytes = Buffer.from("synthetic-package-for-offline-contract-only");
const imageId = `sha256:${"a".repeat(64)}`, containerId = "b".repeat(64);
const time = "2026-09-09T06:00:00.000Z";
const clone = structuredClone;
function policy(manifest) {
  const { id, version, packageDigest } = manifest.identity;
  const { id: capabilityId, effect, permissions, resources } = manifest.capabilities[0];
  return { format: "morivyx.plugin-host-policy/0.1", plugin: { id, version, packageDigest },
    capability: { id: capabilityId, effect, permissions: clone(permissions), resources: clone(resources) } };
}
function fixture(github = false) {
  const request = clone(github ? githubRequest : figmaRequest), host = clone(template);
  Object.assign(host.identity, request.plugin, { packageDigest: networkDigest(packageBytes) });
  const capability = host.capabilities[0];
  capability.id = request.capability.id;
  const system = github ? "github" : "figma", target = github ? "file" : "node";
  capability.inputFormat = github ? "morivyx.github-read-input/0.1" : "morivyx.figma-node-input/0.1";
  capability.outputFormat = `morivyx.${system}-${target}-snapshot/0.1`;
  capability.permissions.network = [`https://api.${system}.com`];
  capability.permissions.secrets = [`${system}-read-token`];
  const manifest = clone(host);
  manifest.capabilities[0].permissions.network = []; manifest.capabilities[0].permissions.secrets = [];
  manifest.capabilities[0].permissions.fileRead = ["network-import-input"];
  const acquisition = { manifest: host, policy: policy(host), permission: github ?
    { apiOrigin: "https://api.github.com", owner: request.input.owner, repository: request.input.repository, repositoryId: request.input.repositoryId } :
    { apiOrigin: "https://api.figma.com", fileKey: request.input.fileKey },
  credential: github ? { token: "HOST_ONLY_SECRET" } : { kind: "oauth", token: "HOST_ONLY_SECRET" } };
  const input = { request, acquisition, execution: { manifest, policy: policy(manifest), imageId, artifacts: { package: Buffer.from(packageBytes) } } };
  const runtimeBinding = { imageId, packageDigest: manifest.identity.packageDigest, manifestDigest: networkJsonDigest(manifest) };
  return { input, runtimeBinding };
}
function source(github = false, request = github ? githubRequest : figmaRequest, changed = false, content) {
  const documents = new Map(); const calls = [];
  if (!github) {
    const response = clone(figmaResponse); response.version = request.input.version;
    if (changed) response.nodes["1:2"].document.absoluteBoundingBox.width = 123;
    documents.set(`https://api.figma.com/v1/files/fixtureFile/nodes?ids=1%3A2&version=${request.input.version}`, response);
  }
  else {
    const bytes = content ?? Buffer.from(changed ? "changed converted source\n" : "actual converted source\n"), tree = "2".repeat(40);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const prefix = "https://api.github.com/repos/fixture-owner/fixture-repository";
    documents.set(prefix, { id: 123, full_name: "fixture-owner/fixture-repository" });
    documents.set(`${prefix}/git/commits/${request.input.commit}`, { sha: request.input.commit, tree: { sha: tree } });
    documents.set(`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false,
      tree: [{ path: "source.txt", type: "blob", mode: "100644", sha: blob, size: bytes.length }] });
    documents.set(`${prefix}/git/blobs/${blob}`, { sha: blob, size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
  }
  const fetchImpl = async (url, settings) => {
    calls.push({ url, settings }); assert.equal(settings.method, "GET"); assert.equal(settings.redirect, "manual");
    assert.ok(documents.has(url));
    return new Response(JSON.stringify(documents.get(url)), { headers: { "content-type": "application/json" } });
  };
  return { documents, calls, fetchImpl };
}
function runWorker(cwd, grant, settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { cwd, env: { PATH: "/usr/bin:/bin", MORIVYX_PLUGIN_EXECUTION_GRANT: grant }, stdio: "pipe" });
    let size = 0; const stdout = [], stderr = [];
    const abort = () => child.kill("SIGKILL"), timer = setTimeout(abort, settings.timeoutMs);
    settings.signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", bytes => {
      size += bytes.length; if (size > settings.maxOutputBytes) abort(); else chunks.push(bytes);
    });
    child.on("error", reject); child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer); settings.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(settings.input);
  });
}
function engine({ beforeStart, changeResult, failCleanup = false, start } = {}) {
  const calls = []; let info, staged, grant;
  const transport = async (args, settings) => {
    calls.push({ args, settings });
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ OSType: "linux", MemoryLimit: true, SwapLimit: true,
      PidsLimit: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin"] }) };
    if (args[0] === "image") return { code: 0, stdout: imageId };
    if (args[1] === "create") {
      const value = name => args[args.indexOf(name) + 1];
      staged = value("--mount").match(/source=([^,]+)/)[1];
      grant = value("--env").slice("MORIVYX_PLUGIN_EXECUTION_GRANT=".length);
      assert.ok(args.includes("--network=none")); assert.ok(args.includes("--read-only"));
      assert.equal(JSON.stringify(args).includes("HOST_ONLY_SECRET"), false);
      info = { Id: containerId, Image: imageId,
        Config: { Labels: { "morivyx.run": value("--label").split("=")[1] }, User: "65534:65534", WorkingDir: "/input" },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null,
          SecurityOpt: ["no-new-privileges=true"], Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")),
          PidsLimit: 32, NanoCpus: 1000000000, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "none", CgroupnsMode: "private" },
        Mounts: [{ Type: "bind", Source: staged, Destination: "/input", RW: false }] };
      return { code: 0, stdout: containerId };
    }
    if (args[1] === "inspect") return { code: 0, stdout: JSON.stringify([info]) };
    if (args[1] === "start") {
      await beforeStart?.(staged);
      if (start) return start(settings);
      const output = await runWorker(staged, grant, settings);
      if (changeResult && output.code === 0) output.stdout = JSON.stringify(changeResult(JSON.parse(output.stdout)));
      return output;
    }
    if (args[1] === "rm") return { code: failCleanup ? 1 : 0, stdout: containerId };
    throw new Error("unexpected operation");
  };
  return { calls, transport, staged: () => staged };
}
let checks = 0;
async function check(name, test) { try { await test(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
const rejected = (run, code) => assert.rejects(run, error => error.code === code);
const run = (f, s, e, extra = {}) => runNetworkImportContainer(f.input,
  { runtimeBinding: f.runtimeBinding, fetchImpl: s.fetchImpl, transport: e.transport, now: () => time, ...extra });

for (const github of [false, true]) await check(`actual worker recomputes ${github ? "GitHub" : "Figma"} parity`, async () => {
  const f = fixture(github), s = source(github), e = engine();
  const baseline = github ? await importGitHubFile(f.input.request, { permission: f.input.acquisition.permission, token: "HOST_ONLY_SECRET", fetchImpl: s.fetchImpl, now: () => time }) :
    await importFigmaNode(f.input.request, { permission: f.input.acquisition.permission, credential: f.input.acquisition.credential, fetchImpl: s.fetchImpl, now: () => time });
  assert.equal(baseline.status, "success");
  const output = await run(f, s, e);
  assert.deepEqual(output.result, baseline); assert.equal(output.acquisition.requestCount, github ? 4 : 1);
  assert.equal(output.binding.executionBinding, "not-verified"); assert.equal(output.binding.authenticity, "not-verified");
  assert.equal(output.isolation.containerRemoved, true); assert.equal(e.calls.at(-1).args[1], "rm");
  assert.equal(JSON.stringify(output).includes("PRIVATE_NODE"), false);
  assert.equal(JSON.stringify(output).includes("HOST_ONLY_SECRET"), false);
  await assert.rejects(access(e.staged()), { code: "ENOENT" });
});

await check("invalid authorization pins options and limits perform zero external IO", async () => {
  for (const change of [f => { f.input.request.input.version = ""; }, f => { f.input.acquisition.permission.fileKey = "other"; },
    f => { f.input.execution.manifest.capabilities[0].permissions.network = ["https://api.figma.com"]; },
    f => { f.input.execution.artifacts.package[0] ^= 1; }, f => { f.runtimeBinding.imageId = "sha256:" + "c".repeat(64); },
    f => { f.input.acquisition.credential.token = "token\nsecret"; }, f => { f.input.acquisition.limits = { maxResponseBytes: 2097153 }; },
    f => { f.input.execution.policy.capability.resources.maxCostUnits = 1; }, f => { f.input.execution.policy.capability.resources.maxMemoryBytes = 1; }]) {
    const f = fixture(); change(f); const s = source(), e = engine();
    await assert.rejects(run(f, s, e)); assert.equal(s.calls.length, 0); assert.equal(e.calls.length, 0);
  }
  const f = fixture(), s = source(), e = engine(); let invoked = false;
  Object.defineProperty(f.input.acquisition, "credential", { get() { invoked = true; return "secret"; }, enumerable: true });
  await assert.rejects(run(f, s, e)); assert.equal(invoked, false); assert.equal(s.calls.length, 0);
});

await check("caller mutations after await cannot change credentials request policy or pins", async () => {
  const f = fixture(), s = source(), e = engine();
  const fetchImpl = async (url, settings) => {
    f.input.request.input.version = "different"; f.input.acquisition.credential.token = "other";
    f.input.execution.policy.capability.permissions.network = ["https://evil.invalid"];
    f.input.execution.imageId = "invalid"; f.runtimeBinding.imageId = "invalid";
    assert.equal(settings.headers.Authorization, "Bearer HOST_ONLY_SECRET");
    return s.fetchImpl(url, settings);
  };
  const output = await run(f, s, e, { fetchImpl });
  assert.equal(output.result.output.source.version, "1001"); assert.equal(output.isolation.imageId, imageId);
});

await check("logical snapshots retain source string spelling and reject unsafe bytes and lists", async () => {
  const value = { path: "2026-09-09T06:00:00.000Z", text: "e\u0301" };
  assert.deepEqual(networkJson(value), value);
  for (const list of [Array(1), new Proxy([], {}), [{ path: "/a", bytes: new Uint8Array(new SharedArrayBuffer(1)) }],
    [{ path: "//other/path", bytes: Buffer.from("{}")}], [{ path: "/a", bytes: Buffer.alloc(2097153) }]])
    assert.throws(() => networkResponseList(list));
  let invoked = false; const item = { path: "/a", get bytes() { invoked = true; return Buffer.from("{}"); } };
  assert.throws(() => networkResponseList([item])); assert.equal(invoked, false);
  const detached = new Uint8Array(1); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.throws(() => networkResponseList([{ path: "/a", bytes: detached }]));
});

await check("index bytes count toward the total and chunks never exceed one MiB", async () => {
  const captured = Array.from({ length: 4 }, (_, i) => ({ path: `/response-${i}`, bytes: Buffer.alloc(2097152) }));
  assert.throws(() => packNetworkImportInput(figmaRequest, captured, time), error => error.code === "NETWORK_IMPORT_INPUT_LIMIT");
  const packed = packNetworkImportInput(figmaRequest, captured.slice(0, 1), time);
  assert.equal(packed.files.length, 3);
  assert.ok(packed.files.every(file => file.bytes.length <= 1048576));
  assert.equal(JSON.parse(packed.files[0].bytes).responses[0].bodyBytes, 2097152);
});

await check("large GitHub blob is split and recomputed from binary content", async () => {
  const bytes = Buffer.alloc(1048576, 255), f = fixture(true), s = source(true, githubRequest, false, bytes), e = engine();
  const result = await run(f, s, e);
  assert.equal(result.result.output.byteLength, bytes.length); assert.equal(result.result.output.digest, networkDigest(bytes));
});

await check("request count response bytes and aggregate bytes enforce lower host limits", async () => {
  for (const [limits, code, maxCalls] of [[{ maxRequests: 2 }, "REQUEST_LIMIT", 2],
    [{ maxResponseBytes: 1 }, "RESPONSE_LIMIT", 1], [{ maxTotalResponseBytes: 1 }, "RESPONSE_LIMIT", 1]]) {
    const f = fixture(true), s = source(true), e = engine(); f.input.acquisition.limits = limits;
    await rejected(run(f, s, e), `NETWORK_IMPORT_${code}`);
    assert.ok(s.calls.length <= maxCalls); assert.equal(e.calls.length, 0);
  }
});

await check("reused stream chunks are copied before the next read", async () => {
  const f = fixture(), s = source(), e = engine();
  const raw = Buffer.from(JSON.stringify(figmaResponse)), storage = Buffer.alloc(17); let offset = 0;
  const fetchImpl = async () => new Response(new ReadableStream({ pull(controller) {
    storage.fill(0);
    if (offset === raw.length) { controller.close(); return; }
    const count = Math.min(storage.length, raw.length - offset);
    storage.set(raw.subarray(offset, offset + count)); offset += count; controller.enqueue(storage.subarray(0, count));
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const output = await run(f, s, e, { fetchImpl });
  assert.equal(output.acquisition.responseBytes, raw.length); assert.equal(output.result.status, "success");
});

await check("adapter exception messages and untrusted error codes never escape", async () => {
  for (const code of ["NETWORK_IMPORT_HOST_ONLY_SECRET", "NETWORK_IMPORT_SOURCE_UNAVAILABLE"]) {
    const error = new Error("HOST_ONLY_SECRET"); error.code = code;
    await assert.rejects(run(fixture(), source(), engine(), { fetchImpl: async () => { throw error; } }), failure =>
      failure.code === "NETWORK_IMPORT_SOURCE_UNAVAILABLE" && !JSON.stringify(failure).includes("HOST_ONLY_SECRET") &&
      !failure.message.includes("HOST_ONLY_SECRET"));
  }
});

await check("output limits reject the worker result after cleanup", async () => {
  const f = fixture(), e = engine(); f.input.execution.policy.capability.resources.maxOutputBytes = 1;
  await rejected(run(f, source(), e), "NETWORK_IMPORT_PLUGIN_FAILED");
  await assert.rejects(access(e.staged()), { code: "ENOENT" });
});

await check("redirect unavailable malformed and oversized responses never launch a worker", async () => {
  for (const [response, code] of [
    [() => new Response("", { status: 302, headers: { location: "https://evil.invalid" } }), "REDIRECT_DENIED"],
    [() => new Response("HOST_ONLY_SECRET", { status: 503 }), "SOURCE_UNAVAILABLE"],
    [() => new Response("not-json", { headers: { "content-type": "application/json" } }), "RESPONSE_INVALID"],
    [() => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2097153" } }), "RESPONSE_LIMIT"],
  ]) {
    const f = fixture(), s = source(), e = engine();
    await rejected(run(f, s, e, { fetchImpl: async () => response() }), `NETWORK_IMPORT_${code}`);
    assert.equal(e.calls.length, 0);
  }
});

await check("changed bundle bytes index digest paths symlinks and extra files are rejected", async () => {
  for (const change of [
    async root => writeFile(`${root}/response-0-0.bin`, "tampered"),
    async root => writeFile(`${root}/extra`, "unlisted"),
    async root => { await rm(`${root}/response-0-0.bin`); await symlink("network-input.json", `${root}/response-0-0.bin`); },
    async root => {
      const index = JSON.parse(await readFile(`${root}/network-input.json`, "utf8")); index.responses[0].chunks[0] = "../escape";
      await writeFile(`${root}/network-input.json`, JSON.stringify(index));
    },
    async root => {
      const index = JSON.parse(await readFile(`${root}/network-input.json`, "utf8")); index.requestDigest = "sha256:" + "0".repeat(64);
      await writeFile(`${root}/network-input.json`, JSON.stringify(index));
    },
  ]) {
    const e = engine({ beforeStart: change });
    await rejected(run(fixture(), source(), e), "NETWORK_IMPORT_PLUGIN_FAILED");
    await assert.rejects(access(e.staged()), { code: "ENOENT" });
  }
});

await check("forged result cannot replace recomputed provenance or digest", async () => {
  for (const change of [v => { v.output.digest = "sha256:" + "0".repeat(64); return v; },
    v => { v.output.retrievedAt = "2020-01-01T00:00:00.000Z"; return v; }]) {
    const e = engine({ changeResult: change });
    await rejected(run(fixture(), source(), e), "NETWORK_IMPORT_RESULT_MISMATCH");
    await assert.rejects(access(e.staged()), { code: "ENOENT" });
  }
});

await check("abort before acquisition produces no IO and no listener leak", async () => {
  const controller = new AbortController(); controller.abort(); const s = source(), e = engine();
  await rejected(run(fixture(), s, e, { signal: controller.signal }), "NETWORK_IMPORT_CANCELLED");
  assert.equal(s.calls.length, 0); assert.equal(e.calls.length, 0); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

await check("acquisition time is deducted from the worker budget", async () => {
  const f = fixture(), s = source(), e = engine(); f.input.acquisition.limits = { timeoutMs: 2000 };
  await run(f, s, e, { fetchImpl: async (...args) => { await new Promise(resolve => setTimeout(resolve, 60)); return s.fetchImpl(...args); } });
  const started = e.calls.find(call => call.args[1] === "start");
  assert.ok(started.settings.timeoutMs > 0 && started.settings.timeoutMs <= 1950);
});

await check("late fetch completion after cancellation cancels unread response and never starts conversion", async () => {
  const controller = new AbortController(), s = source(), e = engine(); let finish, cancels = 0;
  const pending = run(fixture(), s, e, { signal: controller.signal, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  controller.abort(); await rejected(pending, "NETWORK_IMPORT_CANCELLED");
  finish(new Response(new ReadableStream({ cancel() { cancels++; } }), { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancels, 1); assert.equal(e.calls.length, 0);
});

await check("timeout and cancellation discard late responses and cancel body reads", async () => {
  for (const byTimeout of [true, false]) {
    const f = fixture(), s = source(), e = engine(), controller = new AbortController(); let cancelCount = 0;
    f.input.acquisition.limits = { timeoutMs: byTimeout ? 20 : 30000 };
    const fetchImpl = async () => new Response(new ReadableStream({ start() {}, cancel() { cancelCount++; } }),
      { headers: { "content-type": "application/json" } });
    const pending = run(f, s, e, { fetchImpl, signal: controller.signal });
    if (!byTimeout) setTimeout(() => controller.abort(), 10);
    await rejected(pending, `NETWORK_IMPORT_${byTimeout ? "TIMEOUT" : "CANCELLED"}`);
    assert.equal(cancelCount, 1); assert.equal(e.calls.length, 0); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

await check("worker cancellation waits for cleanup and cleanup failure retains recovery identity", async () => {
  const controller = new AbortController();
  const e = engine({ start: async () => { controller.abort(); return { code: 1, stdout: "" }; } });
  await rejected(run(fixture(), source(), e, { signal: controller.signal }), "NETWORK_IMPORT_CANCELLED");
  assert.equal(e.calls.at(-1).args[1], "rm"); await assert.rejects(access(e.staged()), { code: "ENOENT" });
  const broken = engine({ failCleanup: true }); let recovery;
  await assert.rejects(run(fixture(), source(), broken), error => {
    recovery = error.details; return error.code === "PLUGIN_ISOLATION_CLEANUP_FAILED" && recovery.containerId === containerId;
  });
  assert.equal(recovery.stagingPath, dirname(broken.staged()));
  await rm(recovery.stagingPath, { recursive: true, force: true });
});

async function tree(root) {
  const result = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) for (const [key, value] of Object.entries(await tree(join(root, item.name)))) result[`${item.name}/${key}`] = value;
    else result[item.name] = (await readFile(join(root, item.name))).toString("base64");
  }
  return result;
}
for (const github of [false, true]) await check(`${github ? "GitHub" : "Figma"} isolated result saves and reimports through unchanged Core contracts`, async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-network-core-"));
  try {
    const empty = join(root, "empty"), initial = join(root, "initial"), updated = join(root, "updated");
    await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
    await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
    await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
    const unchangedEmpty = await tree(empty);
    const f = fixture(github), first = await run(f, source(github), engine());
    const authoring = await json("../test/fixtures/plugin-communication/import-authoring.json");
    const create = { ...authoring, manifest: f.input.execution.manifest, runRequest: f.input.request, runResult: first.result,
      resultingRevision: "graph:network-initial", recordedAt: "2026-09-09T06:00:01Z" };
    await writeImportedSnapshotPackage({ basePath: empty, outputPath: initial, request: create });
    assert.equal((await validatePackage(initial)).valid, true);
    assert.deepEqual(await tree(empty), unchangedEmpty);
    const base = await readGraphPackage(initial), unchangedInitial = await tree(initial);
    assert.equal(base.elements[0].extensions["morivyx.import/snapshot"].executionBinding, "not-verified");
    assert.deepEqual(base.elements[0].extensions["morivyx.import/snapshot"].informationLoss, first.result.output.informationLoss);
    const next = fixture(github); next.input.request.runId = "run:network-second";
    if (github) next.input.request.input.commit = "3".repeat(40); else next.input.request.input.version = "1002";
    const second = await run(next, source(github, next.input.request, true), engine(), { now: () => "2026-09-09T06:01:00.000Z" });
    const revise = { ...create, format: "morivyx.import-snapshot-revision/0.1", runRequest: next.input.request, runResult: second.result,
      baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision,
      changeSetId: "urn:uuid:00000000-0000-4000-8000-000000000803", resultingRevision: "graph:network-updated", recordedAt: "2026-09-09T06:01:01Z" };
    await writeReimportedSnapshotPackage({ basePath: initial, outputPath: updated, request: revise });
    assert.equal((await validatePackage(updated)).valid, true); assert.deepEqual(await tree(initial), unchangedInitial);
    const saved = await readGraphPackage(updated);
    assert.equal(saved.elements[0].id, base.elements[0].id);
    assert.notEqual(saved.elements[0].attributes.digest, base.elements[0].attributes.digest);
    assert.equal(saved.approvals.length, 0);
    const record = saved.elements[0].extensions["morivyx.import/snapshot"];
    assert.equal(record.executionBinding, "not-verified");
    assert.deepEqual(record.informationLoss, second.result.output.informationLoss);
    for (const bytes of Object.values(await tree(updated))) {
      const text = Buffer.from(bytes, "base64").toString();
      for (const secret of ["HOST_ONLY_SECRET", "PRIVATE_NODE_NAME", "PRIVATE_NODE_TEXT", "actual converted source", "response-0-0.bin", "network-input.json"])
        assert.equal(text.includes(secret), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

console.log(`Network import contract audit passed: ${checks} checks; real stdio conversion and Core persistence, simulated Docker only.`);
