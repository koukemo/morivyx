import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { githubImportRequest, importGitHubFile } from "../src/github-importer.js";
import { writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { writeImportPresencePackage } from "../src/import-presence.js";
import { writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { readGraphPackage } from "../src/package-reader.js";
import { validatePluginManifest } from "../src/plugin-manifest.js";
import { validatePackage } from "../src/validator.js";

const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const id = () => `urn:uuid:${randomUUID()}`;
const time = () => new Date().toISOString();
const KEYS = ["allowNetwork", "repositoryRoot", "owner", "repository", "repositoryId", "before", "after", "locator", "packagePath"];
function check(value, code) {
  if (!value) { const error = new Error("実読取検証の入力または結果を確認してください。"); error.code = `GITHUB_LIVE_${code}`; throw error; }
}
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { timeout: 10000, maxBuffer: 1048577, stdio: ["ignore", "pipe", "pipe"] });
}
async function packageDigest(path) {
  check((await stat(path)).isFile(), "PACKAGE_INVALID");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= 67108864, "PACKAGE_INVALID");
    const hash = createHash("sha256"); let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536); const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead; check(total <= 67108864, "PACKAGE_INVALID"); hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally { await handle.close(); }
}
async function files(root) {
  const entries = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(await files(path))) entries[`${entry.name}/${name}`] = value;
    else entries[entry.name] = await readFile(path);
  }
  return entries;
}

// This opt-in integration check is not called by npm test or conformance.
// Injected fetch is for offline tests; production uses the platform fetch.
export async function runGitHubLiveValidation(input, { token, fetchImpl = globalThis.fetch } = {}) {
  check(input && Object.keys(input).length === KEYS.length && KEYS.every(key => Object.hasOwn(input, key)), "INPUT_INVALID");
  check(input.allowNetwork === true, "NETWORK_NOT_ALLOWED");
  check(typeof token === "string" && token.length >= 8 && token.length <= 8192 && !/[\s\x00-\x1f\x7f]/u.test(token), "TOKEN_INVALID");
  check(typeof fetchImpl === "function", "INPUT_INVALID");
  const config = structuredClone(input);
  const request = commit => githubImportRequest({ runId: `run:${randomUUID()}`, owner: config.owner,
    repository: config.repository, repositoryId: config.repositoryId, commit, locator: config.locator });
  request(config.before); request(config.after);
  check(config.before !== config.after && typeof config.repositoryRoot === "string" && typeof config.packagePath === "string", "INPUT_INVALID");
  const local = {};
  for (const commit of [config.before, config.after]) {
    check(git(config.repositoryRoot, ["rev-parse", `${commit}^{commit}`]).toString().trim() === commit, "COMMIT_INVALID");
    const bytes = git(config.repositoryRoot, ["show", `${commit}:${config.locator}`]);
    check(bytes.length <= 1048576, "FILE_LIMIT"); local[commit] = bytes;
  }
  check(sha256(local[config.before]) !== sha256(local[config.after]), "NO_CONTENT_CHANGE");
  const digest = await packageDigest(config.packagePath);
  const manifest = {
    format: "morivyx.plugin-manifest/0.1",
    identity: { id: "morivyx.github-importer.dev", version: "0.1.0", packageDigest: digest, distributor: "morivyx" },
    compatibility: { communicationContracts: ["morivyx.plugin-run-request/0.1", "morivyx.plugin-run-result/0.1"], coreSchemas: [], profileSchemas: [] },
    capabilities: [{ id: "github.read-file", effect: "read-only", inputFormat: "morivyx.github-read-input/0.1", outputFormat: "morivyx.github-file-snapshot/0.1",
      permissions: { graphRead: [], fileRead: [], network: ["https://api.github.com"], secrets: ["github-token"], devices: [] },
      retry: "safe-to-retry", resources: { timeoutMs: 30000, maxOutputBytes: 1048576 } }],
    supplyChain: { source: "local-package-declaration" }, migrations: [],
  };
  validatePluginManifest(manifest);
  let calls = 0;
  async function read(commit) {
    const runRequest = request(commit);
    const runResult = await importGitHubFile(runRequest, { token,
      permission: { apiOrigin: "https://api.github.com", owner: config.owner, repository: config.repository, repositoryId: config.repositoryId },
      fetchImpl: (url, options) => { calls++; return fetchImpl(url, options); } });
    check(runResult.status === "success", "SOURCE_UNAVAILABLE");
    check(runResult.output.digest === sha256(local[commit]) && runResult.output.byteLength === local[commit].length, "DIGEST_MISMATCH");
    return { runRequest, runResult };
  }
  const initial = await read(config.before);
  const root = await mkdtemp(join(tmpdir(), "morivyx-github-live-"));
  const empty = join(root, "empty");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), empty, { recursive: true });
  await mkdir(join(empty, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(empty, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  const actor = id(), artifactId = id(); const packages = [];
  let currentPath = empty;
  const common = async run => {
    const base = await readGraphPackage(currentPath);
    return { artifactId, actor, changeSetId: id(), resultingRevision: `graph:${randomUUID()}`,
      baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest, recordedAt: time(), manifest, ...run };
  };
  async function save(name, writer, request) {
    const before = await files(currentPath), outputPath = join(root, name);
    const result = await writer({ basePath: currentPath, outputPath, request });
    assert.deepEqual(await files(currentPath), before);
    check((await validatePackage(outputPath)).valid, "CORE_INVALID");
    currentPath = outputPath; const base = await readGraphPackage(outputPath);
    check(base.approvals.length === 0 && base.elements.every(x => x.lifecycle === "draft" && x.reviewState === "unreviewed"), "APPROVAL_CREATED");
    packages.push({ path: outputPath, bytes: await files(outputPath) }); return { result, base };
  }
  const created = await save("created", writeImportedSnapshotPackage, { ...await common(initial), format: "morivyx.import-snapshot-creation/0.1" });
  const original = created.base.elements.find(x => x.id === artifactId);
  const changed = await read(config.after);
  const observed = await save("observed", writeImportPresencePackage, { ...await common(changed), format: "morivyx.import-presence/0.1",
    observationId: id(), relationId: id(), baselineArtifactRevision: original.revision, observedAt: changed.runResult.output.retrievedAt });
  check(observed.result.comparison === "stale", "CHANGE_NOT_OBSERVED");
  assert.deepEqual(observed.base.elements.find(x => x.id === artifactId), original);
  const fresh = await read(config.after);
  const updated = await save("updated", writeReimportedSnapshotPackage, { ...await common(fresh), format: "morivyx.import-snapshot-revision/0.1", baselineArtifactRevision: original.revision });
  const artifact = updated.base.elements.find(x => x.id === artifactId);
  check(artifact.attributes.digest === sha256(local[config.after]) && artifact.attributes.externalVersion === config.after, "UPDATE_INVALID");
  for (const element of observed.base.elements.filter(x => x.id !== artifactId)) assert.deepEqual(updated.base.elements.find(x => x.id === element.id), element);
  const same = await read(config.after);
  const unchanged = await save("unchanged", writeImportPresencePackage, { ...await common(same), format: "morivyx.import-presence/0.1",
    observationId: id(), relationId: id(), baselineArtifactRevision: artifact.revision, observedAt: same.runResult.output.retrievedAt });
  check(unchanged.result.comparison === "current", "UNCHANGED_INVALID");
  assert.deepEqual(unchanged.base.elements.find(x => x.id === artifactId), artifact);
  const callsBeforeReread = calls;
  for (const item of packages) {
    await readGraphPackage(item.path); check((await validatePackage(item.path)).valid, "CORE_INVALID");
    const stored = await files(item.path); assert.deepEqual(stored, item.bytes);
    for (const bytes of Object.values(stored)) {
      check(!bytes.includes(Buffer.from(token)), "TOKEN_RETAINED");
      for (const source of Object.values(local)) if (source.length > 0) check(!bytes.includes(source), "SOURCE_RETAINED");
    }
  }
  check(calls === callsBeforeReread, "REREAD_USED_NETWORK");
  return { valid: true, outputPath: root, source: { owner: config.owner, repository: config.repository, repositoryId: config.repositoryId, locator: config.locator },
    before: { commit: config.before, digest: sha256(local[config.before]) }, after: { commit: config.after, digest: sha256(local[config.after]) },
    networkRequests: calls, packageDigest: digest, corePackages: packages.length, observationPreservedArtifact: true,
    explicitUpdatePreservedObservations: true, rereadWithoutNetwork: true, credentialsRetained: false, sourceBodiesRetained: false,
    executionBinding: "not-verified", formalHumanMeasurement: false, verifiedAt: time() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = ["repository-root", "owner", "repository", "repository-id", "before", "after", "locator", "package"];
    const { values, tokens } = parseArgs({ options: { "allow-network": { type: "boolean" }, ...Object.fromEntries(names.map(name => [name, { type: "string" }])) }, tokens: true });
    check(new Set(tokens.map(x => x.name)).size === tokens.length && names.every(name => typeof values[name] === "string" && values[name].length > 0), "ARGUMENTS_INVALID");
    const result = await runGitHubLiveValidation({ allowNetwork: values["allow-network"] === true,
      repositoryRoot: values["repository-root"], owner: values.owner, repository: values.repository, repositoryId: Number(values["repository-id"]),
      before: values.before, after: values.after, locator: values.locator, packagePath: values.package }, { token: process.env.MORIVYX_GITHUB_TOKEN });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = /^GITHUB_LIVE_[A-Z_]+$/.test(error.code ?? "") ? error.code : "GITHUB_LIVE_FAILED";
    process.stderr.write(`${JSON.stringify({ valid: false, code, message: "実読取検証の入力、権限、結果を確認してください。" })}\n`);
    process.exitCode = 1;
  }
}
