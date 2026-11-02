import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../src/canonical.js";
import { compareFigmaImportSnapshots } from "../src/figma-reimport.js";
const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const request = await load("../test/fixtures/figma-importer/request.json");
const result = await load("../test/fixtures/figma-importer/result.json");
const expected = await load("../test/fixtures/figma-importer/comparison-current.json");
const contract = await load("../../../contracts/figma-reimport@0.1.schema.json");
const input = () => ({ previousResult: structuredClone(result), currentRequest: structuredClone(request), currentResult: structuredClone(result) });
function issue(value, code) { const report = compareFigmaImportSnapshots(value); assert.equal(report.status, "invalid"); assert.deepEqual(report.issues, [{ code: `FIGMA_REIMPORT_${code}` }]); return report; }
function failed(code, version = "1002") {
  const value = input(); value.currentRequest.input.version = version; value.currentResult.status = "failure"; delete value.currentResult.output;
  value.currentResult.failure = { code, message: "PRIVATE_PROVIDER_BODY" }; return value;
}
let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
await check("fixed current comparison and JSON contract", () => {
  assert.deepEqual(compareFigmaImportSnapshots(input()), expected); assert.deepEqual(contract.required, Object.keys(expected));
});
await check("version metadata alone is current but a changed Node in another version is stale", () => {
  const value = input(); value.currentRequest.input.version = "1002"; value.currentResult.output.source.version = "1002";
  assert.equal(compareFigmaImportSnapshots(value).status, "current");
  value.currentResult.output.digest = `sha256:${"2".repeat(64)}`; assert.equal(compareFigmaImportSnapshots(value).status, "stale");
});
await check("same fixed version cannot have different content or disappear", () => {
  const value = input(); value.currentResult.output.digest = `sha256:${"2".repeat(64)}`; issue(value, "SNAPSHOT_CONTRADICTION");
  issue(failed("FIGMA_IMPORT_TARGET_MISSING", "1001"), "SNAPSHOT_CONTRADICTION");
});
await check("equal digests cannot describe different Node types even across versions", () => {
  const value = input(); value.currentResult.output.node.type = "TEXT"; issue(value, "SNAPSHOT_CONTRADICTION");
  value.currentRequest.input.version = "1002"; value.currentResult.output.source.version = "1002"; issue(value, "SNAPSHOT_CONTRADICTION");
});
await check("file and Node identity must remain bound", () => {
  const file = input(); file.previousResult.output.externalIdentity.fileKey = "other"; file.previousResult.output.source.fileKey = "other";
  file.previousResult.output.externalIdentity.externalId = "figma:other:1:2"; issue(file, "IDENTITY_MISMATCH");
  const node = input(); node.previousResult.output.locator = "3:4"; node.previousResult.output.node.id = "3:4";
  node.previousResult.output.externalIdentity.externalId = "figma:fixtureFile:3:4"; issue(node, "IDENTITY_MISMATCH");
});
await check("retrieval ordering retains submillisecond precision and timezone equivalence", () => {
  const value = input(); value.previousResult.output.retrievedAt = "2026-09-08T19:00:00.000000002Z";
  value.currentResult.output.retrievedAt = "2026-09-08T19:00:00.000000001Z"; issue(value, "TIME_REGRESSION");
  value.currentResult.output.retrievedAt = "2026-09-09T04:00:00.000000002+09:00"; assert.equal(compareFigmaImportSnapshots(value).status, "current");
});
await check("only known failure classes become missing or unavailable", () => {
  for (const [code, status] of [["FIGMA_IMPORT_TARGET_MISSING", "missing"], ["FIGMA_IMPORT_SOURCE_UNAVAILABLE", "unavailable"], ["FIGMA_IMPORT_TIMEOUT", "unavailable"]]) {
    const report = compareFigmaImportSnapshots(failed(code)); assert.equal(report.status, status); assert.equal(report.current.requestedVersion, "1002");
    assert.equal(JSON.stringify(report).includes("PRIVATE_PROVIDER_BODY"), false);
  }
  assert.equal(compareFigmaImportSnapshots(failed("FIGMA_IMPORT_SOURCE_UNAVAILABLE", "1001")).status, "unavailable");
  for (const code of ["FIGMA_IMPORT_FAILED", "FIGMA_IMPORT_RESPONSE_INVALID", "PRIVATE_UNKNOWN_CODE"]) {
    const report = issue(failed(code), "FAILURE_UNSUPPORTED"); assert.equal(JSON.stringify(report).includes(code), false);
  }
});
await check("invalid roots limits and accessors return no partial evidence", () => {
  for (const value of [null, undefined, [], true, {}, new Proxy({}, {}), { ...input(), extra: true }]) assert.equal(issue(value, "INPUT_INVALID").previous, null);
  const cyclic = input(); cyclic.self = cyclic; issue(cyclic, "INPUT_INVALID");
  const huge = failed("FIGMA_IMPORT_TIMEOUT"); huge.currentResult.failure.message = "x".repeat(2097153); issue(huge, "INPUT_INVALID");
  let reads = 0; const getter = input(); Object.defineProperty(getter, "previousResult", { enumerable: true, get() { reads++; throw Error(); } });
  issue(getter, "INPUT_INVALID"); assert.equal(reads, 0);
});
await check("previous results must be validated successful snapshots", () => {
  const value = input(); value.previousResult.output.digest = "bad"; issue(value, "PREVIOUS_INVALID");
  value.previousResult = failed("FIGMA_IMPORT_TIMEOUT").currentResult; issue(value, "PREVIOUS_INVALID");
});
await check("current request result and selected version must agree", () => {
  for (const mutate of [x => { x.currentResult.runId = "other"; }, x => { x.currentRequest.input.version = "1002"; },
    x => { x.currentRequest.capability.effect = "pure"; }, x => { x.currentResult.output.node.id = "3:4"; }]) {
    const value = input(); mutate(value); issue(value, "CURRENT_INVALID");
  }
});
await check("reports do not mutate input snapshots or retain failure body", () => {
  const value = input(); const before = canonicalJson(value); const report = compareFigmaImportSnapshots(value);
  report.externalIdentity.fileKey = "changed"; report.previous.digest = "changed"; report.current.digest = "changed";
  assert.equal(canonicalJson(value), before);
});
assert.equal(checks, 11);
console.log(`Figma reimport audit passed: ${checks} checks; fixed-version contradictions and bounded availability classes verified.`);
