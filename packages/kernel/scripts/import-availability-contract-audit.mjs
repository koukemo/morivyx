import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, revisionId, graphRootDigest } from "../src/canonical.js";
import { IMPORT_AVAILABILITY_EXTENSION, prepareImportAvailability,
  validateImportAvailabilityRequest, writeImportAvailabilityPackage } from "../src/import-availability.js";
import { writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { importRepositoryFile, validateRepositoryImportRequest } from "../src/repository-importer.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const initial = { ...await load("../test/fixtures/plugin-communication/import-authoring.json"),
  manifest: await load("../test/fixtures/plugin-manifest/repository-importer.json"),
  runRequest: await load("../test/fixtures/plugin-communication/request.json"),
  runResult: await load("../test/fixtures/plugin-communication/result.json") };
const authoring = await load("../test/fixtures/plugin-communication/import-availability-authoring.json");
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
const root = await mkdtemp(join(tmpdir(), "morivyx-availability-"));
try {
  const empty = join(root, "empty"); const basePath = join(root, "baseline");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  const source = join(root, "source"); await mkdir(source);
  const file = join(source, "source.txt"); await writeFile(file, "retained-snapshot-content\n");
  initial.runRequest.input.repositoryRoot = source;
  assert.equal(validateRepositoryImportRequest(initial.runRequest), initial.runRequest);
  initial.runResult = await importRepositoryFile(initial.runRequest, { now: () => "2026-09-08T15:00:00Z" });
  await writeImportedSnapshotPackage({ basePath: empty, outputPath: basePath, request: initial });
  const base = await readGraphPackage(basePath); const before = await tree(basePath);
  const missingRequest = structuredClone(initial.runRequest); missingRequest.runId = "run:missing";
  await rm(file); const missing = await importRepositoryFile(missingRequest);
  assert.equal(missing.failure.code, "REPOSITORY_IMPORT_TARGET_MISSING");
  const unavailableRequest = structuredClone(missingRequest); unavailableRequest.runId = "run:unavailable";
  await rm(source, { recursive: true }); const unavailable = await importRepositoryFile(unavailableRequest);
  assert.equal(unavailable.failure.code, "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE");
  const request = (lostSource = false) => structuredClone({ ...authoring, manifest: initial.manifest,
    runRequest: lostSource ? unavailableRequest : missingRequest, runResult: lostSource ? unavailable : missing,
    baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision });
  const reject = (value, code = "IMPORT_AVAILABILITY_REQUEST_INVALID") =>
    assert.throws(() => validateImportAvailabilityRequest(value), { code });

  await check("deterministic observation and relation only", () => {
    const input = request(); input.runResult.failure.message = `DO_NOT_STORE:${source}:credential-example`;
    const copy = canonicalJson(input); const artifact = canonicalJson(base.elements[0]);
    const prepared = prepareImportAvailability(base, input);
    assert.deepEqual(prepared, prepareImportAvailability(base, input));
    assert.deepEqual(prepared.candidateElements.map(x => x.type), ["core.observation", "core.observes"]);
    assert.deepEqual(prepared.changeSet.operations.map(x => x.op), ["create", "create"]);
    const [observation, relation] = prepared.candidateElements;
    for (const value of prepared.candidateElements) {
      assert.equal(value.lifecycle, "draft"); assert.equal(value.reviewState, "unreviewed");
      assert.equal(value.revision, revisionId(value));
    }
    assert.deepEqual(relation.attributes, { predicate: "observes", source: observation.id, target: initial.artifactId });
    const record = observation.extensions[IMPORT_AVAILABILITY_EXTENSION];
    assert.equal(record.status, "missing"); assert.equal(record.localStatus, "baseline");
    assert.deepEqual(record.previousImportSnapshot.snapshot, initial.runResult.output);
    assert.equal(record.failureCode, missing.failure.code); assert.equal(record.executionBinding, "not-verified");
    for (const text of [source, "DO_NOT_STORE", "credential-example", "retained-snapshot-content", "repositoryRoot"]) assert.equal(canonicalJson(prepared).includes(text), false);
    observation.extensions[IMPORT_AVAILABILITY_EXTENSION].status = "changed";
    assert.equal(prepared.changeSet.provenance.importAvailability.status, "missing");
    assert.equal(canonicalJson(input), copy); assert.equal(canonicalJson(base.elements[0]), artifact);
  });
  const paths = [];
  await check("real deletion and source disappearance saved distinctly", async () => {
    for (const lost of [false, true]) {
      const path = join(root, lost ? "unavailable" : "missing"); paths.push(path);
      const result = await writeImportAvailabilityPackage({ basePath, outputPath: path, request: request(lost) });
      assert.equal(result.status, lost ? "unavailable" : "missing");
      const restored = await readGraphPackage(path); assert.equal((await validatePackage(path)).valid, true);
      assert.deepEqual(restored.elements.find(x => x.id === initial.artifactId), base.elements[0]);
      assert.equal(restored.elements.length, base.elements.length + 2);
      assert.deepEqual(await tree(basePath), before);
    }
  });
  await check("strict roots identifiers and timestamps", () => {
    for (const value of [undefined, null, [], true, 1, "x", 1n, new Proxy({}, {})]) reject(value);
    for (const [key, value] of [["format", "bad"], ["artifactId", "bad"], ["observationId", authoring.relationId],
      ["baseRevision", "bad"], ["baselineArtifactRevision", "bad"], ["resultingRevision", base.revision.id],
      ["observedAt", "2026-02-30T00:00:00Z"], ["recordedAt", "2026-09-08T16:00:00Z"], ["extra", true]]) reject({ ...request(), [key]: value });
    const missingField = request(); delete missingField.relationId; reject(missingField);
    const cyclic = request(); cyclic.self = cyclic; reject(cyclic);
    let reads = 0; const getter = request(); Object.defineProperty(getter, "runResult", { enumerable: true, get() { reads++; throw Error(); } });
    reject(getter); assert.equal(reads, 0);
    const large = request(); large.runResult.failure.message = "x".repeat(1048576); reject(large, "IMPORT_AVAILABILITY_INPUT_LIMIT");
  });
  await check("successful mismatched and unknown results cannot be observations", () => {
    const success = request(); success.runRequest = initial.runRequest; success.runResult = initial.runResult; reject(success);
    for (const mutate of [x => { x.runResult.runId = "wrong"; }, x => { x.manifest.identity.id = "wrong"; },
      x => { x.manifest.capabilities[0].outputFormat = "wrong/0.1"; },
      x => { x.runRequest.input.locator = "../escape"; }, x => { x.runRequest.input.secret = "not-allowed"; }]) {
      const input = request(); mutate(input); reject(input);
    }
    const unknown = request(); unknown.runResult.failure.code = "DO_NOT_STORE_UNKNOWN";
    assert.throws(() => prepareImportAvailability(base, unknown), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
  });
  await check("base target schema and record collisions", () => {
    assert.throws(() => prepareImportAvailability(null, request()), { code: "IMPORT_AVAILABILITY_PACKAGE_INVALID" });
    assert.throws(() => prepareImportAvailability(base, { ...request(), baseRevision: "graph:stale" }), { code: "IMPORT_AVAILABILITY_BASE_MISMATCH" });
    const absent = structuredClone(base); absent.elements = [];
    assert.throws(() => prepareImportAvailability(absent, request()), { code: "IMPORT_AVAILABILITY_TARGET_INVALID" });
    const noSchema = structuredClone(base); noSchema.schemaLock.schemas = [];
    assert.throws(() => prepareImportAvailability(noSchema, request()), { code: "IMPORT_AVAILABILITY_SCHEMA_MISSING" });
    for (const id of [authoring.observationId, authoring.relationId, authoring.changeSetId]) {
      const collided = structuredClone(base); collided.approvals.push({ id });
      assert.throws(() => prepareImportAvailability(collided, request()), { code: "IMPORT_AVAILABILITY_ID_EXISTS" });
    }
  });
  await check("baseline record and external identity remain bound", () => {
    const none = structuredClone(base); none.changeSets = [];
    assert.throws(() => prepareImportAvailability(none, request()), { code: "IMPORT_AVAILABILITY_BASELINE_UNRECORDED" });
    const corrupt = structuredClone(base); corrupt.changeSets[0].provenance.importSnapshot.informationLoss = [];
    assert.throws(() => prepareImportAvailability(corrupt, request()), { code: "IMPORT_AVAILABILITY_BASELINE_INVALID" });
    const other = request(); other.runRequest.input.externalId = "other";
    assert.throws(() => prepareImportAvailability(base, other), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
  });
  await check("superseded successful snapshot is not the last successful baseline", async () => {
    const revision = { ...structuredClone(initial), format: "morivyx.import-snapshot-revision/0.1",
      changeSetId: authoring.changeSetId.replace("0813", "0863"), baseRevision: base.revision.id,
      baseRootDigest: base.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision,
      resultingRevision: "graph:updated-import", recordedAt: "2026-09-08T16:30:00Z" };
    revision.runRequest.runId = "run:updated-import"; revision.runResult.runId = revision.runRequest.runId;
    revision.runResult.output.digest = `sha256:${"2".repeat(64)}`;
    revision.runResult.output.retrievedAt = "2026-09-08T16:29:00Z";
    const path = join(root, "updated-import");
    await writeReimportedSnapshotPackage({ basePath, outputPath: path, request: revision });
    const updated = await readGraphPackage(path); const input = request();
    input.baseRevision = updated.revision.id; input.baseRootDigest = updated.revision.rootDigest;
    assert.throws(() => prepareImportAvailability(updated, input), { code: "IMPORT_AVAILABILITY_BASELINE_SUPERSEDED" });
    input.baselineArtifactRevision = updated.elements[0].revision;
    const prepared = prepareImportAvailability(updated, input);
    assert.equal(prepared.changeSet.provenance.importAvailability.previousImportSnapshot.snapshot.digest,
      revision.runResult.output.digest);
    const destination = join(root, "updated-observed");
    await writeImportAvailabilityPackage({ basePath: path, outputPath: destination, request: input });
    assert.equal((await validatePackage(destination)).valid, true);
    assert.deepEqual((await readGraphPackage(destination)).elements.find(x => x.id === initial.artifactId), updated.elements[0]);
  });
  await check("time cannot regress past import or earlier observation", async () => {
    const early = request(); early.observedAt = "2026-09-08T15:59:59.999999999Z";
    assert.throws(() => prepareImportAvailability(base, early), { code: "IMPORT_AVAILABILITY_TIME_REGRESSION" });
    const value = await readGraphPackage(paths[0]); const next = request(true);
    next.baseRevision = value.revision.id; next.baseRootDigest = value.revision.rootDigest;
    next.observationId = next.observationId.replace("0811", "0821"); next.relationId = next.relationId.replace("0812", "0822");
    next.changeSetId = next.changeSetId.replace("0813", "0823"); next.resultingRevision = "graph:observation-next";
    next.observedAt = "2026-09-08T16:59:59.999Z";
    assert.throws(() => prepareImportAvailability(value, next), { code: "IMPORT_AVAILABILITY_TIME_REGRESSION" });
    next.observedAt = authoring.observedAt; next.recordedAt = authoring.observedAt;
    assert.throws(() => prepareImportAvailability(value, next), { code: "IMPORT_AVAILABILITY_TIME_REGRESSION" });
    next.recordedAt = authoring.recordedAt;
    const path = join(root, "second-observation");
    await writeImportAvailabilityPackage({ basePath: paths[0], outputPath: path, request: next });
    assert.equal((await validatePackage(path)).valid, true);
    assert.deepEqual((await readGraphPackage(path)).elements.find(x => x.id === initial.artifactId), base.elements[0]);
  });
  await check("Run identity reuse is denied across success and failure paths", async () => {
    const reused = request(); reused.runRequest.runId = initial.runRequest.runId; reused.runResult.runId = initial.runResult.runId;
    assert.throws(() => prepareImportAvailability(base, reused), { code: "IMPORT_AVAILABILITY_RUN_ALREADY_RECORDED" });
    const observed = await readGraphPackage(paths[0]); const again = request();
    Object.assign(again, { baseRevision: observed.revision.id, baseRootDigest: observed.revision.rootDigest,
      resultingRevision: "graph:again", observationId: authoring.observationId.replace("0811", "0831"),
      relationId: authoring.relationId.replace("0812", "0832"), changeSetId: authoring.changeSetId.replace("0813", "0833") });
    assert.throws(() => prepareImportAvailability(observed, again), { code: "IMPORT_AVAILABILITY_RUN_ALREADY_RECORDED" });
    for (const runId of [initial.runResult.runId, missing.runId]) {
      const creation = structuredClone(initial);
      Object.assign(creation, { artifactId: initial.artifactId.replace("0801", "0841"), changeSetId: initial.changeSetId.replace("0802", "0842"),
        baseRevision: observed.revision.id, baseRootDigest: observed.revision.rootDigest, resultingRevision: "graph:new-artifact" });
      creation.runRequest.runId = runId; creation.runResult.runId = runId;
      creation.runRequest.input.externalId = "different"; creation.runResult.output.externalIdentity.externalId = "different";
      await assert.rejects(writeImportedSnapshotPackage({ basePath: paths[0], outputPath: join(root, "reuse-create"), request: creation }), { code: "IMPORT_SNAPSHOT_RUN_ALREADY_RECORDED" });
    }
    const revision = { ...initial, format: "morivyx.import-snapshot-revision/0.1", changeSetId: authoring.changeSetId.replace("0813", "0853"),
      baseRevision: observed.revision.id, baseRootDigest: observed.revision.rootDigest, baselineArtifactRevision: base.elements[0].revision,
      resultingRevision: "graph:reuse-update", runRequest: structuredClone(initial.runRequest), runResult: structuredClone(initial.runResult) };
    revision.runRequest.runId = missing.runId; revision.runResult.runId = missing.runId;
    revision.runResult.output.digest = `sha256:${"2".repeat(64)}`;
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: paths[0], outputPath: join(root, "reuse-update"), request: revision }), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
    revision.runRequest.runId = "run:backdated-success"; revision.runResult.runId = revision.runRequest.runId;
    revision.runResult.output.retrievedAt = "2026-09-08T16:59:59.999999999Z"; revision.recordedAt = "2026-09-08T18:00:00Z";
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: paths[0], outputPath: join(root, "backdated-update"), request: revision }), { code: "IMPORT_REVISION_TIME_REGRESSION" });
  });
  await check("simulated human edit stays unchanged while observation records both revisions", async () => {
    const edited = structuredClone(base.elements[0]); edited.attributes.uri = "urn:human:edited";
    edited.provenance.method = "asserted"; delete edited.extensions; edited.revision = revisionId(edited);
    const digest = graphRootDigest([edited]); const path = join(root, "human-edited");
    const revision = { ...base.revision, id: "graph:human-edited", parentRevision: base.revision.id, rootDigest: digest };
    const changeSet = { format: "morivyx.changeset/0.1", id: authoring.changeSetId.replace("0813", "0990"),
      baseRevision: base.revision.id, resultingRevision: revision.id, resultingRootDigest: digest,
      schemaLockDigest: base.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: base.elements[0].revision, afterRevision: edited.revision }],
      provenance: { method: "asserted", actor: authoring.actor, recordedAt: authoring.recordedAt }, recordedAt: authoring.recordedAt };
    await writeAppliedPackage({ basePath, outputPath: path, changeSet, candidateElements: [edited], resultingRevision: revision });
    const input = request(); input.baseRevision = revision.id; input.baseRootDigest = digest;
    const destination = join(root, "human-observed"); const original = await tree(path);
    await writeImportAvailabilityPackage({ basePath: path, outputPath: destination, request: input });
    const restored = await readGraphPackage(destination);
    assert.deepEqual(restored.elements.find(x => x.id === edited.id), edited);
    const observation = restored.elements.find(x => x.id === authoring.observationId);
    assert.equal(observation.attributes.value.localStatus, "changed");
    assert.equal(observation.attributes.value.currentArtifactRevision, edited.revision);
    assert.equal(observation.attributes.value.baselineArtifactRevision, base.elements[0].revision);
    assert.deepEqual(await tree(path), original); assert.equal((await validatePackage(destination)).valid, true);
  });
  await check("output collision invalid request and caller mutation", async () => {
    const original = await tree(paths[0]);
    await assert.rejects(writeImportAvailabilityPackage({ basePath, outputPath: paths[0], request: request() }), { code: "PACKAGE_OUTPUT_EXISTS" });
    assert.deepEqual(await tree(paths[0]), original);
    const rejected = join(root, "rejected");
    await assert.rejects(writeImportAvailabilityPackage({ basePath, outputPath: rejected, request: { ...request(), baseRevision: "graph:stale" } }), { code: "IMPORT_AVAILABILITY_BASE_MISMATCH" });
    await assert.rejects(access(rejected), { code: "ENOENT" });
    await assert.rejects(writeImportAvailabilityPackage(null), { code: "IMPORT_AVAILABILITY_REQUEST_INVALID" });
    const input = request(); const destination = join(root, "immutable");
    const pending = writeImportAvailabilityPackage({ basePath, outputPath: destination, request: input });
    input.runResult.failure.code = "not-valid"; input.actor = "bad";
    await pending; assert.equal((await validatePackage(destination)).valid, true);
    assert.deepEqual(await tree(basePath), before);
  });
  await check("GitHub missing unavailable and same-commit contradiction", async () => {
    const creation = structuredClone(initial);
    creation.runRequest = await load("../test/fixtures/github-importer/request.json");
    creation.runResult = await load("../test/fixtures/github-importer/result.json");
    creation.manifest.identity.id = creation.runResult.plugin.id;
    Object.assign(creation.manifest.capabilities[0], { id: creation.runResult.capabilityId,
      inputFormat: "morivyx.github-read-input/0.1", outputFormat: "morivyx.github-file-snapshot/0.1" });
    const path = join(root, "github-base");
    await writeImportedSnapshotPackage({ basePath: empty, outputPath: path, request: creation });
    const value = await readGraphPackage(path);
    const input = { ...request(), manifest: creation.manifest, runRequest: structuredClone(creation.runRequest),
      runResult: { format: "morivyx.plugin-run-result/0.1", plugin: creation.runResult.plugin,
        capabilityId: creation.runResult.capabilityId, runId: "run:github-missing", status: "failure",
        failure: { code: "GITHUB_IMPORT_TARGET_MISSING", message: "PRIVATE_UNTRUSTED_MESSAGE" } },
      baseRevision: value.revision.id, baseRootDigest: value.revision.rootDigest, baselineArtifactRevision: value.elements[0].revision };
    input.runRequest.runId = input.runResult.runId;
    assert.throws(() => prepareImportAvailability(value, input), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
    input.runRequest.input.commit = "2".repeat(40);
    for (const [code, status] of [["GITHUB_IMPORT_TARGET_MISSING", "missing"], ["GITHUB_IMPORT_SOURCE_UNAVAILABLE", "unavailable"]]) {
      input.runResult.failure.code = code; const destination = join(root, `github-${status}`);
      await writeImportAvailabilityPackage({ basePath: path, outputPath: destination, request: input });
      const restored = await readGraphPackage(destination);
      const record = restored.elements.find(x => x.id === authoring.observationId).extensions[IMPORT_AVAILABILITY_EXTENSION];
      assert.equal(record.status, status); assert.equal(record.attemptedSource.commit, "2".repeat(40));
      assert.equal(record.previousImportSnapshot.snapshot.source.commit, "1".repeat(40));
      assert.equal(canonicalJson(restored.elements).includes("PRIVATE_UNTRUSTED_MESSAGE"), false);
      assert.deepEqual(restored.elements.find(x => x.id === initial.artifactId), value.elements[0]);
      assert.equal((await validatePackage(destination)).valid, true);
    }
    input.runResult.failure.code = "GITHUB_IMPORT_TIMEOUT";
    assert.equal(prepareImportAvailability(value, input).comparison.status, "unavailable");
    input.runResult.failure.code = "UNRECOGNIZED_SECRET_CODE";
    assert.throws(() => prepareImportAvailability(value, input), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 12);
console.log(`Import availability audit passed: ${checks} checks; deletion and unavailability remain distinct without changing Artifact.`);
