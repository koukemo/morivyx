import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, graphRootDigest, revisionId } from "../src/canonical.js";
import { runPluginProcess } from "../src/plugin-communication.js";
import { validateOpenApiImportResult } from "../src/openapi-importer.js";
import { prepareImportSnapshotCreation, writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { prepareImportAvailability, writeImportAvailabilityPackage } from "../src/import-availability.js";
import { prepareImportPresence, writeImportPresencePackage } from "../src/import-presence.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const authoring = await load("../test/fixtures/plugin-communication/import-authoring.json");
const availability = await load("../test/fixtures/plugin-communication/import-availability-authoring.json");
const manifest = await load("../test/fixtures/openapi-importer/manifest.json");
const fixed = await load("../test/fixtures/openapi-importer/request.json");
const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { id: manifest.identity.id, version: manifest.identity.version, packageDigest: manifest.identity.packageDigest },
  capability: { id: manifest.capabilities[0].id, effect: "pure", permissions: manifest.capabilities[0].permissions, resources: manifest.capabilities[0].resources } };
const id = value => `urn:uuid:00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const root = await mkdtemp(join(tmpdir(), "morivyx-openapi-core-"));
let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
async function tree(root) {
  const entries = {};
  async function walk(path, prefix = "") {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isDirectory()) await walk(join(path, item.name), `${relative}/`);
      else entries[relative] = (await readFile(join(path, item.name))).toString("base64");
    }
  }
  await walk(root); return entries;
}
async function noSource(path) {
  for (const bytes of Object.values(await tree(path))) {
    const text = Buffer.from(bytes, "base64").toString("utf8");
    for (const source of ["documentText", "PRIVATE_SOURCE_DESCRIPTION", "PRIVATE_HEADER_NAME", "invalid.example.test", root]) assert.equal(text.includes(source), false);
  }
}
try {
  const empty = join(root, "empty"); const runtime = join(root, "runtime"); const external = join(root, "external.json");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  await mkdir(join(runtime, "node_modules"), { recursive: true });
  await cp(new URL("../src", import.meta.url), join(runtime, "src"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(runtime, "package.json"));
  await cp(new URL("../node_modules/yaml", import.meta.url), join(runtime, "node_modules/yaml"), { recursive: true });
  await writeFile(external, fixed.input.documentText);
  async function run(runId, time) {
    const before = await readFile(external, "utf8"); const runRequest = structuredClone(fixed);
    runRequest.runId = runId; runRequest.input.documentText = before;
    const source = `import {importOpenApiOperation,validateOpenApiImportResult} from ${JSON.stringify(pathToFileURL(join(runtime, "src/openapi-importer.js")).href)};
import {servePluginStdio} from ${JSON.stringify(pathToFileURL(join(runtime, "src/plugin-stdio.js")).href)};
const r=await servePluginStdio({handleRequest:q=>importOpenApiOperation(q,{now:()=>${JSON.stringify(time)}}),validateResult:validateOpenApiImportResult});process.exitCode=r.exitCode;`;
    const runResult = runPluginProcess({ command: process.execPath, args: ["--input-type=module", "--eval", source], manifest, policy, request: runRequest });
    validateOpenApiImportResult(runResult, runRequest); assert.equal(await readFile(external, "utf8"), before);
    return { runRequest, runResult };
  }
  const first = await run("run:openapi-initial", "2026-09-08T18:40:00.900Z");
  const create = { ...authoring, ...first, manifest, resultingRevision: "graph:openapi-initial", recordedAt: "2026-09-08T18:40:01Z" };
  const initialPath = join(root, "initial"); let initial;
  await check("real Plugin result saved as one unreviewed API operation Artifact", async () => {
    const before = await tree(empty); const prepared = prepareImportSnapshotCreation(await readGraphPackage(empty), create);
    assert.equal(prepared.candidateElement.attributes.artifactKind, "api-operation");
    assert.equal(prepared.candidateElement.attributes.uri,
      "urn:morivyx:openapi-operation:openapi%3Afixture:%2Fpaths%2F~1widgets~1%7Bid%7D%2Fget");
    await writeImportedSnapshotPackage({ basePath: empty, outputPath: initialPath, request: create });
    initial = await readGraphPackage(initialPath); assert.equal((await validatePackage(initialPath)).valid, true);
    assert.equal(initial.elements.length, 1); assert.equal(initial.elements[0].lifecycle, "draft"); assert.equal(initial.elements[0].reviewState, "unreviewed");
    assert.equal(initial.approvals.length, 0);
    const saved = initial.elements[0].extensions["morivyx.import/snapshot"];
    assert.equal(canonicalJson(saved.snapshot), canonicalJson(first.runResult.output));
    assert.equal(saved.executionBinding, "not-verified"); assert.deepEqual(saved.informationLoss, first.runResult.output.informationLoss);
    assert.deepEqual(await tree(empty), before); await noSource(initialPath);
  });
  const changed = JSON.parse(fixed.input.documentText); changed.paths[fixed.input.path].get.operationId = "readWidgetV2";
  await writeFile(external, JSON.stringify(changed)); const second = await run("run:openapi-second", "2026-09-08T18:41:00Z");
  const revise = { ...create, ...second, format: "morivyx.import-snapshot-revision/0.1", changeSetId: id(803),
    baseRevision: initial.revision.id, baseRootDigest: initial.revision.rootDigest, baselineArtifactRevision: initial.elements[0].revision,
    resultingRevision: "graph:openapi-updated", recordedAt: "2026-09-08T18:41:01Z" };
  const updatedPath = join(root, "updated"); let updated;
  await check("successful update restores the baseline without retaining or fabricating old source", async () => {
    const before = await tree(initialPath); const prepared = prepareImportSnapshotRevision(initial, revise);
    assert.equal(prepared.comparison.status, "stale"); assert.equal(prepared.changeSet.operations[0].op, "revise");
    assert.equal(prepared.changeSet.operations[0].beforeRevision, initial.elements[0].revision);
    await writeReimportedSnapshotPackage({ basePath: initialPath, outputPath: updatedPath, request: revise });
    updated = await readGraphPackage(updatedPath); assert.equal((await validatePackage(updatedPath)).valid, true);
    assert.equal(updated.elements[0].id, initial.elements[0].id); assert.equal(updated.elements[0].attributes.uri, initial.elements[0].attributes.uri);
    assert.notEqual(updated.elements[0].revision, initial.elements[0].revision);
    assert.equal(updated.elements[0].extensions["morivyx.import/snapshot"].snapshot.operation.operationId, "readWidgetV2");
    assert.deepEqual(await tree(initialPath), before); await noSource(updatedPath);
  });
  const missingDocument = JSON.parse(fixed.input.documentText); missingDocument.paths = {};
  await writeFile(external, JSON.stringify(missingDocument)); const missing = await run("run:openapi-missing", "2026-09-08T18:42:00Z");
  const observe = { ...availability, ...missing, manifest, baseRevision: updated.revision.id, baseRootDigest: updated.revision.rootDigest,
    baselineArtifactRevision: updated.elements[0].revision, observedAt: "2026-09-08T18:42:00Z", recordedAt: "2026-09-08T18:42:01Z" };
  const observedPath = join(root, "observed"); let observed;
  await check("recomputed disappearance adds observations without changing the Artifact", async () => {
    const before = await tree(updatedPath); const prepared = prepareImportAvailability(updated, observe);
    assert.equal(prepared.comparison.status, "missing");
    const record = prepared.changeSet.provenance.importAvailability;
    assert.deepEqual(record.attemptedSource, { system: "openapi", externalId: fixed.input.externalId, path: fixed.input.path, method: "get",
      documentDigest: prepared.comparison.current.documentDigest, digestRule: "sha256-utf8-document" });
    await writeImportAvailabilityPackage({ basePath: updatedPath, outputPath: observedPath, request: observe });
    observed = await readGraphPackage(observedPath); assert.equal((await validatePackage(observedPath)).valid, true);
    assert.deepEqual(observed.elements.find(x => x.id === create.artifactId), updated.elements[0]);
    assert.equal(observed.elements.length, 3); assert.equal(observed.approvals.length, 0);
    assert.deepEqual(await tree(updatedPath), before); await noSource(observedPath);
  });
  const presencePath = join(root, "presence"); let presence;
  await check("same source reappearance is saved by a real process without revising the Artifact", async () => {
    await writeFile(external, second.runRequest.input.documentText);
    const current = await run("run:openapi-same-return", "2026-09-08T18:42:30.000000001Z");
    presence = { ...observe, ...current, format: "morivyx.import-presence/0.1", baseRevision: observed.revision.id,
      baseRootDigest: observed.revision.rootDigest, observationId: id(841), relationId: id(842), changeSetId: id(843),
      resultingRevision: "graph:openapi-present", observedAt: "2026-09-08T18:42:30.000000002Z", recordedAt: "2026-09-08T18:42:31Z" };
    const before = await tree(observedPath);
    const result = await writeImportPresencePackage({ basePath: observedPath, outputPath: presencePath, request: presence });
    assert.equal(result.status, "available"); assert.equal(result.comparison, "current");
    const saved = await readGraphPackage(presencePath); assert.equal((await validatePackage(presencePath)).valid, true);
    for (const value of observed.elements) assert.deepEqual(saved.elements.find(x => x.id === value.id), value);
    assert.equal(saved.elements.length, observed.elements.length + 2); assert.equal(saved.approvals.length, 0);
    assert.deepEqual(await tree(observedPath), before); await noSource(presencePath);
  });
  const returned = JSON.parse(fixed.input.documentText); returned.paths[fixed.input.path].get.operationId = "readWidgetV3";
  await writeFile(external, JSON.stringify(returned)); const third = await run("run:openapi-third", "2026-09-08T18:43:00Z");
  const restore = { ...revise, ...third, changeSetId: id(804), baseRevision: observed.revision.id, baseRootDigest: observed.revision.rootDigest,
    baselineArtifactRevision: updated.elements[0].revision, resultingRevision: "graph:openapi-returned", recordedAt: "2026-09-08T18:43:01Z" };
  const restoredPath = join(root, "returned");
  const changedPresencePath = join(root, "changed-presence");
  await check("changed reappearance is an observation and later updates respect the observed time", async () => {
    const base = await readGraphPackage(presencePath);
    const current = { ...presence, ...third, baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest,
      observationId: id(851), relationId: id(852), changeSetId: id(853), resultingRevision: "graph:openapi-changed-presence",
      observedAt: "2026-09-08T18:43:00.000000002Z", recordedAt: "2026-09-08T18:43:01Z" };
    const before = await tree(presencePath);
    const result = await writeImportPresencePackage({ basePath: presencePath, outputPath: changedPresencePath, request: current });
    assert.equal(result.comparison, "stale");
    const saved = await readGraphPackage(changedPresencePath); assert.equal((await validatePackage(changedPresencePath)).valid, true);
    for (const value of base.elements) assert.deepEqual(saved.elements.find(x => x.id === value.id), value);
    assert.deepEqual(await tree(presencePath), before); await noSource(changedPresencePath);
    const early = structuredClone(current); early.runRequest.runId = "run:early-presence"; early.runResult.runId = early.runRequest.runId;
    early.observationId = id(861); early.relationId = id(862); early.changeSetId = id(863); early.resultingRevision = "graph:early-presence";
    early.baseRevision = saved.revision.id; early.baseRootDigest = saved.revision.rootDigest;
    early.runResult.output.retrievedAt = "2026-09-08T18:43:00.000000001Z";
    assert.throws(() => prepareImportPresence(saved, early), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
    const update = { ...restore, baseRevision: saved.revision.id, baseRootDigest: saved.revision.rootDigest,
      runRequest: structuredClone(restore.runRequest), runResult: structuredClone(restore.runResult) };
    update.runRequest.runId = "run:after-presence"; update.runResult.runId = update.runRequest.runId;
    assert.throws(() => prepareImportSnapshotRevision(saved, update), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    update.runResult.output.retrievedAt = "2026-09-08T18:43:02Z"; update.recordedAt = "2026-09-08T18:43:03Z";
    const destination = join(root, "revision-after-presence");
    await writeReimportedSnapshotPackage({ basePath: changedPresencePath, outputPath: destination, request: update });
    assert.equal((await validatePackage(destination)).valid, true);
  });
  await check("a later changed success follows the disappearance without destroying history", async () => {
    const before = await tree(observedPath);
    await writeReimportedSnapshotPackage({ basePath: observedPath, outputPath: restoredPath, request: restore });
    const restored = await readGraphPackage(restoredPath); assert.equal((await validatePackage(restoredPath)).valid, true);
    assert.equal(restored.elements.length, observed.elements.length);
    assert.equal(restored.elements.find(x => x.id === create.artifactId).extensions["morivyx.import/snapshot"].snapshot.operation.operationId, "readWidgetV3");
    for (const value of observed.elements.filter(x => x.id !== create.artifactId)) assert.deepEqual(restored.elements.find(x => x.id === value.id), value);
    assert.deepEqual(await tree(observedPath), before); await noSource(restoredPath);
  });
  await check("successful reimport cannot regress past a saved observation", () => {
    const early = structuredClone(restore); early.runResult.output.retrievedAt = "2026-09-08T18:41:59.999999999Z";
    assert.throws(() => prepareImportSnapshotRevision(observed, early), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    early.runResult.output.retrievedAt = observe.observedAt; early.recordedAt = observe.observedAt;
    assert.throws(() => prepareImportSnapshotRevision(observed, early), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    const malformed = structuredClone(observed);
    malformed.changeSets.find(x => x.provenance.importAvailability).provenance.importAvailability.observedAt = ["1900-01-01T00:00:00Z"];
    assert.throws(() => prepareImportSnapshotRevision(malformed, restore), { code: "IMPORT_REVISION_TIME_REGRESSION" });
  });
  await check("human edits remain protected for updates and preserved by observations", async () => {
    const edited = structuredClone(updated.elements[0]); edited.attributes.uri = "urn:human:edited"; delete edited.extensions;
    edited.provenance = { method: "asserted", actor: authoring.actor, recordedAt: "2026-09-08T18:41:30Z" }; edited.revision = revisionId(edited);
    const rootDigest = graphRootDigest([edited]); const revision = { ...updated.revision, id: "graph:openapi-human", parentRevision: updated.revision.id, rootDigest };
    const changeSet = { format: "morivyx.changeset/0.1", id: id(899), baseRevision: updated.revision.id, resultingRevision: revision.id,
      resultingRootDigest: rootDigest, schemaLockDigest: updated.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: updated.elements[0].revision, afterRevision: edited.revision }],
      provenance: edited.provenance, recordedAt: edited.provenance.recordedAt };
    const path = join(root, "human"); await writeAppliedPackage({ basePath: updatedPath, outputPath: path, changeSet, candidateElements: [edited], resultingRevision: revision });
    const human = await readGraphPackage(path); const before = await tree(path);
    const updateRequest = { ...restore, baseRevision: revision.id, baseRootDigest: rootDigest };
    assert.throws(() => prepareImportSnapshotRevision(human, updateRequest), { code: "IMPORT_REVISION_LOCAL_CONFLICT" });
    updateRequest.baselineArtifactRevision = edited.revision;
    assert.throws(() => prepareImportSnapshotRevision(human, updateRequest), { code: "IMPORT_REVISION_BASELINE_UNRECORDED" });
    const destination = join(root, "human-observed"); const observation = { ...observe, baseRevision: revision.id, baseRootDigest: rootDigest };
    await writeImportAvailabilityPackage({ basePath: path, outputPath: destination, request: observation });
    const output = await readGraphPackage(destination); assert.equal((await validatePackage(destination)).valid, true);
    assert.deepEqual(output.elements.find(x => x.id === edited.id), edited);
    const record = output.elements.find(x => x.id === observe.observationId).extensions["morivyx.import/availability"];
    assert.equal(record.localStatus, "changed"); assert.equal(record.baselineArtifactRevision, updated.elements[0].revision); assert.equal(record.currentArtifactRevision, edited.revision);
    assert.deepEqual(await tree(path), before); await noSource(destination);
  });
  await check("invalid baseline records capabilities and fabricated missing results are rejected", () => {
    for (const runResult of [null, {}, { plugin: {} }, { ...first.runResult, plugin: { id: "__proto__", version: "0.1.0" } }]) {
      assert.throws(() => prepareImportSnapshotCreation(initial, { ...create, runResult }), { code: "IMPORT_SNAPSHOT_RESULT_INVALID" });
    }
    for (const mutate of [x => { x.provenance.importSnapshot.informationLoss = []; },
      x => { x.provenance.actor = [authoring.actor]; }, x => { x.provenance.recordedAt = [create.recordedAt]; },
      x => { x.provenance.recordedAt = "1900-01-01T00:00:00Z"; }, x => { x.provenance.importSnapshot.snapshot.informationLoss = []; }]) {
      const value = structuredClone(initial); mutate(value.changeSets[0]);
      assert.throws(() => prepareImportSnapshotRevision(value, revise), { code: "IMPORT_REVISION_BASELINE_INVALID" });
    }
    for (const mutate of [x => { x.manifest.capabilities[0].effect = "read-only"; }, x => { x.manifest.capabilities[0].inputFormat = "other/0.1"; },
      x => { x.runResult.output.digest = `sha256:${"2".repeat(64)}`; }]) {
      const value = structuredClone(create); mutate(value);
      assert.throws(() => prepareImportSnapshotCreation(initial, value), { code: "IMPORT_SNAPSHOT_RESULT_INVALID" });
    }
    const forged = structuredClone(observe); forged.runRequest.input.documentText = second.runRequest.input.documentText;
    assert.throws(() => prepareImportAvailability(updated, forged), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
    const old = { ...observe, baselineArtifactRevision: initial.elements[0].revision };
    assert.throws(() => prepareImportAvailability(updated, old), { code: "IMPORT_AVAILABILITY_BASELINE_SUPERSEDED" });
  });
  await check("saved Run identities and record IDs cannot be reused", () => {
    const value = structuredClone(restore); value.runRequest.runId = missing.runRequest.runId; value.runResult.runId = value.runRequest.runId;
    assert.throws(() => prepareImportSnapshotRevision(observed, value), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
    const repeated = { ...observe, baseRevision: observed.revision.id, baseRootDigest: observed.revision.rootDigest,
      observationId: id(821), relationId: id(822), changeSetId: id(823), resultingRevision: "graph:openapi-repeated" };
    assert.throws(() => prepareImportAvailability(observed, repeated), { code: "IMPORT_AVAILABILITY_RUN_ALREADY_RECORDED" });
    const creation = { ...create, ...structuredClone(third), artifactId: id(831), changeSetId: id(832), baseRevision: observed.revision.id,
      baseRootDigest: observed.revision.rootDigest, recordedAt: restore.recordedAt };
    creation.runRequest.input.externalId = "openapi:other"; creation.runResult.output.externalIdentity.externalId = "openapi:other";
    creation.runRequest.runId = missing.runRequest.runId; creation.runResult.runId = creation.runRequest.runId;
    assert.throws(() => prepareImportSnapshotCreation(observed, creation), { code: "IMPORT_SNAPSHOT_RUN_ALREADY_RECORDED" });
    assert.throws(() => prepareImportAvailability(observed, { ...observe, baseRevision: observed.revision.id,
      baseRootDigest: observed.revision.rootDigest, resultingRevision: "graph:collided-observation" }), { code: "IMPORT_AVAILABILITY_ID_EXISTS" });
  });
  await check("existing outputs invalid requests and post-await caller mutation are safe", async () => {
    const before = await tree(initialPath);
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initialPath, outputPath: initialPath, request: revise }), { code: "PACKAGE_OUTPUT_INVALID" });
    const originalOutput = await tree(updatedPath);
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initialPath, outputPath: updatedPath, request: revise }), { code: "PACKAGE_OUTPUT_EXISTS" });
    assert.deepEqual(await tree(updatedPath), originalOutput);
    const rejected = join(root, "rejected");
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initialPath, outputPath: rejected, request: { ...revise, baseRevision: "graph:wrong" } }), { code: "IMPORT_REVISION_BASE_MISMATCH" });
    await assert.rejects(access(rejected), { code: "ENOENT" });
    const copied = structuredClone(revise); const destination = join(root, "immutable");
    const pending = writeReimportedSnapshotPackage({ basePath: initialPath, outputPath: destination, request: copied });
    copied.runRequest.input.documentText = "{}"; copied.actor = "invalid";
    await pending; assert.equal((await validatePackage(destination)).valid, true); assert.deepEqual(await tree(initialPath), before);
  });
  await check("removing the owned Plugin runtime and original input preserves every saved package", async () => {
    const paths = [initialPath, updatedPath, observedPath, restoredPath, presencePath, changedPresencePath]; const originals = await Promise.all(paths.map(tree));
    await rm(runtime, { recursive: true }); await rm(external);
    for (const [index, path] of paths.entries()) {
      assert.equal((await validatePackage(path)).valid, true); await readGraphPackage(path);
      assert.deepEqual(await tree(path), originals[index]); await noSource(path);
    }
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 12);
console.log(`OpenAPI Core audit passed: ${checks} checks; real process import/update/disappearance and retained human edits verified.`);
