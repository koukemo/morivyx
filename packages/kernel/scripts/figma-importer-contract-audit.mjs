import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { canonicalJson } from "../src/canonical.js";
import { FIGMA_API_ORIGIN, FIGMA_IMPORT_LIMITS, importFigmaNode, serveFigmaImporter,
  validateFigmaImportRequest, validateFigmaImportResult } from "../src/figma-importer.js";
import { runPluginProcess } from "../src/plugin-communication.js";
import { getDeclaredPluginCapability } from "../src/plugin-manifest.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const request = await load("../test/fixtures/figma-importer/request.json");
const expected = await load("../test/fixtures/figma-importer/result.json");
const response = await load("../test/fixtures/figma-importer/response.json");
const manifest = await load("../test/fixtures/figma-importer/manifest.json");
const contract = await load("../../../contracts/figma-importer@0.1.schema.json");
const responseText = JSON.stringify(response);
const now = () => expected.output.retrievedAt;
const body = (text = responseText, extra = {}) => new Response(text, { headers: { "content-type": "application/json" }, ...extra });
// Non-credential sentinel. Tests never discover or load account tokens.
const settings = () => ({ permission: { apiOrigin: FIGMA_API_ORIGIN, fileKey: request.input.fileKey },
  credential: { kind: "oauth", token: "fixture" }, now, fetchImpl: async () => body() });
async function failure(input, options, code) {
  const value = await importFigmaNode(input, options); assert.equal(value.status, "failure");
  assert.equal(value.failure.code, `FIGMA_IMPORT_${code}`);
  assert.deepEqual(Object.keys(value.failure).sort(), ["code", "message"]);
  assert.equal(value.failure.message, "Figmaの読取条件または取得結果を確認できません。");
  for (const text of ["Bearer fixture", "PRIVATE_NODE", "PRIVATE_FILE", "PRIVATE_PROVIDER", "invalid.example.test"])
    assert.equal(JSON.stringify(value).includes(text), false);
  return value;
}
async function changed(mutator) {
  const value = structuredClone(response); mutator(value);
  return importFigmaNode(request, { ...settings(), fetchImpl: async () => body(JSON.stringify(value)) });
}
let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
await check("fixed request snapshot manifest and independent fractional digest", async () => {
  assert.equal(validateFigmaImportRequest(request), request);
  assert.equal(validateFigmaImportResult(expected, request), expected);
  assert.equal(getDeclaredPluginCapability(manifest, request.capability.id).effect, "read-only");
  assert.deepEqual(contract.$defs.Input.required, Object.keys(request.input));
  assert.deepEqual(contract.$defs.Snapshot.required, Object.keys(expected.output));
  assert.deepEqual(await importFigmaNode(request, settings()), expected);
});
await check("only one encoded GET and the selected credential header are used", async () => {
  for (const kind of ["oauth", "personal-access-token"]) {
    const options = settings(); options.credential.kind = kind; let calls = 0;
    options.fetchImpl = async (url, options) => {
      calls++; assert.equal(url, "https://api.figma.com/v1/files/fixtureFile/nodes?ids=1%3A2&version=1001");
      assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual"); assert.equal(options.cache, "no-store");
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(options.headers[kind === "oauth" ? "Authorization" : "X-Figma-Token"],
        kind === "oauth" ? "Bearer fixture" : "fixture");
      assert.equal(Object.keys(options.headers).length, 2); return body();
    };
    assert.deepEqual(await importFigmaNode(request, options), expected); assert.equal(calls, 1);
  }
});
await check("unread rejected responses are cancelled without replacing their failure", async () => {
  for (const mode of ["complete", "reject", "pending"]) {
    for (const [init, properties, code] of [
      [{ status: 403 }, {}, "SOURCE_UNAVAILABLE"],
      [{ status: 302 }, {}, "REDIRECT_DENIED"],
      [{}, { redirected: true }, "REDIRECT_DENIED"],
      [{}, { url: "https://invalid.example.test" }, "REDIRECT_DENIED"],
      [{ headers: { "content-type": "text/plain" } }, {}, "RESPONSE_INVALID"],
      [{ headers: { "content-type": "application/json", "content-length": "invalid" } }, {}, "RESPONSE_LIMIT"],
      [{ headers: { "content-type": "application/json", "content-length": String(FIGMA_IMPORT_LIMITS.maxResponseBytes + 1) } }, {}, "RESPONSE_LIMIT"],
    ]) {
      let cancels = 0, reads = 0, calls = 0;
      const stream = new ReadableStream({ pull() { reads++; }, cancel() {
        cancels++;
        if (mode === "reject") return Promise.reject(new Error("PRIVATE_PROVIDER"));
        if (mode === "pending") return new Promise(() => {});
      } }, { highWaterMark: 0 });
      const response = new Response(stream, { headers: { "content-type": "application/json" }, ...init });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
      await failure(request, { ...settings(), limits: { timeoutMs: 100 },
        fetchImpl: async () => { calls++; return response; },
      }, code);
      assert.equal(cancels, 1); assert.equal(reads, 0); assert.equal(calls, 1);
      assert.equal(stream.locked, false);
    }
  }
});
await check("responses arriving after timeout are cancelled before reading", async () => {
  let deliver, cancels = 0, reads = 0, calls = 0;
  const stream = new ReadableStream({ pull() { reads++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
  await failure(request, { ...settings(), limits: { timeoutMs: 10 },
    fetchImpl: () => { calls++; return new Promise(resolve => { deliver = resolve; }); },
  }, "TIMEOUT");
  deliver(new Response(stream, { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancels, 1); assert.equal(reads, 0); assert.equal(calls, 1);
  assert.equal(stream.locked, false);
});
await check("invalid requests never reach network or echo malformed Run IDs", async () => {
  for (const value of [null, undefined, [], true, new Proxy({}, {}), { ...request, runId: "2026-09-09T04:00:00+09:00" },
    { ...request, input: { ...request.input, nodeId: "1:2,3:4" } }, { ...request, input: { ...request.input, fileKey: "../private" } },
    { ...request, input: { ...request.input, version: "" } }, { ...request, extra: true }]) {
    assert.throws(() => validateFigmaImportRequest(value), { code: "FIGMA_IMPORT_REQUEST_INVALID" });
    const result = await failure(value, { ...settings(), fetchImpl: () => { throw Error("network-called"); } }, "REQUEST_INVALID");
    assert.equal(result.runId, "invalid-run");
  }
  let reads = 0; const value = structuredClone(request);
  Object.defineProperty(value, "runId", { enumerable: true, get() { reads++; throw Error("PRIVATE_PROVIDER"); } });
  await failure(value, settings(), "REQUEST_INVALID"); assert.equal(reads, 0);
});
await check("file permission credential and options are checked before network", async () => {
  await failure(request, undefined, "PERMISSION_DENIED");
  for (const permission of [undefined, null, { apiOrigin: "https://invalid.example.test", fileKey: request.input.fileKey },
    { apiOrigin: FIGMA_API_ORIGIN, fileKey: "different" }, { ...settings().permission, extra: true }])
    await failure(request, { ...settings(), permission }, "PERMISSION_DENIED");
  for (const credential of [undefined, null, { kind: "bad", token: "x" }, { kind: "oauth", token: "" },
    { kind: "oauth", token: "bad\nheader" }, { kind: "oauth", token: "x".repeat(8193) }, { ...settings().credential, extra: true }])
    await failure(request, { ...settings(), credential }, "CREDENTIAL_INVALID");
  await failure(request, { ...settings(), fetchImpl: 1 }, "OPTIONS_INVALID");
  await failure(request, { ...settings(), now: 1 }, "OPTIONS_INVALID");
  await failure(request, { ...settings(), now: () => "PRIVATE_PROVIDER" }, "RESULT_INVALID");
});
await check("limits may only be lowered and cannot disable bounds", async () => {
  for (const limits of [null, [], { extra: 1 }, { timeoutMs: 0 }, { maxDepth: 65 }, { maxResponseBytes: 2097153 }, { timeoutMs: 1.5 }])
    await failure(request, { ...settings(), limits }, "LIMITS_INVALID");
  assert.equal(Object.isFrozen(FIGMA_IMPORT_LIMITS), true);
  assert.deepEqual(await importFigmaNode(request, { ...settings(), limits: { timeoutMs: 5000, maxResponseBytes: 4096, maxDepth: 16 } }), expected);
});
await check("result shape and request identity are independently checked", () => {
  for (const mutate of [x => { x.plugin.id = "other"; }, x => { x.output.extra = true; }, x => { x.output.node.id = "3:4"; },
    x => { x.output.digest = "bad"; }, x => { x.output.source.apiOrigin = "https://invalid.example.test"; },
    x => { x.output.informationLoss = []; }, x => { x.output.retrievedAt = "2026-02-30T00:00:00Z"; }]) {
    const value = structuredClone(expected); mutate(value);
    assert.throws(() => validateFigmaImportResult(value), { code: "FIGMA_IMPORT_RESULT_INVALID" });
  }
  const other = structuredClone(request); other.input.version = "1002";
  assert.throws(() => validateFigmaImportResult(expected, other), { code: "FIGMA_IMPORT_RESULT_MISMATCH" });
  const failed = { ...expected, status: "failure", failure: { code: "FIGMA_IMPORT_SOURCE_UNAVAILABLE", message: "fixed" } }; delete failed.output;
  assert.equal(validateFigmaImportResult(failed, request), failed);
});
await check("response version and Node ID must match before reporting success", async () => {
  for (const mutate of [x => { x.version = "1002"; }, x => { x.nodes["1:2"].document.id = "3:4"; }]) {
    const value = structuredClone(response); mutate(value);
    await failure(request, { ...settings(), fetchImpl: async () => body(JSON.stringify(value)) }, "IDENTITY_MISMATCH");
  }
});
await check("only an explicit null node means missing", async () => {
  const missing = structuredClone(response); missing.nodes["1:2"] = null;
  await failure(request, { ...settings(), fetchImpl: async () => body(JSON.stringify(missing)) }, "TARGET_MISSING");
  for (const mutate of [x => { delete x.nodes["1:2"]; }, x => { x.nodes = []; }, x => { x.nodes["1:2"] = {}; },
    x => { x.nodes["1:2"].document = null; }, x => { x.nodes["1:2"].document.type = "bad"; }, x => { x.err = "PRIVATE_PROVIDER"; }]) {
    const value = structuredClone(response); mutate(value);
    await failure(request, { ...settings(), fetchImpl: async () => body(JSON.stringify(value)) }, "RESPONSE_INVALID");
  }
});
await check("whole Node content changes digest but file metadata and map order do not", async () => {
  const same = await changed(x => { x.name = "different"; x.thumbnailUrl = "https://invalid.example.test/other"; x.lastModified = "2026-09-09T00:00:00Z";
    x.nodes["1:2"].document = Object.fromEntries(Object.entries(x.nodes["1:2"].document).reverse()); });
  assert.equal(same.output.digest, expected.output.digest);
  for (const mutate of [x => { x.nodes["1:2"].document.absoluteBoundingBox.x = 0.25001; },
    x => { x.nodes["1:2"].document.children[0].characters = "changed"; }]) {
    const value = await changed(mutate); assert.equal(value.status, "success"); assert.notEqual(value.output.digest, expected.output.digest);
  }
});
await check("external digest preserves strings and array order with defined number normalization", async () => {
  const digest = async extra => (await changed(x => { x.nodes["1:2"].document.extra = extra; })).output.digest;
  assert.notEqual(await digest("é"), await digest("e\u0301"));
  assert.notEqual(await digest("2026-09-08T19:00:00Z"), await digest("2026-09-09T04:00:00+09:00"));
  assert.notEqual(await digest([1, 2]), await digest([2, 1]));
  assert.equal(await digest(-0), await digest(0));
  assert.equal(typeof await digest({ "😀": true, "\ue000": null }), "string");
  const value = await importFigmaNode(request, { ...settings(), fetchImpl: async () => body(responseText.replace("0.25", "0.2500")) });
  assert.equal(value.output.digest, expected.output.digest);
});
await check("unsafe numbers surrogate strings and excessive depth are rejected", async () => {
  for (const raw of [responseText.replace("0.25", "9007199254740992"), responseText.replace("0.25", "1e400"),
    responseText.replace("PRIVATE_NODE_TEXT", "\\ud800")])
    await failure(request, { ...settings(), fetchImpl: async () => body(raw) }, "RESPONSE_INVALID");
  const malformed = structuredClone(response); malformed.nodes["1:2"].document["\ud800"] = true;
  await failure(request, { ...settings(), fetchImpl: async () => body(JSON.stringify(malformed)) }, "RESPONSE_INVALID");
  await failure(request, { ...settings(), limits: { maxDepth: 3 } }, "RESPONSE_DEPTH");
});
await check("invalid JSON duplicate keys UTF-8 and content types never leak raw data", async () => {
  for (const raw of ["{PRIVATE_PROVIDER", "[]", responseText.replace('"version":"1001"', '"version":"1001","version":"1001"')])
    await failure(request, { ...settings(), fetchImpl: async () => body(raw) }, "RESPONSE_INVALID");
  await failure(request, { ...settings(), fetchImpl: async () => body(new Uint8Array([0xff])) }, "RESPONSE_INVALID");
  await failure(request, { ...settings(), fetchImpl: async () => body(responseText, { headers: { "content-type": "text/html" } }) }, "RESPONSE_INVALID");
  await failure(request, { ...settings(), fetchImpl: async () => body(null) }, "RESPONSE_INVALID");
});
await check("declared and streamed sizes are bounded and readers are cancelled", async () => {
  for (const length of ["bad", "999999999999999999999", "2097153"])
    await failure(request, { ...settings(), fetchImpl: async () => body(responseText, { headers: { "content-type": "application/json", "content-length": length } }) }, "RESPONSE_LIMIT");
  let cancelled = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled++; } });
  await failure(request, { ...settings(), limits: { maxResponseBytes: 1024 }, fetchImpl: async () => body(stream) }, "RESPONSE_LIMIT");
  assert.equal(cancelled, 1);
  const invalid = new ReadableStream({ start(controller) { controller.enqueue("invalid chunk"); }, cancel() {} });
  await failure(request, { ...settings(), fetchImpl: async () => body(invalid) }, "RESPONSE_INVALID");
  const failedCancel = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { throw Error("PRIVATE_PROVIDER"); } });
  await failure(request, { ...settings(), limits: { maxResponseBytes: 1024 }, fetchImpl: async () => body(failedCancel) }, "RESPONSE_LIMIT");
  const large = structuredClone(response); large.nodes["1:2"].document.values = Array(1000).fill(0.000001);
  const raw = JSON.stringify(large).replaceAll("0.000001", "1e-6");
  await failure(request, { ...settings(), limits: { maxResponseBytes: Buffer.byteLength(raw) }, fetchImpl: async () => body(raw) }, "RESPONSE_LIMIT");
  const bytes = Buffer.from(responseText); const reused = Buffer.alloc(64); let offset = 0;
  const reader = { async read() {
    reused.fill(0);
    if (offset === bytes.length) return { done: true };
    const length = Math.min(reused.length, bytes.length - offset); bytes.copy(reused, 0, offset, offset + length); offset += length;
    return { done: false, value: reused.subarray(0, length) };
  }, cancel: async () => {}, releaseLock() {} };
  assert.deepEqual(await importFigmaNode(request, { ...settings(), fetchImpl: async () => ({ status: 200,
    headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => reader } }) }), expected);
});
await check("redirects wrong response URLs and HTTP errors are not Node disappearance", async () => {
  assert.deepEqual(await importFigmaNode(request, { ...settings(), fetchImpl: async url => {
    const value = body(); Object.defineProperty(value, "url", { value: url }); return value;
  } }), expected);
  for (const mutate of [x => { Object.defineProperty(x, "redirected", { value: true }); },
    x => { Object.defineProperty(x, "url", { value: "https://invalid.example.test" }); }]) {
    const value = body(); mutate(value); await failure(request, { ...settings(), fetchImpl: async () => value }, "REDIRECT_DENIED");
  }
  await failure(request, { ...settings(), fetchImpl: async () => body(null, { status: 302 }) }, "REDIRECT_DENIED");
  for (const status of [400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    await failure(request, { ...settings(), fetchImpl: async () => { calls++; return body("PRIVATE_PROVIDER", { status }); } }, "SOURCE_UNAVAILABLE");
    assert.equal(calls, 1);
  }
});
await check("provider errors and malformed options use fixed diagnostics", async () => {
  await failure(request, { ...settings(), fetchImpl: async () => { throw Error("PRIVATE_PROVIDER Bearer fixture"); } }, "FAILED");
  await failure(request, null, "FAILED");
  await failure(request, { ...settings(), fetchImpl: async () => null }, "REDIRECT_DENIED");
});
await check("stalled fetch and stalled body meet the deadline and abort", async () => {
  let aborted = 0;
  await failure(request, { ...settings(), limits: { timeoutMs: 20 }, fetchImpl: async (_url, options) => {
    options.signal.addEventListener("abort", () => { aborted++; }); return new Promise(() => {});
  } }, "TIMEOUT");
  assert.equal(aborted, 1);
  let cancelled = 0;
  const stream = new ReadableStream({ cancel() { cancelled++; } });
  await failure(request, { ...settings(), limits: { timeoutMs: 20 }, fetchImpl: async () => body(stream) }, "TIMEOUT");
  assert.equal(cancelled, 1);
});
await check("asynchronous caller changes cannot change the authorized request", async () => {
  const input = structuredClone(request); const options = settings(); let release; let header;
  options.fetchImpl = async (_url, settings) => { header = settings.headers.Authorization; return new Promise(resolve => { release = resolve; }); };
  const pending = importFigmaNode(input, options); input.input.fileKey = "other"; input.runId = "other";
  options.permission.fileKey = "other"; options.credential.token = "other"; release(body());
  assert.deepEqual(await pending, expected); assert.equal(header, "Bearer fixture");
});
await check("default fetch and clock can be exercised without service access", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => body(); const options = settings(); delete options.fetchImpl; delete options.now;
    const value = await importFigmaNode(request, options); assert.equal(value.status, "success"); validateFigmaImportResult(value, request);
  } finally { globalThis.fetch = original; }
});
await check("stdio SDK keeps credentials outside the communication request", async () => {
  const chunks = [];
  const result = await serveFigmaImporter(settings(), { stdin: Readable.from([JSON.stringify(request) + "\n"]),
    stdout: new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }),
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) });
  assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(Buffer.concat(chunks)), expected);
});
await check("real process fixture has no external service dependency and retains only metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "morivyx-figma-process-"));
  try {
    await cp(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
    await cp(new URL("../package.json", import.meta.url), join(root, "package.json"));
    await mkdir(join(root, "node_modules"));
    await cp(new URL("../node_modules/yaml", import.meta.url), join(root, "node_modules/yaml"), { recursive: true });
    const source = `import{serveFigmaImporter}from ${JSON.stringify(pathToFileURL(join(root, "src/figma-importer.js")).href)};
const options=${JSON.stringify({ permission: settings().permission, credential: settings().credential })};
options.now=()=>${JSON.stringify(now())};options.fetchImpl=async()=>new Response(${JSON.stringify(responseText)},{headers:{'content-type':'application/json'}});
const result=await serveFigmaImporter(options);process.exitCode=result.exitCode;`;
    const capability = manifest.capabilities[0];
    const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { id: manifest.identity.id, version: manifest.identity.version, packageDigest: manifest.identity.packageDigest },
      capability: { id: capability.id, effect: capability.effect, permissions: capability.permissions, resources: capability.resources } };
    const result = runPluginProcess({ command: process.execPath, args: ["--input-type=module", "--eval", source], manifest, policy, request });
    assert.deepEqual(result, expected);
    for (const text of [root, "PRIVATE_NODE", "PRIVATE_FILE", "Bearer fixture", "invalid.example.test", "absoluteBoundingBox"])
      assert.equal(canonicalJson(result).includes(text), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
assert.equal(checks, 22);
console.log(`Figma importer audit passed: ${checks} checks; bounded fixed-version Node reads and real-process fixture verified.`);
