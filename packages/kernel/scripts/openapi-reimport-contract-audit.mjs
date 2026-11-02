import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../src/canonical.js";
import { importOpenApiOperation } from "../src/openapi-importer.js";
import { compareOpenApiImportSnapshots } from "../src/openapi-reimport.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const request = await load("../test/fixtures/openapi-importer/request.json");
const result = await load("../test/fixtures/openapi-importer/result.json");
const expected = await load("../test/fixtures/openapi-importer/comparison-current.json");
const contract = await load("../../../contracts/openapi-reimport@0.1.schema.json");
const now = () => result.output.retrievedAt;
const input = () => ({ previousResult: structuredClone(result), currentRequest: structuredClone(request), currentResult: structuredClone(result) });
function issue(value, code) { const r = compareOpenApiImportSnapshots(value); assert.equal(r.status, "invalid"); assert.deepEqual(r.issues, [{ code: `OPENAPI_REIMPORT_${code}` }]); return r; }
function changed(mutator) {
  const value = input(); const document = JSON.parse(value.currentRequest.input.documentText); mutator(document, value.currentRequest);
  value.currentRequest.input.documentText = JSON.stringify(document);
  value.currentRequest.runId = "run:changed"; value.currentResult = importOpenApiOperation(value.currentRequest, { now }); return value;
}
let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
await check("fixed current comparison and public contract", () => {
  assert.deepEqual(compareOpenApiImportSnapshots(input()), expected);
  assert.deepEqual(contract.required, Object.keys(expected));
});
await check("stale means a whole-document change without mutating inputs", () => {
  const value = input(); value.currentRequest.input.documentText += " ";
  value.currentResult = importOpenApiOperation(value.currentRequest, { now }); const before = canonicalJson(value);
  const compared = compareOpenApiImportSnapshots(value); assert.equal(compared.status, "stale"); assert.equal(canonicalJson(value), before);
  compared.externalIdentity.externalId = "changed"; compared.previous.digest = "changed";
  assert.equal(canonicalJson(value), before);
});
await check("invalid roots getters keys and size never provide partial evidence", () => {
  for (const value of [null, undefined, [], true, {}, { ...input(), extra: true }, new Proxy({}, {})]) {
    const r = issue(value, "INPUT_INVALID"); assert.equal(r.previous, null); assert.equal(r.externalIdentity, null);
  }
  const cyclic = input(); cyclic.self = cyclic; issue(cyclic, "INPUT_INVALID");
  const large = input(); large.currentRequest.input.documentText = "x".repeat(2097153); issue(large, "INPUT_INVALID");
  let reads = 0; const getter = input(); Object.defineProperty(getter, "previousResult", { enumerable: true, get() { reads++; throw Error(); } });
  issue(getter, "INPUT_INVALID"); assert.equal(reads, 0);
});
await check("previous success must be a validated snapshot", () => {
  const wrong = input(); wrong.previousResult.output.digest = "bad"; issue(wrong, "PREVIOUS_INVALID");
  const failed = changed(document => { document.paths = {}; }); failed.previousResult = failed.currentResult; issue(failed, "PREVIOUS_INVALID");
});
await check("current request and result are recomputed and bound", () => {
  for (const mutate of [x => { x.currentRequest.capability.effect = "read-only"; }, x => { x.currentResult.runId = "wrong"; },
    x => { x.currentResult.output.digest = `sha256:${"2".repeat(64)}`; }]) { const value = input(); mutate(value); issue(value, "CURRENT_INVALID"); }
});
await check("external identity and selected operation must stay the same", () => {
  const value = input(); value.previousResult.output.externalIdentity.externalId = "other"; issue(value, "IDENTITY_MISMATCH");
  const other = changed((document, request) => { document.paths["/other"] = document.paths[request.input.path]; request.input.path = "/other"; });
  issue(other, "IDENTITY_MISMATCH");
  const method = changed((document, request) => { document.paths[request.input.path].post = {}; request.input.method = "post"; });
  issue(method, "IDENTITY_MISMATCH");
});
await check("same digest with different retained metadata is contradictory", () => {
  const value = input(); value.previousResult.output.operation.operationId = "oldButSameDigest"; issue(value, "SNAPSHOT_CONTRADICTION");
});
await check("time comparison retains submillisecond precision and timezone equality", () => {
  const value = input(); value.previousResult.output.retrievedAt = "2026-09-08T18:00:00.000000002Z";
  value.currentResult.output.retrievedAt = "2026-09-08T18:00:00.000000001Z"; issue(value, "TIME_REGRESSION");
  value.currentResult.output.retrievedAt = "2026-09-09T03:00:00.000000002+09:00";
  assert.equal(compareOpenApiImportSnapshots(value).status, "current");
});
await check("genuine missing operation includes only the attempted source digest", () => {
  const value = changed(document => { document.paths = {}; }); value.currentResult.failure.message = "PRIVATE_FAILURE_BODY";
  const r = compareOpenApiImportSnapshots(value); assert.equal(r.status, "missing");
  assert.equal(r.current.documentDigest, `sha256:${createHash("sha256").update(value.currentRequest.input.documentText).digest("hex")}`);
  for (const text of ["documentText", "PRIVATE_FAILURE_BODY", "invalid.example.test", "PRIVATE_HEADER_NAME"]) assert.equal(JSON.stringify(r).includes(text), false);
});
await check("a claimed missing failure is independently recalculated", () => {
  const value = changed(document => { document.paths = {}; });
  value.currentRequest.input.documentText = request.input.documentText;
  issue(value, "CURRENT_NOT_MISSING");
  value.currentRequest.input.documentText = "{bad}"; issue(value, "CURRENT_NOT_MISSING");
  const reference = JSON.parse(request.input.documentText); reference.paths[request.input.path].$ref = "https://invalid.example.test";
  value.currentRequest.input.documentText = JSON.stringify(reference); issue(value, "CURRENT_NOT_MISSING");
});
await check("unsupported failures are not availability claims", () => {
  const value = changed(document => { document.paths = {}; });
  for (const code of ["OPENAPI_IMPORT_FAILED", "OPENAPI_IMPORT_DOCUMENT_INVALID", "UNKNOWN_PRIVATE_CODE"]) {
    value.currentResult.failure.code = code; const r = issue(value, "FAILURE_UNSUPPORTED"); assert.equal(JSON.stringify(r).includes(code), false);
  }
});
assert.equal(checks, 11);
console.log(`OpenAPI reimport audit passed: ${checks} checks; source-bound current/stale/missing/invalid comparison verified.`);
