import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, revisionId, graphRootDigest } from "../src/canonical.js";
import { IMPORT_SNAPSHOT_EXTENSION, prepareImportSnapshotCreation,
  validateImportSnapshotCreationRequest, writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { readGraphPackage } from "../src/package-reader.js";
import { validatePackage } from "../src/validator.js";
import { runPluginProcess } from "../src/plugin-communication.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const authoring = await load("../test/fixtures/plugin-communication/import-authoring.json");
const manifest = await load("../test/fixtures/plugin-manifest/repository-importer.json");
const policy = await load("../test/fixtures/plugin-manifest/host-policy.json");
const runRequest = await load("../test/fixtures/plugin-communication/request.json");
const runResult = await load("../test/fixtures/plugin-communication/result.json");
const request = () => structuredClone({ ...authoring, manifest, runRequest, runResult });
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const invalid = (input, code = "IMPORT_SNAPSHOT_REQUEST_INVALID") =>
  assert.throws(() => validateImportSnapshotCreationRequest(input), error => error.code === code);
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
const root = await mkdtemp(join(tmpdir(), "morivyx-import-package-"));
try {
  const basePath = join(root, "base");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), basePath, { recursive: true });
  await mkdir(join(basePath, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(basePath, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  const base = await readGraphPackage(basePath);
  const before = await tree(basePath);

  await check("fixed authoring and deterministic proposal", () => {
    const input = request(); const original = canonicalJson(input);
    const a = prepareImportSnapshotCreation(base, input);
    assert.deepEqual(a, prepareImportSnapshotCreation(base, input));
    assert.equal(canonicalJson(input), original);
    assert.equal(a.candidateElement.type, "core.artifact");
    assert.equal(a.candidateElement.lifecycle, "draft");
    assert.equal(a.candidateElement.reviewState, "unreviewed");
    assert.equal(a.candidateElement.provenance.method, "imported");
    assert.equal(a.candidateElement.attributes.uri, "urn:morivyx:repository-file:repository%3Afixture:source.txt");
    assert.equal(a.candidateElement.revision, revisionId(a.candidateElement));
    const record = a.candidateElement.extensions[IMPORT_SNAPSHOT_EXTENSION];
    assert.deepEqual(record.snapshot, runResult.output);
    assert.equal(record.plugin.packageDigest, manifest.identity.packageDigest);
    assert.equal(record.executionBinding, "not-verified");
    assert.ok(record.informationLoss.includes("repository-commit-not-recorded"));
    assert.deepEqual(a.changeSet.operations.map(x => x.op), ["create"]);
    assert.deepEqual(a.changeSet.provenance.importSnapshot, record);
    assert.equal(canonicalJson(a).includes("repositoryRoot"), false);
    a.candidateElement.extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot.locator = "changed";
    assert.equal(a.changeSet.provenance.importSnapshot.snapshot.locator, "source.txt");
    assert.equal(canonicalJson(input), original);
  });
  await check("invalid logical roots", () => {
    for (const value of [undefined, null, [], 1, true, "x", 1n, new Date(), new Map(), new Proxy({}, {})]) invalid(value);
    const cyclic = request(); cyclic.self = cyclic; invalid(cyclic);
    const hidden = request(); Object.defineProperty(hidden, "hidden", { value: true }); invalid(hidden);
    const sparse = request(); sparse.extra = new Array(2); invalid(sparse);
  });
  await check("accessors never run", () => {
    let calls = 0; const input = request();
    Object.defineProperty(input, "manifest", { enumerable: true, get() { calls++; throw Error(); } });
    invalid(input); assert.equal(calls, 0);
  });
  await check("invalid authoring fields", () => {
    for (const [key, value] of [["extra", true], ["format", "bad"], ["artifactId", "bad"],
      ["artifactId", authoring.actor], ["changeSetId", authoring.artifactId], ["baseRevision", "bad"],
      ["resultingRevision", authoring.baseRevision], ["baseRootDigest", "bad"],
      ["recordedAt", "2026-02-30T00:00:00Z"], ["actor", "bad"]]) invalid({ ...request(), [key]: value });
    const missing = request(); delete missing.actor; invalid(missing);
  });
  await check("bounded request", () => {
    const input = request(); input.runRequest.input.repositoryRoot = "x".repeat(1048576);
    invalid(input, "IMPORT_SNAPSHOT_INPUT_LIMIT");
  });
  await check("result and manifest identity", () => {
    for (const mutate of [
      x => { x.runResult.runId = "different"; },
      x => { x.runResult.output.locator = "different"; },
      x => { x.manifest.identity.version = "2.0.0"; },
      x => { x.manifest.identity.id = "other.plugin"; },
      x => { x.manifest.capabilities[0].id = "other.read"; },
      x => { x.manifest.capabilities[0].inputFormat = "wrong/0.1"; },
      x => { x.manifest.capabilities[0].outputFormat = "wrong/0.1"; },
      x => { x.recordedAt = "2026-09-01T00:00:00Z"; },
      x => { x.recordedAt = "2026-09-05T01:00:00.000000001Z";
        x.runResult.output.retrievedAt = "2026-09-05T01:00:00.000000002Z"; },
      x => { x.runRequest.capability.effect = "pure"; },
      x => { x.runResult.status = "failure"; delete x.runResult.output;
        x.runResult.failure = { code: "FAILED", message: "failed" }; },
      x => { x.runRequest.input.locator = "../escape"; x.runResult.output.locator = "../escape"; },
      x => { x.runRequest.input.extra = true; },
      x => { x.runResult.output.secret = "not-allowed"; },
    ]) { const input = request(); mutate(input); invalid(input, "IMPORT_SNAPSHOT_RESULT_INVALID"); }
  });
  await check("base preconditions and input unchanged", () => {
    const original = canonicalJson(base.elements);
    for (const key of ["baseRevision", "baseRootDigest"]) {
      const input = request(); input[key] = key === "baseRevision" ? "graph:other" : `sha256:${"0".repeat(64)}`;
      assert.throws(() => prepareImportSnapshotCreation(base, input), { code: "IMPORT_SNAPSHOT_BASE_MISMATCH" });
    }
    assert.throws(() => prepareImportSnapshotCreation(null, request()), { code: "IMPORT_SNAPSHOT_PACKAGE_INVALID" });
    const forged = structuredClone(base);
    forged.elements.push(prepareImportSnapshotCreation(base, request()).candidateElement);
    assert.throws(() => prepareImportSnapshotCreation(forged, request()));
    assert.equal(canonicalJson(base.elements), original);
    const missing = structuredClone(base); missing.schemaLock.schemas = [];
    assert.throws(() => prepareImportSnapshotCreation(missing, request()), { code: "IMPORT_SNAPSHOT_SCHEMA_MISSING" });
  });
  await check("identifier collisions across records", () => {
    for (const key of ["elements", "approvals", "changeSets", "migrations", "reports"]) {
      for (const id of [authoring.artifactId, authoring.changeSetId]) {
        const value = structuredClone(base); value[key].push({ id });
        assert.throws(() => prepareImportSnapshotCreation(value, request()), { code: "IMPORT_SNAPSHOT_ID_EXISTS" });
      }
    }
  });
  await check("GitHub fixed snapshot and URL escaping", async () => {
    const input = request();
    input.runRequest = await load("../test/fixtures/github-importer/request.json");
    input.runResult = await load("../test/fixtures/github-importer/result.json");
    input.manifest.identity.id = input.runResult.plugin.id;
    input.manifest.capabilities[0].id = input.runResult.capabilityId;
    input.manifest.capabilities[0].inputFormat = "morivyx.github-read-input/0.1";
    input.manifest.capabilities[0].outputFormat = "morivyx.github-file-snapshot/0.1";
    const result = prepareImportSnapshotCreation(base, input);
    assert.equal(result.candidateElement.attributes.externalVersion, "1".repeat(40));
    assert.match(result.candidateElement.attributes.uri, /^https:\/\/github\.com\/fixture-owner\/fixture-repository\/blob\/1{40}\/source\.txt$/);
    assert.deepEqual(result.candidateElement.extensions[IMPORT_SNAPSHOT_EXTENSION].informationLoss, input.runResult.output.informationLoss);
    const path = join(root, "github-created");
    await writeImportedSnapshotPackage({ basePath, outputPath: path, request: input });
    const restored = await readGraphPackage(path);
    assert.equal((await validatePackage(path)).valid, true);
    assert.deepEqual(restored.elements.find(x => x.id === input.artifactId).extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot, input.runResult.output);
    input.runRequest.input.locator = "a #?.txt";
    input.runResult.output.locator = "a #?.txt";
    input.runResult.output.externalIdentity.externalId = "github:123:a #?.txt";
    assert.ok(prepareImportSnapshotCreation(base, input).candidateElement.attributes.uri.endsWith("a%20%23%3F.txt"));
  });

  const runtime = join(root, "plugin-runtime");
  await cp(new URL("../src/", import.meta.url), runtime, { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"module"}\n');
  const repository = join(root, "repository"); await mkdir(repository);
  await writeFile(join(repository, "source.txt"), "real-import-content\n");
  const live = request(); live.runRequest.input.repositoryRoot = repository;
  live.runResult = runPluginProcess({ command: process.execPath,
    args: [join(runtime, "repository-importer-stdio.js")], manifest: live.manifest, request: live.runRequest, policy });
  live.recordedAt = live.runResult.output.retrievedAt;
  const outputPath = join(root, "created");
  await check("real process import then atomic Core save", async () => {
    assert.equal(live.runResult.status, "success");
    const saved = await writeImportedSnapshotPackage({ basePath, outputPath, request: live });
    assert.equal(saved.valid, true);
    const restored = await readGraphPackage(outputPath);
    assert.equal((await validatePackage(outputPath)).valid, true);
    const artifact = restored.elements.find(x => x.id === live.artifactId);
    assert.equal(artifact.attributes.digest, live.runResult.output.digest);
    assert.equal(canonicalJson(artifact.extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot), canonicalJson(live.runResult.output));
    const serialized = canonicalJson(artifact) + canonicalJson(restored.changeSets);
    assert.equal(serialized.includes(repository), false);
    assert.equal(serialized.includes("real-import-content"), false);
    assert.deepEqual(await tree(basePath), before);
  });
  await check("remove executable runtime and reread identical Core", async () => {
    const beforeRemoval = await tree(outputPath);
    const value = await readGraphPackage(outputPath);
    await rm(runtime, { recursive: true, force: true });
    await assert.rejects(access(join(runtime, "repository-importer-stdio.js")), { code: "ENOENT" });
    const restored = await readGraphPackage(outputPath);
    assert.deepEqual(restored.elements, value.elements);
    assert.deepEqual(restored.changeSets, value.changeSets);
    assert.deepEqual(await tree(outputPath), beforeRemoval);
    assert.equal((await validatePackage(outputPath)).valid, true);
  });
  await check("existing external target remains protected after human edit", async () => {
    const restored = await readGraphPackage(outputPath);
    const input = request(); input.artifactId = input.artifactId.replace("0801", "0901");
    input.changeSetId = input.changeSetId.replace("0802", "0902");
    input.baseRevision = restored.revision.id; input.baseRootDigest = restored.revision.rootDigest;
    input.resultingRevision = "graph:another-import";
    assert.throws(() => prepareImportSnapshotCreation(restored, input), { code: "IMPORT_SNAPSHOT_TARGET_EXISTS" });
    const artifact = restored.elements.find(x => x.id === authoring.artifactId);
    delete artifact.extensions; artifact.attributes.uri = "urn:human:edited";
    artifact.revision = revisionId(artifact); restored.revision.rootDigest = graphRootDigest(restored.elements);
    input.baseRootDigest = restored.revision.rootDigest;
    assert.throws(() => prepareImportSnapshotCreation(restored, input), { code: "IMPORT_SNAPSHOT_TARGET_EXISTS" });
  });
  await check("output collision and invalid request leave no partial output", async () => {
    const saved = await tree(outputPath);
    await assert.rejects(writeImportedSnapshotPackage({ basePath, outputPath, request: live }), { code: "PACKAGE_OUTPUT_EXISTS" });
    assert.deepEqual(await tree(outputPath), saved);
    const rejectedPath = join(root, "rejected");
    await assert.rejects(writeImportedSnapshotPackage({ basePath, outputPath: rejectedPath, request: { ...live, baseRevision: "graph:stale" } }), { code: "IMPORT_SNAPSHOT_BASE_MISMATCH" });
    await assert.rejects(access(rejectedPath), { code: "ENOENT" });
    await assert.rejects(writeImportedSnapshotPackage(null), { code: "IMPORT_SNAPSHOT_REQUEST_INVALID" });
    assert.deepEqual(await tree(basePath), before);
  });
  await check("snapshot authoring input before asynchronous read", async () => {
    const input = request(); const path = join(root, "immutable");
    const promise = writeImportedSnapshotPackage({ basePath, outputPath: path, request: input });
    input.runResult.output.digest = `sha256:${"0".repeat(64)}`;
    input.artifactId = input.actor;
    await promise;
    const restored = await readGraphPackage(path);
    assert.equal(restored.elements.find(x => x.id === authoring.artifactId).attributes.digest, runResult.output.digest);
  });
  await check("fixed Schema failure leaves base intact and no output", async () => {
    const invalidBase = join(root, "invalid-schema"); await cp(basePath, invalidBase, { recursive: true });
    const schemaPath = join(invalidBase, ".morivyx/schemas/morivyx.core@0.1.yaml");
    const schema = await readFile(schemaPath, "utf8");
    await writeFile(schemaPath, schema.replace('typeId: "core.artifact"', 'typeId: "core.not-artifact"'));
    const invalidBefore = await tree(invalidBase); const path = join(root, "invalid-output");
    await assert.rejects(writeImportedSnapshotPackage({ basePath: invalidBase, outputPath: path, request: request() }),
      { code: "CHANGESET_TARGET_VALIDATION_FAILED" });
    await assert.rejects(access(path), { code: "ENOENT" });
    assert.deepEqual(await tree(invalidBase), invalidBefore);
    assert.deepEqual(await tree(basePath), before);
  });
  await check("fixed fractional timestamps survive Core normalization", async () => {
    for (const [fraction, normalized] of [[".900", ".9"], [".120", ".12"], [".000", ""]]) {
      const input = request(); input.runResult.output.retrievedAt = `2026-09-05T01:00:00${fraction}Z`;
      const path = join(root, `fraction-${fraction.slice(1)}`);
      await writeImportedSnapshotPackage({ basePath, outputPath: path, request: input });
      const restored = (await readGraphPackage(path)).elements.find(x => x.id === input.artifactId);
      const snapshot = restored.extensions[IMPORT_SNAPSHOT_EXTENSION].snapshot;
      assert.equal(snapshot.retrievedAt, `2026-09-05T01:00:00${normalized}Z`);
      assert.equal(canonicalJson(snapshot), canonicalJson(input.runResult.output));
      const changed = structuredClone(snapshot); changed.digest = `sha256:${"0".repeat(64)}`;
      assert.notEqual(canonicalJson(changed), canonicalJson(input.runResult.output));
    }
  });
} finally { await rm(root, { recursive: true, force: true }); }
assert.equal(checks, 16);
console.log(`Import snapshot creation audit passed: ${checks} checks, real Plugin removal and Core persistence verified.`);
