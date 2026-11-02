import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, graphRootDigest, revisionId } from "../src/canonical.js";
import { runPluginProcess } from "../src/plugin-communication.js";
import { validateFigmaImportResult } from "../src/figma-importer.js";
import { prepareImportSnapshotCreation, writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { prepareImportAvailability, writeImportAvailabilityPackage } from "../src/import-availability.js";
import { prepareImportPresence, writeImportPresencePackage } from "../src/import-presence.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";
const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const authoring = await load("../test/fixtures/plugin-communication/import-authoring.json");
const observationAuthoring = await load("../test/fixtures/plugin-communication/import-presence-authoring.json");
const manifest = await load("../test/fixtures/figma-importer/manifest.json");
const fixed = await load("../test/fixtures/figma-importer/request.json");
const response = await load("../test/fixtures/figma-importer/response.json");
const capability = manifest.capabilities[0];
const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { id: manifest.identity.id, version: manifest.identity.version, packageDigest: manifest.identity.packageDigest },
  capability: { id: capability.id, effect: capability.effect, permissions: capability.permissions, resources: capability.resources } };
const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const root = await mkdtemp(join(tmpdir(), "morivyx-figma-core-")); const paths = []; let checks = 0;
async function check(name, operation) { try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
async function tree(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await tree(join(path, entry.name)))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = (await readFile(join(path, entry.name))).toString("base64");
  }
  return result;
}
async function noSource(path) {
  for (const bytes of Object.values(await tree(path))) {
    const text = Buffer.from(bytes, "base64").toString("utf8");
    for (const forbidden of [root, "PRIVATE_NODE", "PRIVATE_FILE", "PRIVATE_PROVIDER", "Bearer fixture", "absoluteBoundingBox", "documentText", "invalid.example.test"])
      assert.equal(text.includes(forbidden), false);
  }
}
function bind(base, request) { return { ...request, baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest }; }
function fresh(request, runId) { const value = structuredClone(request); value.runRequest.runId = runId; value.runResult.runId = runId; return value; }
try {
  const empty = join(root, "empty"); const runtime = join(root, "runtime"); const external = join(root, "response.json");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  await cp(new URL("../src", import.meta.url), join(runtime, "src"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(runtime, "package.json"));
  await mkdir(join(runtime, "node_modules"));
  await cp(new URL("../node_modules/yaml", import.meta.url), join(runtime, "node_modules/yaml"), { recursive: true });
  async function run(name, version, time, payload, status = 200) {
    await writeFile(external, JSON.stringify(payload)); const raw = await readFile(external, "utf8");
    const runRequest = structuredClone(fixed); runRequest.runId = `run:figma-${name}`; runRequest.input.version = version;
    const source = `import{serveFigmaImporter}from ${JSON.stringify(pathToFileURL(join(runtime, "src/figma-importer.js")).href)};
const options={permission:{apiOrigin:'https://api.figma.com',fileKey:'fixtureFile'},credential:{kind:'oauth',token:'fixture'}};
options.now=()=>${JSON.stringify(time)};options.fetchImpl=async()=>new Response(${JSON.stringify(raw)},{status:${status},headers:{'content-type':'application/json'}});
const result=await serveFigmaImporter(options);process.exitCode=result.exitCode;`;
    const runResult = runPluginProcess({ command: process.execPath, args: ["--input-type=module", "--eval", source], manifest, policy, request: runRequest });
    validateFigmaImportResult(runResult, runRequest); assert.equal(await readFile(external, "utf8"), raw);
    return { runRequest, runResult };
  }
  async function save(writer, basePath, name, request) {
    const before = await tree(basePath); const source = await readFile(external, "utf8"); const outputPath = join(root, name);
    const result = await writer({ basePath, outputPath, request }); paths.push(outputPath);
    assert.equal((await validatePackage(outputPath)).valid, true); const saved = await readGraphPackage(outputPath);
    assert.equal(saved.approvals.length, 0); assert.deepEqual(await tree(basePath), before); assert.equal(await readFile(external, "utf8"), source);
    await noSource(outputPath); return { path: outputPath, base: saved, result };
  }
  function document(version, width = 100) { const value = structuredClone(response); value.version = version; value.nodes["1:2"].document.absoluteBoundingBox.width = width; return value; }
  const first = await run("initial", "1001", "2026-09-08T20:00:00.900Z", document("1001"));
  const create = { ...authoring, ...first, manifest, resultingRevision: "graph:figma-initial", recordedAt: "2026-09-08T20:00:01Z" };
  let initial, updated, missing, unavailable, currentPresence, changedPresence, final;
  await check("first real-process result is saved as an unreviewed design Node", async () => {
    initial = await save(writeImportedSnapshotPackage, empty, "initial", create);
    const artifact = initial.base.elements[0]; assert.equal(artifact.attributes.artifactKind, "design-node");
    assert.equal(artifact.attributes.uri, "urn:morivyx:figma-node:fixtureFile:1%3A2"); assert.equal(artifact.attributes.externalVersion, "1001");
    assert.equal(artifact.lifecycle, "draft"); assert.equal(artifact.reviewState, "unreviewed");
    const record = artifact.extensions["morivyx.import/snapshot"];
    assert.equal(canonicalJson(record.snapshot), canonicalJson(first.runResult.output));
    assert.equal(record.executionBinding, "not-verified"); assert.deepEqual(record.informationLoss, first.runResult.output.informationLoss);
  });
  const second = await run("changed", "1002", "2026-09-08T20:01:00Z", document("1002", 101));
  const revise = bind(initial.base, { ...create, ...second, format: "morivyx.import-snapshot-revision/0.1", changeSetId: id(803),
    baselineArtifactRevision: initial.base.elements[0].revision, resultingRevision: "graph:figma-updated", recordedAt: "2026-09-08T20:01:01Z" });
  await check("another fixed version updates the same Artifact through a persisted baseline", async () => {
    updated = await save(writeReimportedSnapshotPackage, initial.path, "updated", revise);
    assert.equal(updated.base.elements[0].id, initial.base.elements[0].id);
    assert.equal(updated.base.elements[0].attributes.uri, initial.base.elements[0].attributes.uri);
    assert.equal(updated.base.elements[0].attributes.externalVersion, "1002");
    assert.notEqual(updated.base.elements[0].attributes.digest, initial.base.elements[0].attributes.digest);
    assert.deepEqual(updated.base.changeSets.find(x => x.id === revise.changeSetId).provenance.previousImportSnapshot.snapshot,
      initial.base.elements[0].extensions["morivyx.import/snapshot"].snapshot);
  });
  function observe(base, run, n, format, time) {
    return bind(base, { ...observationAuthoring, ...run, manifest, format, baselineArtifactRevision: updated.base.elements[0].revision,
      observationId: id(9000 + n * 3), relationId: id(9001 + n * 3), changeSetId: id(9002 + n * 3), resultingRevision: `graph:figma-observation-${n}`,
      observedAt: time, recordedAt: time.replace("00Z", "01Z") });
  }
  const absent = document("1003"); absent.nodes["1:2"] = null;
  const lost = await run("missing", "1003", "2026-09-08T20:02:00Z", absent);
  const missingRequest = observe(updated.base, lost, 1, "morivyx.import-availability/0.1", "2026-09-08T20:02:00Z");
  const blocked = await run("unavailable", "1004", "2026-09-08T20:03:00Z", "PRIVATE_PROVIDER_RESPONSE", 503);
  await check("missing and unavailable observations preserve the Artifact and attempted version", async () => {
    missing = await save(writeImportAvailabilityPackage, updated.path, "missing", missingRequest);
    assert.equal(missing.result.status, "missing");
    const record = missing.base.changeSets.find(x => x.id === missingRequest.changeSetId).provenance.importAvailability;
    assert.deepEqual(record.attemptedSource, { system: "figma", apiOrigin: "https://api.figma.com", fileKey: "fixtureFile", nodeId: "1:2", version: "1003" });
    unavailable = await save(writeImportAvailabilityPackage, missing.path, "unavailable",
      observe(missing.base, blocked, 2, "morivyx.import-availability/0.1", "2026-09-08T20:03:00Z"));
    assert.equal(unavailable.result.status, "unavailable");
    for (const saved of [missing, unavailable]) assert.deepEqual(saved.base.elements.find(x => x.id === create.artifactId), updated.base.elements[0]);
  });
  const same = await run("same-return", "1005", "2026-09-08T20:04:00Z", document("1005", 101));
  const third = await run("changed-return", "1006", "2026-09-08T20:05:00Z", document("1006", 102));
  await check("same and changed reappearances are retained without silently updating the Artifact", async () => {
    currentPresence = await save(writeImportPresencePackage, unavailable.path, "current-presence",
      observe(unavailable.base, same, 3, "morivyx.import-presence/0.1", "2026-09-08T20:04:00Z"));
    assert.equal(currentPresence.result.comparison, "current");
    changedPresence = await save(writeImportPresencePackage, currentPresence.path, "changed-presence",
      observe(currentPresence.base, third, 4, "morivyx.import-presence/0.1", "2026-09-08T20:05:00Z"));
    assert.equal(changedPresence.result.comparison, "stale");
    for (const saved of [currentPresence, changedPresence]) {
      assert.deepEqual(saved.base.elements.find(x => x.id === create.artifactId), updated.base.elements[0]);
      for (const element of unavailable.base.elements) assert.deepEqual(saved.base.elements.find(x => x.id === element.id), element);
    }
  });
  const fourth = await run("explicit-update", "1006", "2026-09-08T20:06:00Z", document("1006", 102));
  const update = bind(changedPresence.base, { ...revise, ...fourth, changeSetId: id(804), baselineArtifactRevision: updated.base.elements[0].revision,
    resultingRevision: "graph:figma-final", recordedAt: "2026-09-08T20:06:01Z" });
  await check("later explicit update follows observations without destroying history", async () => {
    final = await save(writeReimportedSnapshotPackage, changedPresence.path, "final", update);
    assert.equal(final.base.elements.find(x => x.id === create.artifactId).attributes.externalVersion, "1006");
    for (const element of changedPresence.base.elements.filter(x => x.id !== create.artifactId))
      assert.deepEqual(final.base.elements.find(x => x.id === element.id), element);
  });
  await check("human editing blocks revisions but not non-destructive observations", async () => {
    const edited = structuredClone(updated.base.elements[0]); edited.attributes.uri = "urn:human:edited"; delete edited.extensions;
    edited.provenance = { method: "asserted", actor: create.actor, recordedAt: "2026-09-08T20:01:30Z" }; edited.revision = revisionId(edited);
    const rootDigest = graphRootDigest([edited]); const revision = { ...updated.base.revision, id: "graph:figma-human", parentRevision: updated.base.revision.id, rootDigest };
    const changeSet = { format: "morivyx.changeset/0.1", id: id(899), baseRevision: updated.base.revision.id, resultingRevision: revision.id,
      resultingRootDigest: rootDigest, schemaLockDigest: updated.base.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: updated.base.elements[0].revision, afterRevision: edited.revision }],
      provenance: edited.provenance, recordedAt: edited.provenance.recordedAt };
    const path = join(root, "human"); await writeAppliedPackage({ basePath: updated.path, outputPath: path, changeSet, candidateElements: [edited], resultingRevision: revision }); paths.push(path);
    const human = await readGraphPackage(path);
    assert.throws(() => prepareImportSnapshotRevision(human, bind(human, update)), { code: "IMPORT_REVISION_LOCAL_CONFLICT" });
    assert.throws(() => prepareImportSnapshotRevision(human, { ...bind(human, update), baselineArtifactRevision: edited.revision }), { code: "IMPORT_REVISION_BASELINE_UNRECORDED" });
    for (const [name, writer, run, format, time, n] of [
      ["human-missing", writeImportAvailabilityPackage, lost, "morivyx.import-availability/0.1", "2026-09-08T20:02:00Z", 10],
      ["human-unavailable", writeImportAvailabilityPackage, blocked, "morivyx.import-availability/0.1", "2026-09-08T20:03:00Z", 11],
      ["human-presence", writeImportPresencePackage, third, "morivyx.import-presence/0.1", "2026-09-08T20:05:00Z", 12]]) {
      const value = observe(human, run, n, format, time); const saved = await save(writer, path, name, value);
      assert.deepEqual(saved.base.elements.find(x => x.id === edited.id), edited);
      const observation = saved.base.elements.find(x => x.id === value.observationId);
      assert.equal(observation.attributes.value.localStatus, "changed"); assert.equal(observation.attributes.value.currentArtifactRevision, edited.revision);
    }
  });
  await check("baseline reuse time regression and invalid capabilities remain blocked", () => {
    const early = fresh(update, "run:figma-early"); early.runResult.output.retrievedAt = "2026-09-08T20:04:59.999999999Z";
    assert.throws(() => prepareImportSnapshotRevision(changedPresence.base, early), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    const replay = fresh(update, third.runResult.runId);
    assert.throws(() => prepareImportSnapshotRevision(changedPresence.base, replay), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
    const presence = observe(changedPresence.base, same, 20, "morivyx.import-presence/0.1", "2026-09-08T20:07:00Z");
    assert.throws(() => prepareImportPresence(changedPresence.base, presence), { code: "IMPORT_PRESENCE_RUN_ALREADY_RECORDED" });
    assert.throws(() => prepareImportPresence(changedPresence.base, fresh(presence, "run:figma-old-presence")), { code: "IMPORT_PRESENCE_TIME_REGRESSION" });
    const repeatMissing = observe(changedPresence.base, lost, 21, "morivyx.import-availability/0.1", "2026-09-08T20:07:00Z");
    assert.throws(() => prepareImportAvailability(changedPresence.base, fresh(repeatMissing, third.runResult.runId)), { code: "IMPORT_AVAILABILITY_RUN_ALREADY_RECORDED" });
    const earlyMissing = fresh(repeatMissing, "run:figma-early-missing"); earlyMissing.observedAt = "2026-09-08T20:04:59.999999999Z";
    assert.throws(() => prepareImportAvailability(changedPresence.base, earlyMissing), { code: "IMPORT_AVAILABILITY_TIME_REGRESSION" });
    const reused = bind(changedPresence.base, fresh(create, third.runResult.runId)); reused.artifactId = id(820); reused.changeSetId = id(821);
    reused.runRequest.input.fileKey = "other"; reused.runResult.output.source.fileKey = "other"; reused.runResult.output.externalIdentity = { system: "figma", fileKey: "other", externalId: "figma:other:1:2" };
    assert.throws(() => prepareImportSnapshotCreation(changedPresence.base, reused), { code: "IMPORT_SNAPSHOT_RUN_ALREADY_RECORDED" });
    const old = { ...missingRequest, baselineArtifactRevision: initial.base.elements[0].revision };
    assert.throws(() => prepareImportAvailability(updated.base, old), { code: "IMPORT_AVAILABILITY_BASELINE_SUPERSEDED" });
    const sameVersionMissing = structuredClone(missingRequest); sameVersionMissing.runRequest.input.version = "1002";
    assert.throws(() => prepareImportAvailability(updated.base, sameVersionMissing), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
    const unknown = structuredClone(missingRequest); unknown.runResult.failure.code = "PRIVATE_UNKNOWN";
    assert.throws(() => prepareImportAvailability(updated.base, unknown), { code: "IMPORT_AVAILABILITY_COMPARISON_INVALID" });
    const invalid = structuredClone(create); invalid.manifest.capabilities[0].effect = "pure";
    assert.throws(() => prepareImportSnapshotCreation(initial.base, invalid), { code: "IMPORT_SNAPSHOT_RESULT_INVALID" });
    const corrupt = structuredClone(initial.base); corrupt.changeSets[0].provenance.importSnapshot.snapshot.informationLoss = [];
    assert.throws(() => prepareImportSnapshotRevision(corrupt, revise), { code: "IMPORT_REVISION_BASELINE_INVALID" });
    const collision = { ...missingRequest, observationId: create.artifactId };
    assert.throws(() => prepareImportAvailability(updated.base, collision), { code: "IMPORT_AVAILABILITY_REQUEST_INVALID" });
    assert.throws(() => prepareImportAvailability(updated.base, { ...missingRequest, observationId: create.changeSetId }), { code: "IMPORT_AVAILABILITY_ID_EXISTS" });
  });
  await check("separate outputs and cloned asynchronous requests prevent overwrites", async () => {
    const before = await tree(updated.path);
    await assert.rejects(writeImportAvailabilityPackage({ basePath: updated.path, outputPath: updated.path, request: missingRequest }), { code: "PACKAGE_OUTPUT_INVALID" });
    await assert.rejects(writeImportAvailabilityPackage({ basePath: updated.path, outputPath: missing.path, request: missingRequest }), { code: "PACKAGE_OUTPUT_EXISTS" });
    const path = join(root, "rejected");
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initial.path, outputPath: path, request: { ...revise, baseRevision: "graph:wrong" } }), { code: "IMPORT_REVISION_BASE_MISMATCH" });
    await assert.rejects(access(path), { code: "ENOENT" });
    const value = structuredClone(revise); const outputPath = join(root, "immutable");
    const pending = writeReimportedSnapshotPackage({ basePath: initial.path, outputPath, request: value }); value.actor = "bad"; value.runResult.output.source.version = "bad";
    await pending; paths.push(outputPath); assert.equal((await validatePackage(outputPath)).valid, true); assert.deepEqual(await tree(updated.path), before);
  });
  await check("removing the Plugin and response fixtures leaves every Core package readable", async () => {
    const originals = await Promise.all(paths.map(tree)); await rm(runtime, { recursive: true }); await rm(external);
    for (const [index, path] of paths.entries()) {
      await readGraphPackage(path); assert.equal((await validatePackage(path)).valid, true); assert.deepEqual(await tree(path), originals[index]); await noSource(path);
    }
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 9);
console.log(`Figma Core audit passed: ${checks} checks; fixed-response processes, all observation paths and retained human edits verified.`);
