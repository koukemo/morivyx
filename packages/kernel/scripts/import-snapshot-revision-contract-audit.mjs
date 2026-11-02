import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, revisionId, graphRootDigest } from "../src/canonical.js";
import { IMPORT_SNAPSHOT_EXTENSION, writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, validateImportSnapshotRevisionRequest,
  writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { importRepositoryFile } from "../src/repository-importer.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";
import { validateGitHubImportResult } from "../src/github-importer.js";
import { compareImportTimes } from "../src/import-snapshot-record.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const initial = { ...await load("../test/fixtures/plugin-communication/import-authoring.json"),
  manifest: await load("../test/fixtures/plugin-manifest/repository-importer.json"),
  runRequest: await load("../test/fixtures/plugin-communication/request.json"),
  runResult: await load("../test/fixtures/plugin-communication/result.json") };
const authoring = await load("../test/fixtures/plugin-communication/import-revision-authoring.json");
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
async function tree(root) {
  const entries = {};
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${relative}/`);
      else entries[relative] = (await readFile(join(path, entry.name))).toString("base64");
    }
  }
  await walk(root); return entries;
}
const root = await mkdtemp(join(tmpdir(), "morivyx-reimport-package-"));
try {
  const empty = join(root, "empty"); const basePath = join(root, "baseline");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  const source = join(root, "source"); await mkdir(source);
  const file = join(source, "source.txt"); await writeFile(file, "before\n");
  initial.runRequest.input.repositoryRoot = source;
  initial.runResult = await importRepositoryFile(initial.runRequest, { now: () => "2026-09-08T15:00:00Z" });
  await writeImportedSnapshotPackage({ basePath: empty, outputPath: basePath, request: initial });
  const base = await readGraphPackage(basePath); const before = await tree(basePath);
  await writeFile(file, "after\n");
  const currentRequest = structuredClone(initial.runRequest); currentRequest.runId = "run:reimport-current";
  const currentResult = await importRepositoryFile(currentRequest, { now: () => "2026-09-08T15:05:00Z" });
  const request = () => structuredClone({ ...authoring, manifest: initial.manifest,
    runRequest: currentRequest, runResult: currentResult, baseRevision: base.revision.id,
    baseRootDigest: base.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision });
  const reject = (value, code = "IMPORT_REVISION_REQUEST_INVALID") =>
    assert.throws(() => validateImportSnapshotRevisionRequest(value), { code });

  await check("deterministic revise with fixed beforeRevision", () => {
    const input = request(); const inputBefore = canonicalJson(input); const baseBefore = canonicalJson(base.elements);
    const result = prepareImportSnapshotRevision(base, input);
    assert.deepEqual(result, prepareImportSnapshotRevision(base, input));
    assert.equal(result.comparison.status, "stale");
    assert.deepEqual(result.changeSet.operations, [{ op: "revise", targetId: input.artifactId,
      beforeRevision: input.baselineArtifactRevision, afterRevision: result.candidateElement.revision }]);
    assert.equal(result.candidateElement.lifecycle, "draft"); assert.equal(result.candidateElement.reviewState, "unreviewed");
    assert.equal(result.candidateElement.provenance.method, "imported");
    assert.deepEqual(result.changeSet.provenance.previousImportSnapshot.snapshot, initial.runResult.output);
    assert.deepEqual(result.changeSet.provenance.importSnapshot.snapshot, currentResult.output);
    assert.equal(result.changeSet.provenance.importSnapshot.executionBinding, "not-verified");
    assert.equal(canonicalJson(result).includes(source), false);
    assert.equal(canonicalJson(result).includes("after\\n"), false);
    result.candidateElement.extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot.locator = "changed";
    assert.equal(result.changeSet.provenance.importSnapshot.snapshot.locator, "source.txt");
    assert.equal(canonicalJson(input), inputBefore); assert.equal(canonicalJson(base.elements), baseBefore);
  });
  await check("strict roots and nonlogical values", () => {
    for (const value of [undefined, null, [], true, "x", 1, 1n, new Date(), new Proxy({}, {})]) reject(value);
    const cyclic = request(); cyclic.self = cyclic; reject(cyclic);
    const hidden = request(); Object.defineProperty(hidden, "hidden", { value: true }); reject(hidden);
    const extra = request(); extra.comparison = { status: "stale" }; reject(extra);
    let count = 0; const accessor = request();
    Object.defineProperty(accessor, "baselineArtifactRevision", { enumerable: true, get() { count++; throw Error(); } });
    reject(accessor); assert.equal(count, 0);
  });
  await check("authoring and baseline shape", () => {
    for (const [key, value] of [["format", "invalid"], ["baselineArtifactRevision", "bad"],
      ["artifactId", "bad"], ["changeSetId", authoring.artifactId], ["recordedAt", "2026-02-30T00:00:00Z"]]) reject({ ...request(), [key]: value });
    const missing = request(); delete missing.baselineArtifactRevision; reject(missing);
    const large = request(); large.runRequest.input.repositoryRoot = "x".repeat(1048576);
    reject(large, "IMPORT_REVISION_INPUT_LIMIT");
  });
  await check("wrong request result and declared formats", () => {
    for (const mutate of [x => { x.runResult.runId = "wrong"; },
      x => { x.runResult.output.locator = "wrong"; },
      x => { x.manifest.identity.id = "wrong"; },
      x => { x.manifest.capabilities[0].outputFormat = "wrong/0.1"; }]) {
      const input = request(); mutate(input); reject(input);
    }
  });
  await check("base and target existence", () => {
    assert.throws(() => prepareImportSnapshotRevision(null, request()), { code: "IMPORT_REVISION_PACKAGE_INVALID" });
    assert.throws(() => prepareImportSnapshotRevision(base, { ...request(), baseRevision: "graph:stale" }), { code: "IMPORT_REVISION_BASE_MISMATCH" });
    const missing = structuredClone(base); missing.elements = [];
    assert.throws(() => prepareImportSnapshotRevision(missing, request()), { code: "IMPORT_REVISION_TARGET_INVALID" });
    const wrong = structuredClone(base); wrong.elements[0].type = "core.decision";
    assert.throws(() => prepareImportSnapshotRevision(wrong, request()), { code: "IMPORT_REVISION_TARGET_INVALID" });
    const duplicate = structuredClone(base); duplicate.changeSets.push({ id: authoring.changeSetId });
    assert.throws(() => prepareImportSnapshotRevision(duplicate, request()), { code: "IMPORT_REVISION_CHANGESET_EXISTS" });
  });
  await check("missing or ambiguous import ledger baseline", () => {
    for (const duplicate of [false, true]) {
      const value = structuredClone(base); value.changeSets = duplicate ? [...value.changeSets, ...value.changeSets] : [];
      assert.throws(() => prepareImportSnapshotRevision(value, request()), { code: "IMPORT_REVISION_BASELINE_UNRECORDED" });
    }
    const malformed = structuredClone(base); malformed.changeSets[0].operations = null;
    assert.throws(() => prepareImportSnapshotRevision(malformed, request()), { code: "IMPORT_REVISION_BASELINE_UNRECORDED" });
  });
  await check("inconsistent baseline metadata and regressed retrieval time", () => {
    for (const mutate of [
      x => { x.changeSets[0].provenance.importSnapshot.plugin.id = "wrong"; },
      x => { x.changeSets[0].provenance.importSnapshot.informationLoss = []; },
      x => { x.elements[0].attributes.uri = "urn:wrong"; },
      x => { delete x.elements[0].extensions; },
      x => { x.changeSets[0].provenance.method = "asserted"; },
      x => { x.elements[0].provenance.actor = authoring.artifactId; },
    ]) { const value = structuredClone(base); mutate(value);
      assert.throws(() => prepareImportSnapshotRevision(value, request()), { code: "IMPORT_REVISION_BASELINE_INVALID" }); }
    const input = request(); input.runResult.output.retrievedAt = "2026-09-08T14:00:00Z";
    assert.throws(() => prepareImportSnapshotRevision(base, input), { code: "IMPORT_REVISION_BASELINE_INVALID" });
    const recorded = request(); recorded.recordedAt = "2026-09-08T15:30:00Z";
    assert.throws(() => prepareImportSnapshotRevision(base, recorded), { code: "IMPORT_REVISION_BASELINE_INVALID" });
  });
  await check("recorded Run identity cannot be reused", () => {
    const input = request(); input.runRequest.runId = initial.runRequest.runId; input.runResult.runId = initial.runResult.runId;
    assert.throws(() => prepareImportSnapshotRevision(base, input), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
  });
  await check("unchanged and different external identity", () => {
    const unchanged = request(); unchanged.runResult.output.digest = initial.runResult.output.digest;
    assert.throws(() => prepareImportSnapshotRevision(base, unchanged), { code: "IMPORT_REVISION_UNCHANGED" });
    const other = request(); other.runRequest.input.externalId = "other"; other.runResult.output.externalIdentity.externalId = "other";
    assert.throws(() => prepareImportSnapshotRevision(base, other), { code: "IMPORT_REVISION_COMPARISON_INVALID" });
  });

  const updatedPath = join(root, "updated");
  await check("real external update persists with both snapshots", async () => {
    const saved = await writeReimportedSnapshotPackage({ basePath, outputPath: updatedPath, request: request() });
    assert.equal(saved.valid, true); assert.equal((await validatePackage(updatedPath)).valid, true);
    const value = await readGraphPackage(updatedPath);
    assert.equal(value.elements[0].attributes.digest, currentResult.output.digest);
    assert.equal(value.changeSets.length, 2);
    assert.deepEqual(value.changeSets.find(x => x.id === initial.changeSetId).provenance.importSnapshot.snapshot, initial.runResult.output);
    assert.deepEqual(value.changeSets.find(x => x.id === authoring.changeSetId).provenance.previousImportSnapshot.snapshot, initial.runResult.output);
    assert.deepEqual(await tree(basePath), before);
  });
  await check("successive import uses the last recorded revision", async () => {
    const value = await readGraphPackage(updatedPath); await writeFile(file, "third\n");
    const next = request(); next.changeSetId = next.changeSetId.replace("0803", "0804");
    next.baseRevision = value.revision.id; next.baseRootDigest = value.revision.rootDigest;
    next.baselineArtifactRevision = value.elements[0].revision; next.resultingRevision = "graph:import-third";
    next.runRequest.runId = "run:third";
    next.runResult = await importRepositoryFile(next.runRequest, { now: () => "2026-09-08T15:10:00Z" });
    const path = join(root, "third");
    await writeReimportedSnapshotPackage({ basePath: updatedPath, outputPath: path, request: next });
    assert.equal((await validatePackage(path)).valid, true);
    assert.equal((await readGraphPackage(path)).changeSets.length, 3);
  });
  await check("simulated human edit cannot be recast as an import baseline", async () => {
    const edited = structuredClone(base.elements[0]); edited.attributes.uri = "urn:human:edited";
    edited.provenance.method = "asserted"; edited.revision = revisionId(edited);
    const digest = graphRootDigest([edited]); const path = join(root, "human-edited");
    const revision = { ...base.revision, id: "graph:human-edited", parentRevision: base.revision.id, rootDigest: digest };
    const changeSet = { format: "morivyx.changeset/0.1", id: authoring.changeSetId.replace("0803", "0990"),
      baseRevision: base.revision.id, resultingRevision: revision.id, resultingRootDigest: digest,
      schemaLockDigest: base.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: base.elements[0].revision, afterRevision: edited.revision }],
      provenance: { method: "asserted", actor: authoring.actor, recordedAt: authoring.recordedAt }, recordedAt: authoring.recordedAt };
    await writeAppliedPackage({ basePath, outputPath: path, changeSet, candidateElements: [edited], resultingRevision: revision });
    const input = request(); input.baseRevision = revision.id; input.baseRootDigest = digest;
    const humanBefore = await tree(path);
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: path, outputPath: join(root, "conflict"), request: input }), { code: "IMPORT_REVISION_LOCAL_CONFLICT" });
    input.baselineArtifactRevision = edited.revision;
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: path, outputPath: join(root, "forged-baseline"), request: input }), { code: "IMPORT_REVISION_BASELINE_UNRECORDED" });
    assert.deepEqual(await tree(path), humanBefore);
    await assert.rejects(access(join(root, "conflict")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "forged-baseline")), { code: "ENOENT" });
  });
  await check("missing unavailable unchanged and output collision leave no partial output", async () => {
    await rm(file);
    const missing = request(); missing.runResult = await importRepositoryFile(missing.runRequest);
    const unavailable = request(); unavailable.runRequest.input.repositoryRoot = join(root, "absent-source");
    unavailable.runResult = await importRepositoryFile(unavailable.runRequest);
    const unchanged = request(); unchanged.runResult.output.digest = initial.runResult.output.digest;
    for (const [index, input] of [missing, unavailable, unchanged].entries()) {
      const path = join(root, `rejected-${index}`);
      await assert.rejects(writeReimportedSnapshotPackage({ basePath, outputPath: path, request: input }));
      await assert.rejects(access(path), { code: "ENOENT" });
    }
    const saved = await tree(updatedPath);
    await assert.rejects(writeReimportedSnapshotPackage({ basePath, outputPath: updatedPath, request: request() }), { code: "PACKAGE_OUTPUT_EXISTS" });
    assert.deepEqual(await tree(updatedPath), saved); assert.deepEqual(await tree(basePath), before);
    await assert.rejects(writeReimportedSnapshotPackage(null), { code: "IMPORT_REVISION_REQUEST_INVALID" });
  });
  await check("snapshot input before asynchronous read", async () => {
    const input = request(); const path = join(root, "immutable");
    const pending = writeReimportedSnapshotPackage({ basePath, outputPath: path, request: input });
    input.runResult.output.digest = `sha256:${"0".repeat(64)}`; input.baselineArtifactRevision = "bad";
    await pending;
    assert.equal((await readGraphPackage(path)).elements[0].attributes.digest, currentResult.output.digest);
  });
  await check("GitHub update conflict and fixed-commit contradiction", async () => {
    const creation = structuredClone(initial);
    creation.runRequest = await load("../test/fixtures/github-importer/request.json");
    creation.runResult = await load("../test/fixtures/github-importer/result.json");
    creation.runResult.output.retrievedAt = "2026-09-08T15:00:00.900Z";
    creation.manifest.identity.id = creation.runResult.plugin.id;
    Object.assign(creation.manifest.capabilities[0], { id: creation.runResult.capabilityId,
      inputFormat: "morivyx.github-read-input/0.1", outputFormat: "morivyx.github-file-snapshot/0.1" });
    const path = join(root, "github-base");
    await writeImportedSnapshotPackage({ basePath: empty, outputPath: path, request: creation });
    const value = await readGraphPackage(path);
    assert.equal(value.elements[0].extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot.retrievedAt, "2026-09-08T15:00:00.9Z");
    const input = { ...request(), manifest: creation.manifest, runRequest: structuredClone(creation.runRequest),
      runResult: structuredClone(creation.runResult), baseRevision: value.revision.id, baseRootDigest: value.revision.rootDigest,
      baselineArtifactRevision: value.elements[0].revision };
    input.runRequest.runId = "run:github-updated"; input.runResult.runId = "run:github-updated";
    input.runRequest.input.commit = "2".repeat(40); input.runResult.output.source.commit = "2".repeat(40);
    input.runResult.output.source.blobSha = createHash("sha1").update("blob 1\0x").digest("hex");
    input.runResult.output.digest = `sha256:${createHash("sha256").update("x").digest("hex")}`;
    input.runResult.output.byteLength = 1;
    input.runResult.output.retrievedAt = "2026-09-08T15:00:01.120Z";
    const output = join(root, "github-updated");
    await writeReimportedSnapshotPackage({ basePath: path, outputPath: output, request: input });
    assert.equal((await validatePackage(output)).valid, true);
    assert.equal((await readGraphPackage(output)).elements[0].attributes.externalVersion, "2".repeat(40));
    const saved = await readGraphPackage(output);
    assert.equal(saved.elements[0].extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot.retrievedAt, "2026-09-08T15:00:01.12Z");
    const unchanged = structuredClone(input); unchanged.runRequest.runId = "run:github-next"; unchanged.runResult.runId = "run:github-next";
    unchanged.changeSetId = unchanged.changeSetId.replace("0803", "0805");
    unchanged.baseRevision = saved.revision.id; unchanged.baseRootDigest = saved.revision.rootDigest;
    unchanged.baselineArtifactRevision = saved.elements[0].revision; unchanged.resultingRevision = "graph:github-next";
    assert.throws(() => prepareImportSnapshotRevision(saved, unchanged), { code: "IMPORT_REVISION_UNCHANGED" });
    const changed = structuredClone(value); changed.elements[0].revision = `sha256:${"0".repeat(64)}`;
    assert.throws(() => prepareImportSnapshotRevision(changed, input), { code: "IMPORT_REVISION_LOCAL_CONFLICT" });
    input.runRequest.input.commit = "1".repeat(40); input.runResult.output.source.commit = "1".repeat(40);
    assert.throws(() => prepareImportSnapshotRevision(value, input), { code: "IMPORT_REVISION_COMPARISON_INVALID" });
  });
  await check("GitHub timestamps accept normalized milliseconds only", async () => {
    const result = await load("../test/fixtures/github-importer/result.json");
    for (const fraction of ["", ".9", ".90", ".900", ".12", ".120", ".123", ".000"]) {
      result.output.retrievedAt = `2026-09-08T15:00:00${fraction}Z`;
      assert.equal(validateGitHubImportResult(result), result);
    }
    for (const time of ["2026-02-30T00:00:00Z", "2026-09-08T15:00:00.1234Z", "not-a-time"]) {
      result.output.retrievedAt = time;
      assert.throws(() => validateGitHubImportResult(result), { code: "GITHUB_IMPORT_RESULT_INVALID" });
    }
    assert.equal(compareImportTimes("2026-09-08T15:00:00.000000002Z", "2026-09-08T15:00:00.000000001Z"), 1);
    assert.equal(compareImportTimes("2026-09-08T15:00:00Z", "2026-09-08T15:00:00.000000001Z"), -1);
    assert.equal(compareImportTimes("2026-09-09T00:00:00.900+09:00", "2026-09-08T15:00:00.9Z"), 0);
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 16);
console.log(`Import snapshot revision audit passed: ${checks} checks; real external update and simulated human-edit protection verified.`);
