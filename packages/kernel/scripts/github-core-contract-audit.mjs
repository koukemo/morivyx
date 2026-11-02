import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, graphRootDigest, revisionId } from "../src/canonical.js";
import { runPluginProcess } from "../src/plugin-communication.js";
import { validateGitHubImportResult } from "../src/github-importer.js";
import { writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { prepareImportAvailability, writeImportAvailabilityPackage } from "../src/import-availability.js";
import { prepareImportPresence, writeImportPresencePackage } from "../src/import-presence.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const authoring = await load("../test/fixtures/plugin-communication/import-authoring.json");
const observationAuthoring = await load("../test/fixtures/plugin-communication/import-presence-authoring.json");
const manifest = await load("../test/fixtures/plugin-manifest/repository-importer.json");
const fixed = await load("../test/fixtures/github-importer/request.json");
manifest.identity.id = fixed.plugin.id;
const capability = manifest.capabilities[0]; capability.id = fixed.capability.id;
capability.inputFormat = "morivyx.github-read-input/0.1"; capability.outputFormat = "morivyx.github-file-snapshot/0.1";
// The fixture is read from an explicit file; no live network or credential is granted.
capability.permissions.fileRead = ["fixed-response"];
const policy = { format: "morivyx.plugin-host-policy/0.1", plugin: { id: manifest.identity.id, version: manifest.identity.version, packageDigest: manifest.identity.packageDigest },
  capability: { id: capability.id, effect: capability.effect, permissions: capability.permissions, resources: capability.resources } };
const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const commit = n => String(n).repeat(40);
const root = await mkdtemp(join(tmpdir(), "morivyx-github-core-")); const paths = []; let checks = 0;
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
    for (const forbidden of [root, "PRIVATE_SOURCE", "PRIVATE_PROVIDER", "Bearer fixture", "Authorization", "base64"])
      assert.equal(text.includes(forbidden), false);
  }
}
function bind(base, request) { return { ...request, baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest }; }
function fresh(request, runId) { const value = structuredClone(request); value.runRequest.runId = runId; value.runResult.runId = runId; return value; }
try {
  const empty = join(root, "empty"), runtime = join(root, "runtime"), external = join(root, "response.json");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  await cp(new URL("../src", import.meta.url), join(runtime, "src"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(runtime, "package.json"));
  await mkdir(join(runtime, "node_modules"));
  await cp(new URL("../node_modules/yaml", import.meta.url), join(runtime, "node_modules/yaml"), { recursive: true });
  async function run(name, version, time, content = "PRIVATE_SOURCE_1", state = "available") {
    const bytes = Buffer.from(content), sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const prefix = "https://api.github.com/repos/fixture-owner/fixture-repository", treeSha = "a".repeat(40);
    const documents = {
      [prefix]: { id: 123, full_name: "fixture-owner/fixture-repository" },
      [`${prefix}/git/commits/${version}`]: { sha: version, tree: { sha: treeSha } },
      [`${prefix}/git/trees/${treeSha}`]: { sha: treeSha, truncated: false,
        tree: state === "missing" ? [] : [{ path: "source.txt", type: "blob", mode: "100644", sha, size: bytes.length }] },
      [`${prefix}/git/blobs/${sha}`]: { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") },
    };
    await writeFile(external, JSON.stringify(documents)); const raw = await readFile(external, "utf8");
    const runRequest = structuredClone(fixed); runRequest.runId = `run:github-core-${name}`; runRequest.input.commit = version;
    const source = `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
import{servePluginStdio}from ${JSON.stringify(pathToFileURL(join(runtime, "src/plugin-stdio.js")).href)};
import{importGitHubFile,validateGitHubImportRequest,validateGitHubImportResult}from ${JSON.stringify(pathToFileURL(join(runtime, "src/github-importer.js")).href)};
const documents=JSON.parse(await readFile(${JSON.stringify(external)},'utf8'));let calls=0;
const options={permission:{apiOrigin:'https://api.github.com',owner:'fixture-owner',repository:'fixture-repository',repositoryId:123},token:'fixture',now:()=>${JSON.stringify(time)}};
options.fetchImpl=async(url,init)=>{calls++;assert.ok(Object.hasOwn(documents,url));assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer fixture');
return new Response(JSON.stringify(${state === "unavailable" ? "'PRIVATE_PROVIDER'" : "documents[url]"}),{status:${state === "unavailable" ? 503 : 200},headers:{'content-type':'application/json'}})};
const result=await servePluginStdio({handleRequest:request=>importGitHubFile(request,options),validateRequest:validateGitHubImportRequest,validateResult:validateGitHubImportResult});
assert.equal(calls,${state === "unavailable" ? 1 : state === "missing" ? 3 : 4});process.exitCode=result.exitCode;`;
    const runResult = runPluginProcess({ command: process.execPath, args: ["--input-type=module", "--eval", source], manifest, policy, request: runRequest });
    validateGitHubImportResult(runResult, runRequest); assert.equal(await readFile(external, "utf8"), raw);
    if (state === "available") {
      assert.equal(runResult.status, "success"); assert.equal(runResult.output.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    } else assert.equal(runResult.failure.code, state === "missing" ? "GITHUB_IMPORT_TARGET_MISSING" : "GITHUB_IMPORT_SOURCE_UNAVAILABLE");
    return { runRequest, runResult };
  }
  async function save(writer, basePath, name, request) {
    const before = await tree(basePath), source = await readFile(external, "utf8"), outputPath = join(root, name);
    const result = await writer({ basePath, outputPath, request }); paths.push(outputPath);
    assert.equal((await validatePackage(outputPath)).valid, true); const base = await readGraphPackage(outputPath);
    assert.equal(base.approvals.length, 0); assert.deepEqual(await tree(basePath), before); assert.equal(await readFile(external, "utf8"), source);
    for (const element of base.elements) { assert.equal(element.lifecycle, "draft"); assert.equal(element.reviewState, "unreviewed"); }
    await noSource(outputPath); return { path: outputPath, base, result };
  }
  const first = await run("initial", commit(1), "2026-09-08T20:00:00Z");
  const create = { ...authoring, ...first, manifest, resultingRevision: "graph:github-initial", recordedAt: "2026-09-08T20:00:01Z" };
  let initial, updated, missing, unavailable, current, changed;
  await check("fixed REST responses cross a real process into unreviewed Core storage", async () => {
    initial = await save(writeImportedSnapshotPackage, empty, "initial", create);
    const artifact = initial.base.elements[0]; assert.equal(artifact.attributes.artifactKind, "file"); assert.equal(artifact.attributes.externalVersion, commit(1));
    const record = artifact.extensions["morivyx.import/snapshot"];
    assert.equal(canonicalJson(record.snapshot), canonicalJson(first.runResult.output)); assert.equal(record.executionBinding, "not-verified");
    assert.deepEqual(record.informationLoss, first.runResult.output.informationLoss);
  });
  const second = await run("updated", commit(2), "2026-09-08T20:01:00Z", "PRIVATE_SOURCE_2");
  const revise = bind(initial.base, { ...create, ...second, format: "morivyx.import-snapshot-revision/0.1", changeSetId: id(803),
    baselineArtifactRevision: initial.base.elements[0].revision, resultingRevision: "graph:github-updated", recordedAt: "2026-09-08T20:01:01Z" });
  await check("a changed commit updates the same Artifact and retains the recorded baseline", async () => {
    updated = await save(writeReimportedSnapshotPackage, initial.path, "updated", revise);
    const artifact = updated.base.elements[0]; assert.equal(artifact.id, create.artifactId); assert.equal(artifact.attributes.externalVersion, commit(2));
    assert.notEqual(artifact.attributes.digest, initial.base.elements[0].attributes.digest);
    assert.deepEqual(updated.base.changeSets.find(x => x.id === revise.changeSetId).provenance.previousImportSnapshot.snapshot, first.runResult.output);
  });
  function observe(base, run, n, format, time) {
    return bind(base, { ...observationAuthoring, ...run, manifest, format, baselineArtifactRevision: updated.base.elements[0].revision,
      observationId: id(9000 + n * 3), relationId: id(9001 + n * 3), changeSetId: id(9002 + n * 3), resultingRevision: `graph:github-observed-${n}`,
      observedAt: time, recordedAt: time.replace("00Z", "01Z") });
  }
  const lost = await run("missing", commit(3), "2026-09-08T20:02:00Z", "", "missing");
  const blocked = await run("unavailable", commit(4), "2026-09-08T20:03:00Z", "", "unavailable");
  const same = await run("same", commit(5), "2026-09-08T20:04:00Z", "PRIVATE_SOURCE_2");
  const third = await run("changed", commit(6), "2026-09-08T20:05:00Z", "PRIVATE_SOURCE_3");
  await check("missing unavailable and both reappearances preserve the Artifact and all prior observations", async () => {
    let previous = updated;
    for (const [run, n, name, writer, format, time, expected] of [
      [lost, 1, "missing", writeImportAvailabilityPackage, "morivyx.import-availability/0.1", "2026-09-08T20:02:00Z", "missing"],
      [blocked, 2, "unavailable", writeImportAvailabilityPackage, "morivyx.import-availability/0.1", "2026-09-08T20:03:00Z", "unavailable"],
      [same, 3, "current", writeImportPresencePackage, "morivyx.import-presence/0.1", "2026-09-08T20:04:00Z", "current"],
      [third, 4, "changed", writeImportPresencePackage, "morivyx.import-presence/0.1", "2026-09-08T20:05:00Z", "stale"]]) {
      const saved = await save(writer, previous.path, name, observe(previous.base, run, n, format, time));
      assert.equal(saved.result.comparison ?? saved.result.status, expected);
      for (const element of previous.base.elements) assert.deepEqual(saved.base.elements.find(x => x.id === element.id), element);
      if (name === "missing") missing = saved; if (name === "unavailable") unavailable = saved; if (name === "current") current = saved; if (name === "changed") changed = saved;
      previous = saved;
    }
    assert.equal(changed.base.elements.find(x => x.id === create.artifactId).attributes.externalVersion, commit(2));
    assert.ok(missing && unavailable && current);
  });
  const fourth = await run("explicit", commit(6), "2026-09-08T20:06:00Z", "PRIVATE_SOURCE_3");
  const update = bind(changed.base, { ...revise, ...fourth, changeSetId: id(804), baselineArtifactRevision: updated.base.elements[0].revision,
    resultingRevision: "graph:github-final", recordedAt: "2026-09-08T20:06:01Z" });
  await check("an explicit update after observations preserves their history", async () => {
    const saved = await save(writeReimportedSnapshotPackage, changed.path, "final", update);
    assert.equal(saved.base.elements.find(x => x.id === create.artifactId).attributes.externalVersion, commit(6));
    for (const element of changed.base.elements.filter(x => x.id !== create.artifactId)) assert.deepEqual(saved.base.elements.find(x => x.id === element.id), element);
  });
  await check("human edits block revisions and remain intact in every observation path", async () => {
    const edited = structuredClone(updated.base.elements[0]); edited.attributes.uri = "urn:human:edited"; delete edited.extensions;
    edited.provenance = { method: "asserted", actor: create.actor, recordedAt: "2026-09-08T20:01:30Z" }; edited.revision = revisionId(edited);
    const rootDigest = graphRootDigest([edited]); const revision = { ...updated.base.revision, id: "graph:github-human", parentRevision: updated.base.revision.id, rootDigest };
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
      const request = observe(human, run, n, format, time), saved = await save(writer, path, name, request);
      assert.deepEqual(saved.base.elements.find(x => x.id === edited.id), edited);
      assert.equal(saved.base.elements.find(x => x.id === request.observationId).attributes.value.localStatus, "changed");
    }
  });
  await check("recorded Run time and baseline guards also apply to real process results", () => {
    assert.throws(() => prepareImportSnapshotRevision(changed.base, fresh(update, third.runResult.runId)), { code: "IMPORT_REVISION_RUN_ALREADY_RECORDED" });
    const early = fresh(update, "run:github-early"); early.runResult.output.retrievedAt = "2026-09-08T20:04:59Z";
    assert.throws(() => prepareImportSnapshotRevision(changed.base, early), { code: "IMPORT_REVISION_TIME_REGRESSION" });
    const presence = observe(changed.base, same, 20, "morivyx.import-presence/0.1", "2026-09-08T20:07:00Z");
    assert.throws(() => prepareImportPresence(changed.base, presence), { code: "IMPORT_PRESENCE_RUN_ALREADY_RECORDED" });
    const old = observe(updated.base, lost, 21, "morivyx.import-availability/0.1", "2026-09-08T20:07:00Z"); old.baselineArtifactRevision = initial.base.elements[0].revision;
    assert.throws(() => prepareImportAvailability(updated.base, old), { code: "IMPORT_AVAILABILITY_BASELINE_SUPERSEDED" });
  });
  await check("existing destinations and caller mutation cannot overwrite stored data", async () => {
    const before = await tree(updated.path);
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initial.path, outputPath: updated.path, request: revise }), { code: "PACKAGE_OUTPUT_EXISTS" });
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initial.path, outputPath: initial.path, request: revise }), { code: "PACKAGE_OUTPUT_INVALID" });
    const rejected = join(root, "rejected");
    await assert.rejects(writeReimportedSnapshotPackage({ basePath: initial.path, outputPath: rejected, request: { ...revise, baseRevision: "graph:wrong" } }));
    await assert.rejects(access(rejected));
    const copied = structuredClone(update), outputPath = join(root, "async");
    const pending = writeReimportedSnapshotPackage({ basePath: changed.path, outputPath, request: copied }); copied.actor = "bad"; copied.runResult.output.digest = "bad";
    await pending; paths.push(outputPath); assert.equal((await validatePackage(outputPath)).valid, true); assert.deepEqual(await tree(updated.path), before);
  });
  await check("removing the executable and response data preserves all Core packages", async () => {
    const originals = await Promise.all(paths.map(tree)); await rm(runtime, { recursive: true }); await rm(external);
    for (const [index, path] of paths.entries()) {
      await readGraphPackage(path); assert.equal((await validatePackage(path)).valid, true); assert.deepEqual(await tree(path), originals[index]); await noSource(path);
    }
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 8);
console.log(`GitHub Core audit passed: ${checks} checks; fixed REST responses, real processes and retained Core packages verified.`);
