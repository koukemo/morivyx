import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkFixture, FIXTURE_TIME, FIXTURE_TOKEN } from "../test-support/network-import-fixtures.mjs";
import { createPluginExecutionGrant } from "../src/plugin-communication.js";
import { importGitHubFile } from "../src/github-importer.js";
import { importFigmaNode } from "../src/figma-importer.js";
import { packNetworkImportInput, convertNetworkImportInput } from "../src/network-import-conversion.js";
import { verifyPluginSupplyChain } from "../src/plugin-supply-chain.js";
import { fileTree } from "../test-support/network-isolation-build.mjs";
import { exerciseNetworkCore } from "../test-support/network-isolation-core.mjs";
import { readGraphPackage } from "../src/package-reader.js";
import { validatePackage } from "../src/validator.js";
import { createNetworkFixtureServer } from "../test-support/network-isolation-http.mjs";
import { runNetworkImportContainer } from "../src/network-import-container.js";
import { createNetworkImportTransport } from "../src/network-import-transport.js";
import { EventEmitter } from "node:events";

let checks = 0;
for (const provider of ["github", "figma"]) for (const changed of [false, true]) {
  const packageBytes = await readFile(new URL("../src/network-import-stdio.js", import.meta.url));
  const fixture = networkFixture({ provider, changed, packageBytes, imageId: `sha256:${"a".repeat(64)}` });
  const host = createPluginExecutionGrant(fixture.input.acquisition.manifest, fixture.input.request, fixture.input.acquisition.policy);
  const worker = createPluginExecutionGrant(fixture.input.execution.manifest, fixture.input.request, fixture.input.execution.policy);
  assert.deepEqual(host.capability.permissions.network, [`https://api.${provider}.com`]);
  assert.deepEqual(worker.capability.permissions.network, []); assert.deepEqual(worker.capability.permissions.secrets, []);
  assert.equal(verifyPluginSupplyChain({ manifest: fixture.input.execution.manifest, expectedPackageDigest: fixture.runtimeBinding.packageDigest,
    artifacts: fixture.input.execution.artifacts }).status, "matched");
  const responses = [], prefix = `https://api.${provider}.com`;
  const settings = { permission: fixture.input.acquisition.permission, now: () => FIXTURE_TIME, fetchImpl: async url => {
    assert.ok(url.startsWith(prefix)); const path = url.slice(prefix.length); assert.ok(fixture.documents.has(path));
    const bytes = Buffer.from(JSON.stringify(fixture.documents.get(path))); responses.push({ path, bytes });
    return new Response(bytes, { headers: { "content-type": "application/json" } });
  } };
  const baseline = provider === "github" ? await importGitHubFile(fixture.input.request, { ...settings, token: FIXTURE_TOKEN }) :
    await importFigmaNode(fixture.input.request, { ...settings, credential: fixture.input.acquisition.credential });
  assert.equal(baseline.status, "success");
  const packed = packNetworkImportInput(fixture.input.request, responses, FIXTURE_TIME);
  const root = await mkdtemp(join(tmpdir(), "morivyx-network-fixture-"));
  try {
    for (const file of packed.files) await writeFile(join(root, file.path), file.bytes);
    assert.deepEqual(await convertNetworkImportInput(fixture.input.request, root), baseline);
    const firstTree = await fileTree(root); assert.equal(firstTree.length, packed.files.length);
    await writeFile(join(root, "extra.txt"), "fixture"); assert.notDeepEqual(await fileTree(root), firstTree);
  } finally { await rm(root, { recursive: true, force: true }); }
  checks++;
}
assert.throws(() => networkFixture({ provider: "unknown", packageBytes: Buffer.from("fixture"), imageId: "invalid" }));
for (const provider of ["github", "figma"]) {
  const root = await mkdtemp(join(tmpdir(), "morivyx-network-core-preflight-"));
  try {
    const empty = join(root, "empty"), saved = [];
    await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
    await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
    await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
    const validateSaved = async path => {
      assert.equal((await validatePackage(path)).valid, true); saved.push({ path, tree: await fileTree(path) }); return readGraphPackage(path);
    };
    const preserve = async () => { for (const value of saved) assert.deepEqual(await fileTree(value.path), value.tree); };
    await validateSaved(empty);
    const packageBytes = Buffer.from("offline-shared-core-fixture"), imageId = `sha256:${"a".repeat(64)}`;
    const run = async (fixture, now = FIXTURE_TIME) => {
      const staging = await mkdtemp(join(root, "conversion-"));
      try {
        const packed = packNetworkImportInput(fixture.input.request, [...fixture.documents].map(([path, value]) =>
          ({ path, bytes: Buffer.from(JSON.stringify(value)) })), now);
        for (const file of packed.files) await writeFile(join(staging, file.path), file.bytes);
        return { result: await convertNetworkImportInput(fixture.input.request, staging) };
      } finally { await rm(staging, { recursive: true, force: true }); }
    };
    const fixture = networkFixture({ provider, packageBytes, imageId }), first = await run(fixture);
    await exerciseNetworkCore({ fixture, first, provider, packageBytes, imageId, root, empty, run, validateSaved, preserve });
    await preserve(); checks++;
  } finally { await rm(root, { recursive: true, force: true }); }
}
const http = await createNetworkFixtureServer();
try {
  for (const provider of ["github", "figma"]) {
    const fixture = networkFixture({ provider, packageBytes: Buffer.from("http-lifecycle-fixture"), imageId: `sha256:${"a".repeat(64)}` });
    http.state.fixture = fixture;
    const run = signal => runNetworkImportContainer(fixture.input, { runtimeBinding: fixture.runtimeBinding, signal,
      fetchImpl: http.fetchImpl, now: () => FIXTURE_TIME, transport: async () => { assert.fail("HTTP failure must not invoke Docker"); } });
    for (let round = 0; round < 5; round++) {
      http.state.status = 200; http.state.stall = false; delete fixture.input.acquisition.limits;
      const settings = { permission: fixture.input.acquisition.permission, fetchImpl: http.fetchImpl, now: () => FIXTURE_TIME };
      const ordinary = provider === "github" ? await importGitHubFile(fixture.input.request, { ...settings, token: FIXTURE_TOKEN }) :
        await importFigmaNode(fixture.input.request, { ...settings, credential: fixture.input.acquisition.credential });
      assert.equal(ordinary.status, "success"); await http.waitForIdle();
      http.state.stall = true;
      const controller = new AbortController();
      const observed = new Promise(resolve => { http.state.onRequest = resolve; });
      const pending = run(controller.signal);
      await Promise.race([observed, pending]); controller.abort();
      await assert.rejects(pending, { code: "NETWORK_IMPORT_CANCELLED" });
      http.state.onRequest = null; await http.waitForIdle();
      fixture.input.acquisition.limits = { timeoutMs: 100 };
      await assert.rejects(run(), { code: "NETWORK_IMPORT_TIMEOUT" }); await http.waitForIdle();
      delete fixture.input.acquisition.limits; http.state.stall = false;
      for (const [status, code] of [[302, "NETWORK_IMPORT_REDIRECT_DENIED"], [503, "NETWORK_IMPORT_SOURCE_UNAVAILABLE"]]) {
        http.state.status = status; const before = http.state.requests;
        await assert.rejects(run(), { code }); assert.equal(http.state.requests - before, 1); await http.waitForIdle();
      }
    }
    checks++;
  }
  assert.equal(http.state.rejected, 0);
} finally { await http.close(); }
const owned = createNetworkImportTransport(() => { assert.fail("invalid operation must not open a connection"); });
await assert.rejects(owned.fetchImpl("https://invalid.example.test", { method: "POST", redirect: "manual" }), { code: "NETWORK_IMPORT_OPERATION_DENIED" });
const aborted = new AbortController(); aborted.abort();
await assert.rejects(owned.fetchImpl("https://invalid.example.test", { method: "GET", redirect: "manual", signal: aborted.signal }), { code: "NETWORK_IMPORT_CANCELLED" });
await owned.close();
await assert.rejects(owned.fetchImpl("https://invalid.example.test", { method: "GET", redirect: "manual" }), { code: "NETWORK_IMPORT_CANCELLED" });
const closing = await createNetworkFixtureServer();
closing.state.fixture = networkFixture({ provider: "figma", packageBytes: Buffer.from("closing"), imageId: `sha256:${"a".repeat(64)}` });
closing.state.stall = true;
const observedClose = new Promise(resolve => { closing.state.onRequest = resolve; });
const closingResponse = closing.fetchImpl("https://api.figma.com/v1/files/fixtureFile/nodes?ids=1%3A2&version=1001",
  { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } }).then(() => null, error => error);
await observedClose; await closing.close();
assert.ok(await closingResponse); checks++;
const stuckRequest = new EventEmitter(); stuckRequest.end = () => {}; stuckRequest.destroy = () => {};
const stuck = createNetworkImportTransport(() => stuckRequest);
void stuck.fetchImpl("https://invalid.example.test", { method: "GET", redirect: "manual" }).catch(() => {});
await assert.rejects(stuck.close(), { code: "NETWORK_IMPORT_NETWORK_CLEANUP_FAILED" });
stuckRequest.emit("close"); checks++;
console.log(`Network isolation fixture audit passed: ${checks} paths including shared Core and repeated real HTTP lifecycles; no Docker or real service invoked.`);
