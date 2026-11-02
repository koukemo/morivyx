import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, graphRootDigest, revisionId } from "../src/canonical.js";
import { IMPORT_PRESENCE_EXTENSION, prepareImportPresence, validateImportPresenceRequest, writeImportPresencePackage } from "../src/import-presence.js";
import { prepareImportSnapshotCreation, writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { prepareImportAvailability, writeImportAvailabilityPackage } from "../src/import-availability.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const initial = { ...await load("../test/fixtures/plugin-communication/import-authoring.json"),
  manifest: await load("../test/fixtures/plugin-manifest/repository-importer.json"),
  runRequest: await load("../test/fixtures/plugin-communication/request.json"), runResult: await load("../test/fixtures/plugin-communication/result.json") };
const authoring = await load("../test/fixtures/plugin-communication/import-presence-authoring.json");
const failureAuthoring = await load("../test/fixtures/plugin-communication/import-availability-authoring.json");
const contract = await load("../../../contracts/import-presence@0.1.schema.json");
const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const root = await mkdtemp(join(tmpdir(), "morivyx-presence-")); let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
async function tree(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await tree(join(path, entry.name)))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = (await readFile(join(path, entry.name))).toString("base64");
  }
  return result;
}
function bind(base, request) { return { ...request, baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest }; }
function fresh(request, runId) { const value = structuredClone(request); value.runRequest.runId = runId; value.runResult.runId = runId; return value; }
try {
  const empty = join(root, "empty"); const basePath = join(root, "initial");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  await writeImportedSnapshotPackage({ basePath: empty, outputPath: basePath, request: initial });
  const base = await readGraphPackage(basePath); const before = await tree(basePath);
  const request = () => {
    const value = bind(base, { ...authoring, manifest: initial.manifest, runRequest: initial.runRequest, runResult: initial.runResult,
      baselineArtifactRevision: base.elements[0].revision });
    const result = fresh(value, "run:presence"); result.runResult.output.retrievedAt = "2026-09-08T18:59:59Z"; return result;
  };
  const reject = value => assert.throws(() => validateImportPresenceRequest(value), { code: "IMPORT_PRESENCE_REQUEST_INVALID" });
  await check("fixed contract and deterministic current observation without an Artifact update", () => {
    const value = request(); const original = canonicalJson(value); const prepared = prepareImportPresence(base, value);
    assert.deepEqual([...contract.required].sort(), Object.keys(value).sort());
    assert.equal(contract.properties.format.const, value.format); assert.equal(validateImportPresenceRequest(value), value);
    assert.deepEqual(prepared, prepareImportPresence(base, value)); assert.equal(prepared.comparison.status, "current");
    assert.deepEqual(prepared.changeSet.operations.map(x => x.op), ["create", "create"]);
    assert.deepEqual(prepared.candidateElements.map(x => x.type), ["core.observation", "core.observes"]);
    for (const entity of prepared.candidateElements) {
      assert.equal(entity.lifecycle, "draft"); assert.equal(entity.reviewState, "unreviewed"); assert.equal(entity.revision, revisionId(entity));
    }
    const record = prepared.candidateElements[0].extensions[IMPORT_PRESENCE_EXTENSION];
    assert.equal(record.status, "available"); assert.equal(record.localStatus, "baseline"); assert.equal(record.executionBinding, "not-verified");
    assert.deepEqual(record.currentImportSnapshot.snapshot, value.runResult.output);
    assert.deepEqual(record.previousImportSnapshot.snapshot, initial.runResult.output);
    record.currentImportSnapshot.snapshot.digest = "mutated";
    assert.equal(prepared.changeSet.provenance.importPresence.currentImportSnapshot.snapshot.digest, value.runResult.output.digest);
    assert.equal(canonicalJson(value), original);
  });
  const observedPath = join(root, "observed"); let observed;
  await check("success after fixed missing evidence is retained and does not erase history", async () => {
    const missing = bind(base, { ...failureAuthoring, manifest: initial.manifest, runRequest: initial.runRequest,
      runResult: { ...initial.runResult, status: "failure", failure: { code: "REPOSITORY_IMPORT_TARGET_MISSING", message: "fixed missing" } },
      baselineArtifactRevision: base.elements[0].revision });
    delete missing.runResult.output; const failed = fresh(missing, "run:missing-before-presence");
    const path = join(root, "missing"); await writeImportAvailabilityPackage({ basePath, outputPath: path, request: failed });
    const lost = await readGraphPackage(path); const retained = await tree(path);
    const result = await writeImportPresencePackage({ basePath: path, outputPath: observedPath, request: bind(lost, request()) });
    assert.equal(result.status, "available"); assert.equal(result.comparison, "current");
    observed = await readGraphPackage(observedPath); assert.equal((await validatePackage(observedPath)).valid, true);
    assert.equal(observed.approvals.length, 0); assert.equal(observed.elements.length, lost.elements.length + 2);
    for (const value of lost.elements) assert.deepEqual(observed.elements.find(x => x.id === value.id), value);
    assert.deepEqual(await tree(path), retained); assert.deepEqual(await tree(basePath), before);
  });
  await check("invalid roots accessors limits identities and times are rejected", () => {
    for (const value of [null, undefined, [], true, 1n, new Proxy({}, {})]) reject(value);
    for (const [key, value] of [["format", "bad"], ["artifactId", []], ["observationId", authoring.relationId],
      ["baselineArtifactRevision", "bad"], ["baseRevision", "bad"], ["observedAt", "2026-02-30T00:00:00Z"],
      ["observedAt", "2026-09-08T18:59:58Z"], ["recordedAt", "2026-09-08T18:59:59Z"], ["extra", true]]) reject({ ...request(), [key]: value });
    const absent = request(); delete absent.actor; reject(absent);
    const cyclic = request(); cyclic.self = cyclic; reject(cyclic);
    let reads = 0; const getter = request(); Object.defineProperty(getter, "runResult", { enumerable: true, get() { reads++; throw Error(); } }); reject(getter); assert.equal(reads, 0);
    const large = request(); large.runRequest.input.repositoryRoot = "x".repeat(1048576);
    assert.throws(() => validateImportPresenceRequest(large), { code: "IMPORT_PRESENCE_INPUT_LIMIT" });
  });
  await check("failure unknown Plugin mismatched result and capabilities are not success observations", () => {
    for (const mutate of [x => { x.runResult.status = "failure"; }, x => { x.runResult.plugin.id = "__proto__"; },
      x => { x.runResult.runId = "other"; }, x => { x.manifest.capabilities[0].effect = "pure"; },
      x => { x.manifest.capabilities[0].outputFormat = "other/0.1"; }, x => { x.runResult.output.digest = "bad"; }]) {
      const value = request(); mutate(value); reject(value);
    }
    const other = request(); other.runRequest.input.externalId = "other"; other.runResult.output.externalIdentity.externalId = "other";
    assert.throws(() => prepareImportPresence(base, other), { code: "IMPORT_PRESENCE_COMPARISON_INVALID" });
  });
  await check("base target schema IDs and missing or corrupt baselines are rejected", () => {
    for (const [value, code] of [[null, "PACKAGE_INVALID"], [{ ...base, revision: {} }, "BASE_MISMATCH"],
      [{ ...base, elements: [] }, "TARGET_INVALID"], [{ ...base, schemaLock: { schemas: [] } }, "SCHEMA_MISSING"],
      [{ ...base, changeSets: [] }, "BASELINE_UNRECORDED"]]) assert.throws(() => prepareImportPresence(value, request()), { code: `IMPORT_PRESENCE_${code}` });
    for (const key of ["observationId", "relationId", "changeSetId"]) {
      const value = structuredClone(base); value.approvals.push({ id: authoring[key] });
      assert.throws(() => prepareImportPresence(value, request()), { code: "IMPORT_PRESENCE_ID_EXISTS" });
    }
    const corrupt = structuredClone(base); corrupt.changeSets[0].provenance.importSnapshot.informationLoss = [];
    assert.throws(() => prepareImportPresence(corrupt, request()), { code: "IMPORT_PRESENCE_BASELINE_INVALID" });
  });
  const next = () => bind(observed, { ...fresh(request(), "run:next-presence"), observationId: id(851), relationId: id(852), changeSetId: id(853), resultingRevision: "graph:next-presence" });
  await check("retrieved observed and recorded times cannot regress across positive and negative observations", () => {
    const early = request(); early.runResult.output.retrievedAt = "2026-09-08T15:59:59.999999999Z";
    assert.throws(() => prepareImportPresence(base, early), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
    const value = next(); value.runResult.output.retrievedAt = "2026-09-08T18:59:59.999999999Z";
    assert.throws(() => prepareImportPresence(observed, value), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
    value.runResult.output.retrievedAt = authoring.observedAt; value.recordedAt = authoring.observedAt;
    assert.throws(() => prepareImportPresence(observed, value), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
    value.recordedAt = authoring.recordedAt; assert.equal(prepareImportPresence(observed, value).comparison.status, "current");
    const malformed = structuredClone(observed); malformed.changeSets.find(x => x.provenance.importPresence).provenance.importPresence.observedAt = [authoring.observedAt];
    assert.throws(() => prepareImportPresence(malformed, value), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
  });
  await check("Run reuse and later update or failure respect positive observation history", async () => {
    for (const runId of [initial.runResult.runId, "run:missing-before-presence", "run:presence"]) {
      assert.throws(() => prepareImportPresence(observed, fresh(next(), runId)), { code: "IMPORT_PRESENCE_RUN_ALREADY_RECORDED" });
    }
    const creation = bind(observed, fresh(initial, "run:presence")); creation.artifactId = id(861); creation.changeSetId = id(862);
    creation.runRequest.input.externalId = "other"; creation.runResult.output.externalIdentity.externalId = "other";
    assert.throws(() => prepareImportSnapshotCreation(observed, creation), { code: "IMPORT_SNAPSHOT_RUN_ALREADY_RECORDED" });
    const revision = bind(observed, { ...fresh(initial, "run:presence"), format: "morivyx.import-snapshot-revision/0.1",
      changeSetId: id(863), baselineArtifactRevision: base.elements[0].revision, resultingRevision: "graph:revision", recordedAt: "2026-09-08T20:00:00Z" });
    revision.runResult.output.digest = `sha256:${"2".repeat(64)}`;
    assert.throws(() => prepareImportSnapshotRevision(observed, revision), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
    const old = fresh(revision, "run:old-success"); old.runResult.output.retrievedAt = "2026-09-08T18:59:59.999999999Z";
    assert.throws(() => prepareImportSnapshotRevision(observed, old), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    const lost = bind(observed, { ...failureAuthoring, manifest: initial.manifest, runRequest: initial.runRequest,
      runResult: { ...initial.runResult, status: "failure", failure: { code: "REPOSITORY_IMPORT_TARGET_MISSING", message: "fixed" } },
      observationId: id(871), relationId: id(872), changeSetId: id(873), baselineArtifactRevision: base.elements[0].revision });
    delete lost.runResult.output;
    assert.throws(() => prepareImportAvailability(observed, fresh(lost, "run:presence")), { code: "IMPORT_AVAILABILITY_RUN_ALREADY_RECORDED" });
    assert.throws(() => prepareImportAvailability(observed, fresh(lost, "run:old-failure")), { code: "IMPORT_AVAILABILITY_TIME_REGRESSION" });
    const later = fresh(lost, "run:later-failure"); later.observedAt = "2026-09-08T19:00:01Z"; later.recordedAt = "2026-09-08T19:00:02Z";
    const path = join(root, "later-failure");
    await writeImportAvailabilityPackage({ basePath: observedPath, outputPath: path, request: later });
    const saved = await readGraphPackage(path); assert.equal((await validatePackage(path)).valid, true);
    for (const value of observed.elements) assert.deepEqual(saved.elements.find(x => x.id === value.id), value);
  });
  await check("new imported revision supersedes the old baseline but an observation does not", async () => {
    const revision = { ...fresh(initial, "run:revision"), format: "morivyx.import-snapshot-revision/0.1", changeSetId: id(881),
      baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision,
      resultingRevision: "graph:revised", recordedAt: "2026-09-08T18:00:00Z" };
    revision.runResult.output.digest = `sha256:${"2".repeat(64)}`; revision.runResult.output.retrievedAt = "2026-09-08T17:59:59Z";
    const path = join(root, "revised"); await writeReimportedSnapshotPackage({ basePath, outputPath: path, request: revision });
    const revised = await readGraphPackage(path);
    assert.throws(() => prepareImportPresence(revised, bind(revised, request())), { code: "IMPORT_PRESENCE_BASELINE_SUPERSEDED" });
    assert.throws(() => prepareImportPresence(revised, { ...bind(revised, fresh(request(), "run:revision")),
      baselineArtifactRevision: revised.elements[0].revision }), { code: "IMPORT_PRESENCE_RUN_ALREADY_RECORDED" });
    assert.equal(prepareImportPresence(revised, { ...bind(revised, request()), baselineArtifactRevision: revised.elements[0].revision }).comparison.status, "stale");
  });
  await check("human edits stay intact even when a changed external snapshot is observed", async () => {
    const edited = structuredClone(base.elements[0]); edited.attributes.uri = "urn:human:edited"; delete edited.extensions;
    edited.provenance.method = "asserted"; edited.revision = revisionId(edited);
    const rootDigest = graphRootDigest([edited]); const revision = { ...base.revision, id: "graph:human", parentRevision: base.revision.id, rootDigest };
    const changeSet = { format: "morivyx.changeset/0.1", id: id(891), baseRevision: base.revision.id, resultingRevision: revision.id,
      resultingRootDigest: rootDigest, schemaLockDigest: base.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: base.elements[0].revision, afterRevision: edited.revision }],
      provenance: edited.provenance, recordedAt: edited.provenance.recordedAt };
    const path = join(root, "human"); await writeAppliedPackage({ basePath, outputPath: path, changeSet, candidateElements: [edited], resultingRevision: revision });
    const human = await readGraphPackage(path); const original = await tree(path); const value = bind(human, request());
    value.runResult.output.digest = `sha256:${"2".repeat(64)}`;
    const destination = join(root, "human-observed");
    await writeImportPresencePackage({ basePath: path, outputPath: destination, request: value });
    const saved = await readGraphPackage(destination); assert.equal((await validatePackage(destination)).valid, true);
    assert.deepEqual(saved.elements.find(x => x.id === edited.id), edited);
    const record = saved.elements.find(x => x.id === value.observationId).extensions[IMPORT_PRESENCE_EXTENSION];
    assert.equal(record.comparison, "stale"); assert.equal(record.localStatus, "changed"); assert.equal(record.currentArtifactRevision, edited.revision);
    assert.deepEqual(await tree(path), original);
  });
  await check("GitHub fixed snapshots use the same success observation path", async () => {
    const github = structuredClone(initial); github.runRequest = await load("../test/fixtures/github-importer/request.json");
    github.runResult = await load("../test/fixtures/github-importer/result.json");
    github.manifest.identity.id = github.runResult.plugin.id; github.manifest.capabilities[0].id = github.runResult.capabilityId;
    github.manifest.capabilities[0].inputFormat = "morivyx.github-read-input/0.1"; github.manifest.capabilities[0].outputFormat = "morivyx.github-file-snapshot/0.1";
    const path = join(root, "github"); await writeImportedSnapshotPackage({ basePath: empty, outputPath: path, request: github });
    const base = await readGraphPackage(path); const value = bind(base, { ...authoring, manifest: github.manifest,
      runRequest: github.runRequest, runResult: github.runResult, baselineArtifactRevision: base.elements[0].revision });
    const current = fresh(value, "run:github-presence"); current.runResult.output.retrievedAt = "2026-09-08T18:59:59Z";
    const destination = join(root, "github-observed"); await writeImportPresencePackage({ basePath: path, outputPath: destination, request: current });
    const saved = await readGraphPackage(destination); assert.equal((await validatePackage(destination)).valid, true);
    assert.deepEqual(saved.elements.find(x => x.id === initial.artifactId), base.elements[0]);
    assert.equal(saved.elements.find(x => x.id === authoring.observationId).extensions[IMPORT_PRESENCE_EXTENSION].comparison, "current");
    const changed = fresh(current, "run:github-changed"); changed.runResult.output.digest = `sha256:${"2".repeat(64)}`;
    assert.throws(() => prepareImportPresence(base, changed), { code: "IMPORT_PRESENCE_COMPARISON_INVALID" });
    changed.runRequest.input.commit = "2".repeat(40); changed.runResult.output.source.commit = changed.runRequest.input.commit;
    changed.runResult.output.source.blobSha = "3".repeat(40); changed.runResult.output.byteLength = 1;
    const changedPath = join(root, "github-changed-observed");
    await writeImportPresencePackage({ basePath: path, outputPath: changedPath, request: changed });
    const changedPackage = await readGraphPackage(changedPath); assert.equal((await validatePackage(changedPath)).valid, true);
    assert.deepEqual(changedPackage.elements.find(x => x.id === initial.artifactId), base.elements[0]);
    assert.equal(changedPackage.elements.find(x => x.id === authoring.observationId).extensions[IMPORT_PRESENCE_EXTENSION].comparison, "stale");
  });
  await check("existing outputs invalid inputs and asynchronous caller mutation cannot overwrite data", async () => {
    await assert.rejects(writeImportPresencePackage(null), { code: "IMPORT_PRESENCE_REQUEST_INVALID" });
    await assert.rejects(writeImportPresencePackage({ basePath, outputPath: basePath, request: request() }), { code: "PACKAGE_OUTPUT_INVALID" });
    const original = await tree(observedPath);
    await assert.rejects(writeImportPresencePackage({ basePath, outputPath: observedPath, request: request() }), { code: "PACKAGE_OUTPUT_EXISTS" });
    assert.deepEqual(await tree(observedPath), original);
    const path = join(root, "rejected");
    await assert.rejects(writeImportPresencePackage({ basePath, outputPath: path, request: { ...request(), baseRevision: "graph:wrong" } }), { code: "IMPORT_PRESENCE_BASE_MISMATCH" });
    await assert.rejects(access(path), { code: "ENOENT" });
    const value = request(); const destination = join(root, "immutable");
    const pending = writeImportPresencePackage({ basePath, outputPath: destination, request: value }); value.actor = "invalid"; value.runResult.output.digest = "bad";
    await pending; assert.equal((await validatePackage(destination)).valid, true); assert.deepEqual(await tree(basePath), before);
    for (const bytes of Object.values(await tree(destination))) {
      const text = Buffer.from(bytes, "base64").toString("utf8");
      for (const forbidden of [root, "repositoryRoot", "documentText", "fixed missing"]) assert.equal(text.includes(forbidden), false);
    }
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 11);
console.log(`Import presence audit passed: ${checks} checks; current/stale success observations preserve Artifacts and history.`);
