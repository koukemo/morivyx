import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePluginRunResult } from "../packages/kernel/src/plugin-communication.js";
import { importGitHubFile, validateGitHubImportRequest, validateGitHubImportResult } from "../packages/kernel/src/github-importer.js";
import { importOpenApiOperation, validateOpenApiImportRequest, validateOpenApiImportResult } from "../packages/kernel/src/openapi-importer.js";
import { importFigmaNode, validateFigmaImportRequest, validateFigmaImportResult } from "../packages/kernel/src/figma-importer.js";

const adapters = [
  { name: "github", prefix: "GITHUB", run: importGitHubFile, validateRequest: validateGitHubImportRequest,
    validateResult: validateGitHubImportResult, message: "GitHubの読取条件または取得結果を確認できませんでした。" },
  { name: "openapi", prefix: "OPENAPI", run: importOpenApiOperation, validateRequest: validateOpenApiImportRequest,
    validateResult: validateOpenApiImportResult, message: "OpenAPIの取込条件または結果を確認できません。" },
  { name: "figma", prefix: "FIGMA", run: importFigmaNode, validateRequest: validateFigmaImportRequest,
    validateResult: validateFigmaImportResult, message: "Figmaの読取条件または取得結果を確認できません。" },
];
for (const adapter of adapters) adapter.request = JSON.parse(await readFile(new URL(
  `../packages/kernel/test/fixtures/${adapter.name}-importer/request.json`, import.meta.url), "utf8"));
function options(adapter, error, count = () => {}) {
  const fail = () => { count(); throw error; };
  if (adapter.name === "openapi") return { now: fail };
  if (adapter.name === "github") return { permission: { apiOrigin: "https://api.github.com", owner: adapter.request.input.owner,
    repository: adapter.request.input.repository, repositoryId: adapter.request.input.repositoryId }, fetchImpl: fail };
  return { permission: { apiOrigin: "https://api.figma.com", fileKey: adapter.request.input.fileKey },
    credential: { kind: "personal-access-token", token: "owned-synthetic-fixture" }, fetchImpl: fail };
}
function validFailure(adapter, result, code, runId) {
  assert.equal(result.status, "failure"); assert.equal(result.runId, runId);
  assert.deepEqual(result.failure, { code, message: adapter.message });
  assert.equal(validatePluginRunResult(result), result);
}
function domainError(adapter) {
  try { adapter.validateRequest({}); } catch (error) { return error; }
  throw new Error("missing domain failure");
}

test("all three request entries reject root and revoked proxies without traps or adapter calls", async () => {
  for (const adapter of adapters) {
    let traps = 0, calls = 0;
    const trap = () => { traps++; throw new Error("OWNED_SENTINEL"); };
    const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, ownKeys: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const accessor = { get runId() { return trap(); } };
    for (const request of [proxy, revoked.proxy, accessor]) {
      const result = await adapter.run(request, options(adapter, new Error("OWNED_SENTINEL"), () => calls++));
      validFailure(adapter, result, `${adapter.prefix}_IMPORT_REQUEST_INVALID`, "invalid-run");
    }
    assert.equal(traps, 0, adapter.name); assert.equal(calls, 0, adapter.name);
  }
});

test("GitHub failure identifiers are valid own data and retain raw Unicode without normalization", async () => {
  const adapter = adapters[0];
  for (const runId of ["e\u0301", "é", "😀", " ", "2026-09-05T01:00:00.000+00:00"]) {
    validFailure(adapter, await adapter.run({ runId }), "GITHUB_IMPORT_REQUEST_INVALID", runId);
  }
  for (const runId of ["", "\ud800", "\udfff", "2026-02-30T00:00:00Z", {}, 1]) {
    validFailure(adapter, await adapter.run({ runId }), "GITHUB_IMPORT_REQUEST_INVALID", "invalid-run");
  }
  const hidden = {}; Object.defineProperty(hidden, "runId", { value: "hidden" });
  for (const value of [hidden, Object.create({ runId: "inherited" }), null, [], 1]) {
    validFailure(adapter, await adapter.run(value), "GITHUB_IMPORT_REQUEST_INVALID", "invalid-run");
  }
  // The other adapters intentionally retain an ID only after full request validation.
  for (const adapter of adapters.slice(1)) {
    validFailure(adapter, await adapter.run({ runId: "own:rejected" }), `${adapter.prefix}_IMPORT_REQUEST_INVALID`, "invalid-run");
  }
});

test("thrown proxies, revoked errors and proxy prototypes become fixed failures without inspection", async () => {
  for (const adapter of adapters) {
    let traps = 0, calls = 0;
    const trap = () => { traps++; throw new Error("OWNED_SENTINEL"); };
    const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const values = [proxy, revoked.proxy, Object.create(new Proxy({}, { getPrototypeOf: trap })), new Error("OWNED_SENTINEL"), null];
    for (const error of values) {
      const request = structuredClone(adapter.request);
      const result = await adapter.run(request, options(adapter, error, () => calls++));
      validFailure(adapter, result, `${adapter.prefix}_IMPORT_FAILED`, request.runId);
      assert.equal(adapter.validateResult(result, request), result);
    }
    assert.equal(traps, 0, adapter.name); assert.equal(calls, values.length, adapter.name);
  }
});

test("real domain data and subclasses survive while getter, inherited and malformed codes are refused", async () => {
  for (const adapter of adapters) {
    let reads = 0;
    const original = domainError(adapter), ErrorType = original.constructor;
    class Derived extends ErrorType {}
    const derived = new Derived(adapter.name === "github" ? "GITHUB_IMPORT_OWNED" : "OWNED");
    const getter = domainError(adapter);
    Object.defineProperty(getter, "code", { get() { reads++; throw new Error("OWNED_SENTINEL"); } });
    const inherited = Object.create(domainError(adapter));
    const messageGetter = domainError(adapter), messageCode = messageGetter.code;
    Object.defineProperty(messageGetter, "message", { get() { reads++; throw new Error("OWNED_SENTINEL"); } });
    const entries = [[original, original.code], [derived, derived.code], [messageGetter, messageCode],
      [getter, `${adapter.prefix}_IMPORT_FAILED`], [inherited, `${adapter.prefix}_IMPORT_FAILED`]];
    for (const value of ["", "\ud800", "2026-02-30T00:00:00Z", {}]) {
      const error = domainError(adapter); error.code = value; entries.push([error, `${adapter.prefix}_IMPORT_FAILED`]);
    }
    for (const [error, code] of entries) {
      const result = await adapter.run(structuredClone(adapter.request), options(adapter, error));
      validFailure(adapter, result, code, adapter.request.runId);
    }
    assert.equal(reads, 0, adapter.name);
  }
});

test("validator catch paths do not inspect a proxy exception raised by a nested adapter", () => {
  for (const adapter of adapters) {
    let inspected = 0, nestedReads = 0;
    const error = new Proxy({}, { getPrototypeOf() { inspected++; throw new Error("OWNED_SENTINEL"); } });
    const request = structuredClone(adapter.request);
    request.plugin = new Proxy(request.plugin, { get(target, key) {
      if (key === "id") { nestedReads++; throw error; } return Reflect.get(target, key);
    } });
    assert.throws(() => adapter.validateRequest(request), value => value.code === `${adapter.prefix}_IMPORT_REQUEST_INVALID`);
    const result = { format: "morivyx.plugin-run-result/0.1", runId: adapter.request.runId, plugin: request.plugin,
      capabilityId: adapter.request.capability.id, status: "failure", failure: { code: "OWNED", message: "owned" } };
    assert.throws(() => adapter.validateResult(result), value => value.code === `${adapter.prefix}_IMPORT_RESULT_INVALID`);
    assert.ok(nestedReads > 0); assert.equal(inspected, 0, adapter.name);
  }
});

test("ordinary permission and clock failures and pure OpenAPI success keep their existing contracts", async () => {
  let calls = 0;
  for (const adapter of [adapters[0], adapters[2]]) {
    const result = await adapter.run(structuredClone(adapter.request), { fetchImpl() { calls++; throw new Error("unreachable"); } });
    validFailure(adapter, result, `${adapter.prefix}_IMPORT_PERMISSION_DENIED`, adapter.request.runId);
  }
  assert.equal(calls, 0);
  const adapter = adapters[1], request = structuredClone(adapter.request);
  const failed = adapter.run(request, { now: null });
  validFailure(adapter, failed, "OPENAPI_IMPORT_CLOCK_INVALID", request.runId);
  const result = adapter.run(request, { now: () => "2026-09-05T01:00:00Z" });
  assert.equal(adapter.validateResult(result, request), result);
  assert.equal(result.status, "success");
  assert.equal(result.output.digest, `sha256:${createHash("sha256").update(request.input.documentText, "utf8").digest("hex")}`);
});
