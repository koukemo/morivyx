import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical.js";
import { importOpenApiOperation, validateOpenApiImportRequest, validateOpenApiImportResult,
  OPENAPI_IMPORT_LIMITS } from "../src/openapi-importer.js";
import { runPluginProcess } from "../src/plugin-communication.js";
import { validatePluginManifest } from "../src/plugin-manifest.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const request = await load("../test/fixtures/openapi-importer/request.json");
const expected = await load("../test/fixtures/openapi-importer/result.json");
const manifest = await load("../test/fixtures/openapi-importer/manifest.json");
const contract = await load("../../../contracts/openapi-operation@0.1.schema.json");
const sourcePath = new URL("../test/fixtures/openapi-importer/document.json", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const now = () => expected.output.retrievedAt;
const fresh = () => structuredClone(request);
function changedDocument(mutate) {
  const value = fresh(); const document = JSON.parse(source); mutate(document);
  value.input.documentText = JSON.stringify(document); return value;
}
function failed(value, code) {
  const result = importOpenApiOperation(value, { now });
  assert.equal(result.status, "failure"); assert.equal(result.failure.code, `OPENAPI_IMPORT_${code}`);
  for (const secret of ["PRIVATE_SOURCE_DESCRIPTION", "PRIVATE_HEADER_NAME", "invalid.example.test", "INPUT_SENTINEL"]) {
    assert.equal(JSON.stringify(result.failure).includes(secret), false);
  }
  return result;
}
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
await check("fixed contract manifest request and snapshot", () => {
  assert.equal(request.input.documentText, source);
  assert.equal(validateOpenApiImportRequest(request), request);
  validatePluginManifest(manifest);
  assert.deepEqual(contract.$defs.Input.required, Object.keys(request.input));
  assert.deepEqual(new Set(contract.$defs.Snapshot.required), new Set(Object.keys(expected.output)));
  assert.deepEqual(contract.$defs.Snapshot.properties.informationLoss.const, expected.output.informationLoss);
  assert.deepEqual(importOpenApiOperation(request, { now }), expected);
  assert.equal(validateOpenApiImportResult(expected, request), expected);
  assert.equal(validateOpenApiImportResult(expected), expected);
  assert.equal(expected.output.digest, `sha256:${createHash("sha256").update(source).digest("hex")}`);
});
await check("every 3.1 patch and fixed HTTP method use the same selection", () => {
  for (const version of ["3.1.0", "3.1.1", "3.1.2", "3.1.999"]) {
    const input = changedDocument(value => { value.openapi = version; });
    assert.equal(importOpenApiOperation(input, { now }).output.openapiVersion, version);
  }
  for (const method of contract.$defs.method.enum) {
    const input = changedDocument(value => { value.paths[request.input.path][method] = value.paths[request.input.path].get; });
    input.input.method = method;
    const result = importOpenApiOperation(input, { now }); assert.equal(result.output.operation.method, method);
    validateOpenApiImportResult(result, input);
  }
});
await check("JSON Pointer escapes and opaque identifiers remain stable", () => {
  const input = changedDocument(value => { value.paths["/a~/b"] = value.paths[request.input.path]; }); input.input.path = "/a~/b";
  assert.equal(importOpenApiOperation(input, { now }).output.locator, "/paths/~1a~0~1b/get");
  for (const key of ["externalId", "path"]) {
    const value = fresh(); value.input[key] = key === "path" ? "/e\u0301" : "openapi:e\u0301"; failed(value, "REQUEST_INVALID");
  }
  for (const value of ["e\u0301", "2026-09-08T10:00:00+09:00", "\ud800", "bad\nvalue", "x".repeat(513)]) {
    failed(changedDocument(document => { document.paths[request.input.path].get.operationId = value; }), "DOCUMENT_INVALID");
  }
  const lower = changedDocument(value => { value.paths[request.input.path].get.operationId = "readwidget"; });
  assert.equal(importOpenApiOperation(lower, { now }).output.operation.operationId, "readwidget");
});
await check("strict request shape effect identity and sizes", () => {
  for (const value of [null, undefined, [], "INPUT_SENTINEL", true, new Proxy({}, {})]) failed(value, "REQUEST_INVALID");
  for (const mutate of [x => { x.plugin.id = "other"; }, x => { x.plugin.version = "9"; }, x => { x.capability.id = "other"; },
    x => { x.capability.effect = "read-only"; }, x => { x.input.extra = true; }, x => { x.input.documentText = 1; },
    x => { x.input.documentText = ""; }, x => { x.input.externalId = ""; }, x => { x.input.method = "GET"; },
    x => { x.input.path = "relative"; }, x => { x.runId = "x".repeat(257); }]) { const value = fresh(); mutate(value); failed(value, "REQUEST_INVALID"); }
  let reads = 0; const value = fresh(); Object.defineProperty(value, "input", { enumerable: true, get() { reads++; throw Error(); } });
  failed(value, "REQUEST_INVALID"); assert.equal(reads, 0);
  const cyclic = fresh(); cyclic.self = cyclic; failed(cyclic, "REQUEST_INVALID");
});
await check("raw document and envelope limits are measured in bytes", () => {
  const value = fresh(); value.input.documentText = source.padEnd(OPENAPI_IMPORT_LIMITS.maxDocumentBytes, " ");
  assert.equal(importOpenApiOperation(value, { now }).status, "success");
  value.input.documentText += " "; failed(value, "INPUT_LIMIT");
  value.input.documentText = "日".repeat(Math.floor(OPENAPI_IMPORT_LIMITS.maxDocumentBytes / 3) + 1); failed(value, "INPUT_LIMIT");
  value.input.documentText = "\\".repeat(OPENAPI_IMPORT_LIMITS.maxDocumentBytes); failed(value, "INPUT_LIMIT");
});
await check("JSON syntax and duplicate names cannot be silently selected", () => {
  for (const raw of ["{INPUT_SENTINEL}", "{} {}", "---\nopenapi: 3.1.2", "\ufeff{}",
    source.replace('"openapi":"3.1.2"', '"openapi":"3.1.0","openapi":"3.1.2"'),
    source.replace('"operationId":"readWidget"', '"operationId":"first","operationId":"second"'),
    source.replace('"operationId":"readWidget"', '"operationId":"first","\\u006fperationId":"second"')]) {
    const value = fresh(); value.input.documentText = raw; failed(value, "DOCUMENT_INVALID");
  }
});
await check("document depth is bounded before the duplicate-key parser", () => {
  function nested(depth) { const root = {}; let next = root; for (let index = 1; index < depth; index++) { next.child = {}; next = next.child; } return root; }
  const exact = changedDocument(value => { value["x-depth"] = nested(63); });
  assert.equal(importOpenApiOperation(exact, { now }).status, "success");
  failed(changedDocument(value => { value["x-depth"] = nested(64); }), "DOCUMENT_DEPTH");
  const array = changedDocument(value => { value["x-depth"] = [[[[null]]]]; });
  assert.equal(importOpenApiOperation(array, { now }).status, "success");
});
await check("unsupported versions and malformed selected structures are not missing", () => {
  for (const version of ["3.0.3", "3.2.0", "3.1.0-rc1", 3.1, null]) failed(changedDocument(value => { value.openapi = version; }), "VERSION_UNSUPPORTED");
  for (const raw of ["null", "[]", "3"]) { const value = fresh(); value.input.documentText = raw; failed(value, "VERSION_UNSUPPORTED"); }
  for (const mutate of [x => { delete x.info; }, x => { x.info.title = 1; }, x => { x.info.version = null; },
    x => { x.paths = []; }, x => { x.paths[request.input.path] = null; }, x => { x.paths[request.input.path].get = []; },
    x => { x.paths[request.input.path].get.operationId = 1; }]) failed(changedDocument(mutate), "DOCUMENT_INVALID");
});
await check("missing operation is distinct from unresolved path references", () => {
  for (const mutate of [x => { delete x.paths; }, x => { delete x.paths[request.input.path]; }, x => { delete x.paths[request.input.path].get; }]) {
    const value = changedDocument(mutate); const result = failed(value, "TARGET_MISSING");
    assert.equal(validateOpenApiImportResult(result, value), result);
  }
  for (const reference of ["#/components/pathItems/fixture", "https://invalid.example.test/paths.json", ""]) {
    failed(changedDocument(value => { value.paths[request.input.path].$ref = reference; }), "REFERENCE_UNSUPPORTED");
    failed(changedDocument(value => { value.paths[request.input.path].get.$ref = reference; }), "REFERENCE_UNSUPPORTED");
  }
});
await check("unretained fields and arbitrary precision numbers never become interpreted data", () => {
  const value = fresh(); value.input.documentText = source.replace('"description":"PRIVATE_SOURCE_DESCRIPTION"',
    '"description":"PRIVATE_SOURCE_DESCRIPTION","x-large":9007199254740993,"x-overflow":1e1000,"x-time":"2026-09-08T18:00:00.123456789Z"');
  const output = importOpenApiOperation(value, { now }).output;
  assert.equal(output.digest, `sha256:${createHash("sha256").update(value.input.documentText).digest("hex")}`);
  assert.deepEqual(output.operation, expected.output.operation);
  for (const text of ["PRIVATE_SOURCE_DESCRIPTION", "PRIVATE_HEADER_NAME", "invalid.example.test", "9007199254740993", "1e1000", "123456789"]) {
    assert.equal(JSON.stringify(output).includes(text), false);
  }
  const withoutId = changedDocument(document => { delete document.paths[request.input.path].get.operationId; });
  const result = importOpenApiOperation(withoutId, { now }); assert.deepEqual(result.output.operation, { path: request.input.path, method: "get" });
  validateOpenApiImportResult(result, withoutId);
});
await check("whole document bytes rather than a selected operation determine the digest", () => {
  const value = fresh(); value.input.documentText += " "; const result = importOpenApiOperation(value, { now });
  assert.notEqual(result.output.digest, expected.output.digest); assert.deepEqual(result.output.operation, expected.output.operation);
  const other = changedDocument(document => { document.paths["/other"] = { post: {} }; });
  assert.notEqual(importOpenApiOperation(other, { now }).output.digest, expected.output.digest);
});
await check("result validation binds identity selection digest and metadata", () => {
  for (const mutate of [x => { x.runId = "other"; }, x => { x.plugin.id = "other"; }, x => { x.capabilityId = "other"; },
    x => { x.output.extra = true; }, x => { x.output.externalIdentity.extra = true; }, x => { x.output.openapiVersion = "3.2.0"; },
    x => { x.output.operation.method = "GET"; }, x => { x.output.operation.path = "relative"; },
    x => { x.output.operation = null; }, x => { x.output.operation.operationId = 1; }, x => { x.output.locator = "/other"; },
    x => { x.output.digest = "bad"; }, x => { x.output.digestRule = "other"; }, x => { x.output.retrievedAt = "bad"; },
    x => { x.output.retrievedAt = "2026-02-30T00:00:00Z"; }, x => { x.output.informationLoss = []; }]) {
    const value = structuredClone(expected); mutate(value);
    assert.throws(() => validateOpenApiImportResult(value, request), { code: "OPENAPI_IMPORT_RESULT_INVALID" });
  }
  for (const mutate of [x => { x.output.externalIdentity.externalId = "other"; }, x => { x.output.digest = `sha256:${"2".repeat(64)}`; },
    x => { x.output.operation.operationId = "other"; }]) {
    const value = structuredClone(expected); mutate(value);
    assert.throws(() => validateOpenApiImportResult(value, request), { code: "OPENAPI_IMPORT_RESULT_MISMATCH" });
  }
  const invalidInput = fresh(); invalidInput.input.documentText = "{}";
  assert.throws(() => validateOpenApiImportResult(expected, invalidInput), { code: "OPENAPI_IMPORT_RESULT_INVALID" });
});
await check("clock failure and arbitrary precision timestamps have bounded outcomes", () => {
  for (const value of ["2026-09-08T18:00:00.123456789Z", "2026-09-09T03:00:00+09:00"]) {
    const result = importOpenApiOperation(request, { now: () => value }); assert.equal(result.output.retrievedAt, value);
  }
  for (const value of [null, 1, "bad"]) assert.equal(importOpenApiOperation(request, { now: () => value }).failure.code, "OPENAPI_IMPORT_CLOCK_INVALID");
  assert.equal(importOpenApiOperation(request, { now: null }).failure.code, "OPENAPI_IMPORT_CLOCK_INVALID");
  assert.equal(importOpenApiOperation(request, { now() { throw Error("INPUT_SENTINEL"); } }).failure.code, "OPENAPI_IMPORT_FAILED");
  assert.equal(importOpenApiOperation(request, null).failure.code, "OPENAPI_IMPORT_FAILED");
  assert.equal(importOpenApiOperation(request).status, "success");
});
await check("inputs and outputs are detached and no reference is fetched", async () => {
  const value = fresh(); const original = canonicalJson(value); const priorFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = () => { fetched++; throw Error("No network"); };
  try {
    const first = importOpenApiOperation(value, { now }); assert.equal(canonicalJson(value), original);
    first.output.informationLoss.length = 0; first.output.operation.path = "changed";
    assert.deepEqual(importOpenApiOperation(value, { now }), expected);
    const second = importOpenApiOperation(value, { now() { value.input.path = "/changed"; return now(); } });
    assert.deepEqual(second, expected); assert.equal(fetched, 0);
    assert.equal(await readFile(sourcePath, "utf8"), source);
  } finally { globalThis.fetch = priorFetch; }
});
await check("real stdio process and explicit pure host policy", () => {
  const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { ...manifest.identity },
    capability: { id: manifest.capabilities[0].id, effect: "pure", permissions: manifest.capabilities[0].permissions, resources: manifest.capabilities[0].resources } };
  delete policy.plugin.distributor;
  const script = fileURLToPath(new URL("../src/openapi-importer-stdio.js", import.meta.url));
  const result = runPluginProcess({ command: process.execPath, args: [script], manifest, request, policy });
  validateOpenApiImportResult(result, request); assert.deepEqual(result.output.operation, expected.output.operation);
  const missing = changedDocument(value => { delete value.paths[request.input.path].get; });
  const lost = runPluginProcess({ command: process.execPath, args: [script], manifest, request: missing, policy });
  assert.equal(lost.failure.code, "OPENAPI_IMPORT_TARGET_MISSING");
  const requestingNetwork = structuredClone(manifest); requestingNetwork.capabilities[0].permissions.network = ["https://invalid.example.test"];
  assert.throws(() => runPluginProcess({ command: process.execPath, args: [script], manifest: requestingNetwork, request, policy }));
  const malformed = spawnSync(process.execPath, [script], { input: "{INPUT_SENTINEL}", encoding: "utf8", timeout: 5000, env: {} });
  assert.equal(malformed.status, 2); assert.equal(malformed.stdout, ""); assert.equal(malformed.stderr, "PLUGIN_STDIO_INPUT_INVALID\n");
});
assert.equal(checks, 15);
console.log(`OpenAPI importer audit passed: ${checks} checks; pure operation selection, source digest and explicit information loss verified.`);
