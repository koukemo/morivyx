import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compareGitHubImportSnapshots, assessGitHubReimport } from "../src/github-reimport.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`../test/fixtures/github-importer/${name}.json`, import.meta.url), "utf8",
));
const request = await fixture("request");
const result = await fixture("result");
const fixedComparison = await fixture("comparison");
const fixedAssessment = await fixture("assessment");
const clone = structuredClone;
function input() {
  const currentRequest = clone(request);
  currentRequest.runId = "run:github-reimport";
  currentRequest.input.commit = "4".repeat(40);
  const currentResult = clone(result);
  currentResult.runId = currentRequest.runId;
  currentResult.output.source.commit = currentRequest.input.commit;
  currentResult.output.retrievedAt = "2026-09-08T15:10:00Z";
  return { previousResult: clone(result), currentRequest, currentResult };
}
function changed(value = input()) {
  const bytes = Buffer.from("modified\n");
  const output = value.currentResult.output;
  output.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  output.source.blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  output.byteLength = bytes.length;
  return value;
}
function failure(code, value = input()) {
  delete value.currentResult.output;
  value.currentResult.status = "failure";
  value.currentResult.failure = { code, message: "private-provider-value" };
  return value;
}
function assessmentInput(value = input(), revision = "revision:human-edit") {
  return { ...value, baselineTarget: { id: "entity:github-fixture", revision: "revision:baseline" },
    currentTarget: { id: "entity:github-fixture", revision } };
}
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await check("fixed outputs and contract field alignment", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../../contracts/github-reimport@0.1.schema.json", import.meta.url,
  ), "utf8"));
  assert.deepEqual(compareGitHubImportSnapshots(input()), fixedComparison);
  assert.deepEqual(assessGitHubReimport(assessmentInput()), fixedAssessment);
  assert.deepEqual(Object.keys(fixedComparison), schema.$defs.Comparison.required);
  assert.deepEqual(Object.keys(fixedAssessment), schema.$defs.Assessment.required);
  assert.deepEqual(Object.keys(fixedComparison.previous), schema.$defs.Descriptor.required);
  const importerSchema = JSON.parse(await readFile(new URL(
    "../../../contracts/github-importer@0.1.schema.json", import.meta.url,
  ), "utf8"));
  function refs(node) {
    if (node === null || typeof node !== "object") return;
    if (node.$ref) {
      const [file, pointer] = node.$ref.split("#");
      assert.ok(file === "" || file === importerSchema.$id);
      const resolved = pointer.slice(1).split("/").reduce((v, key) => v?.[key], file ? importerSchema : schema);
      assert.notEqual(resolved, undefined);
    }
    for (const value of Object.values(node)) refs(value);
  }
  refs(schema);
});

await check("commit-only change and repeat read remain current", () => {
  assert.equal(compareGitHubImportSnapshots(input()).status, "current");
  const value = input();
  value.currentRequest.input.commit = request.input.commit;
  value.currentResult.output.source.commit = request.input.commit;
  assert.equal(compareGitHubImportSnapshots(value).status, "current");
});

await check("content and executable mode independently become stale", () => {
  assert.equal(compareGitHubImportSnapshots(changed()).status, "stale");
  const value = input();
  value.currentResult.output.source.mode = "100755";
  assert.equal(compareGitHubImportSnapshots(value).status, "stale");
});

await check("repository identity survives owner and repository renames", () => {
  const value = input();
  for (const field of ["owner", "repository"]) {
    value.currentRequest.input[field] = `renamed-${field}`;
    value.currentResult.output.source[field] = `renamed-${field}`;
  }
  assert.equal(compareGitHubImportSnapshots(value).status, "current");
});

await check("repository and locator switches cannot silently change identity", () => {
  for (const field of ["repositoryId", "locator"]) {
    const value = input();
    value.currentRequest.input[field] = field === "repositoryId" ? 124 : "another.txt";
    const { repositoryId, locator } = value.currentRequest.input;
    value.currentResult.output.locator = locator;
    value.currentResult.output.externalIdentity = { system: "github", repositoryId,
      externalId: `github:${repositoryId}:${locator}` };
    const report = compareGitHubImportSnapshots(value);
    assert.equal(report.status, "invalid");
    assert.equal(report.issues[0].code, "GITHUB_REIMPORT_IDENTITY_MISMATCH");
  }
});

await check("current request and result must agree", () => {
  for (const mutate of [v => { v.currentResult.runId = "different-run"; },
    v => { v.currentResult.output.source.commit = "5".repeat(40); },
    v => { v.currentResult.output.source.owner = "different-owner"; },
    v => { v.currentRequest.input.commit = "main"; }]) {
    const value = input(); mutate(value);
    assert.equal(compareGitHubImportSnapshots(value).status, "invalid");
  }
});

await check("immutable commit, blob, digest and size contradictions are invalid", () => {
  for (const mutate of [v => { v.currentResult.output.source.blobSha = "6".repeat(40); },
    v => { v.currentResult.output.digest = `sha256:${"6".repeat(64)}`; },
    v => { v.currentResult.output.byteLength = 1; },
    v => { changed(v); v.currentRequest.input.commit = request.input.commit;
      v.currentResult.output.source.commit = request.input.commit; },
    v => { v.currentResult.output.source.mode = "100755";
      v.currentRequest.input.commit = request.input.commit;
      v.currentResult.output.source.commit = request.input.commit; }]) {
    const value = input(); mutate(value);
    const report = compareGitHubImportSnapshots(value);
    assert.equal(report.status, "invalid");
    assert.equal(report.issues[0].code, "GITHUB_REIMPORT_SNAPSHOT_CONTRADICTION");
  }
});

await check("only explicit verified missing is missing, immutable disappearance is invalid", () => {
  const value = failure("GITHUB_IMPORT_TARGET_MISSING");
  assert.equal(compareGitHubImportSnapshots(value).status, "missing");
  value.currentRequest.input.commit = request.input.commit;
  assert.equal(compareGitHubImportSnapshots(value).status, "invalid");
});

await check("transport and resource failures never mean deletion", () => {
  for (const suffix of ["SOURCE_UNAVAILABLE", "FAILED", "TIMEOUT", "RESPONSE_LIMIT", "REQUEST_LIMIT", "FILE_LIMIT"]) {
    assert.equal(compareGitHubImportSnapshots(failure(`GITHUB_IMPORT_${suffix}`)).status, "unavailable");
  }
});

await check("invalid failures remain invalid and provider values are not reflected", () => {
  for (const code of ["GITHUB_IMPORT_RESPONSE_INVALID", "GITHUB_IMPORT_IDENTITY_MISMATCH",
    "GITHUB_IMPORT_DIGEST_MISMATCH", "provider-secret-unknown"]) {
    const report = compareGitHubImportSnapshots(failure(code));
    assert.equal(report.status, "invalid");
    assert.equal(JSON.stringify(report).includes("private-provider-value"), false);
    assert.equal(JSON.stringify(report).includes("provider-secret-unknown"), false);
  }
});

const matrix = {
  current: [input, ["unchanged", "local-changed", "local-deleted"]],
  stale: [changed, ["external-changed", "conflict", "delete-conflict"]],
  missing: [() => failure("GITHUB_IMPORT_TARGET_MISSING"), ["external-missing", "missing-conflict", "both-missing"]],
  unavailable: [() => failure("GITHUB_IMPORT_TIMEOUT"), Array(3).fill("blocked-unavailable")],
  invalid: [() => failure("GITHUB_IMPORT_TREE_INVALID"), Array(3).fill("blocked-invalid")],
};
for (const [external, [build, statuses]] of Object.entries(matrix)) {
  for (const [index, revision] of ["revision:baseline", "revision:human-edit", null].entries()) {
    await check(`external ${external} with local ${["baseline", "changed", "deleted"][index]}`, () => {
      const report = assessGitHubReimport(assessmentInput(build(), revision));
      assert.equal(report.comparison.status, external);
      assert.equal(report.localStatus, ["baseline", "changed", "deleted"][index]);
      assert.equal(report.status, statuses[index]);
    });
  }
}

await check("previous result must be valid and successful", () => {
  for (const previousResult of [null, {}, failure("GITHUB_IMPORT_TIMEOUT").currentResult]) {
    assert.equal(compareGitHubImportSnapshots({ ...input(), previousResult }).status, "invalid");
  }
});

await check("non-logical and extra input fields are rejected", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, null, [], {}, cyclic, new Date(), { ...input(), extra: true },
    { ...input(), currentResult: NaN }, { ...input(), currentRequest: undefined }]) {
    assert.equal(compareGitHubImportSnapshots(value).status, "invalid");
    assert.equal(assessGitHubReimport(value).status, "blocked-invalid");
  }
});

await check("accessors are rejected without execution at every depth", () => {
  for (const locate of [v => [v, "previousResult"], v => [v.currentResult.output, "digest"],
    v => [v.currentTarget, "revision"]]) {
    const value = assessmentInput();
    let called = false;
    const [object, key] = locate(value);
    Object.defineProperty(object, key, { enumerable: true, get() { called = true; return "secret"; } });
    assert.equal(assessGitHubReimport(value).status, "blocked-invalid");
    assert.equal(called, false);
  }
});

await check("ambiguous deletion, invalid revisions and different local IDs are blocked", () => {
  for (const currentTarget of [null, {}, { id: "entity:github-fixture" },
    { id: "entity:github-fixture", revision: "" }, { id: "entity:github-fixture", revision: 1 },
    { id: "another-entity", revision: null }, { id: "", revision: null }]) {
    assert.equal(assessGitHubReimport({ ...assessmentInput(), currentTarget }).status, "blocked-invalid");
  }
  assert.equal(assessGitHubReimport({ ...assessmentInput(), baselineTarget: {
    id: "entity:github-fixture", revision: null,
  } }).status, "blocked-invalid");
});

await check("self-reported comparison cannot bypass recomputation", () => {
  const value = assessmentInput(changed());
  assert.equal(assessGitHubReimport(value).status, "conflict");
  assert.equal(assessGitHubReimport({ ...value, comparison: fixedComparison }).status, "blocked-invalid");
});

await check("frozen inputs remain unchanged and returned records are owned copies", () => {
  function freeze(value) {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const value = freeze(assessmentInput());
  const before = JSON.stringify(value);
  const report = assessGitHubReimport(value);
  report.comparison.externalIdentity.repositoryId = 999;
  report.comparison.previous.source.owner = "mutated";
  report.comparison.current.source.owner = "mutated";
  report.baselineTarget.revision = "mutated";
  report.currentTarget.revision = "mutated";
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(assessGitHubReimport(value), fixedAssessment);
});

await check("comparison and assessment make no network calls", () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error("network prohibited"); };
  try {
    assert.equal(compareGitHubImportSnapshots(input()).status, "current");
    assert.equal(assessGitHubReimport(assessmentInput()).status, "local-changed");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

console.log(`github-reimport-contract-audit: ${checks} checks passed`);
