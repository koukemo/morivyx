import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGitHubLiveValidation } from "./github-live-validation.mjs";

const root = await mkdtemp(join(tmpdir(), "morivyx-github-live-audit-"));
// A fresh test-only value is never a live credential.
const token = randomUUID();
const source = "PRIVATE_FILE_CONTENT_FOR_LIVE_AUDIT_";
const provider = "PRIVATE_PROVIDER_RESPONSE_FOR_LIVE_AUDIT";
const outputs = [];
let checks = 0;
const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha1 = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
async function check(operation) { await operation(); checks++; }
try {
  git(["init"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "source.txt"), `${source}before`); git(["add", "source.txt"]); git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture before"]);
  const before = git(["rev-parse", "HEAD"]);
  await writeFile(join(root, "source.txt"), `${source}after`); git(["add", "source.txt"]); git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture after"]);
  const after = git(["rev-parse", "HEAD"]);
  const packagePath = join(root, "fixture-package.bin"); await writeFile(packagePath, "fixture package bytes");
  const input = { allowNetwork: true, repositoryRoot: root, owner: "fixture-owner", repository: "fixture-repository", repositoryId: 123,
    before, after, locator: "source.txt", packagePath };
  function responseSource({ mismatch = false, unavailable = false } = {}) {
    let calls = 0;
    const documents = { "": { id: 123, full_name: "fixture-owner/fixture-repository" } };
    for (const [commit, text, tree] of [[before, `${source}before`, "a".repeat(40)], [after, `${source}after`, "b".repeat(40)]]) {
      const bytes = Buffer.from(mismatch ? `${source}wrong` : text), sha = sha1(bytes);
      documents[`/git/commits/${commit}`] = { sha: commit, tree: { sha: tree } };
      documents[`/git/trees/${tree}`] = { sha: tree, truncated: false, tree: [{ path: "source.txt", type: "blob", mode: "100644", sha, size: bytes.length }] };
      documents[`/git/blobs/${sha}`] = { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") };
    }
    const prefix = "https://api.github.com/repos/fixture-owner/fixture-repository";
    return { get calls() { return calls; }, fetchImpl: async (url, options) => {
      calls++; assert.ok(url.startsWith(prefix)); assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual");
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const suffix = url.slice(prefix.length); assert.ok(Object.hasOwn(documents, suffix));
      return new Response(JSON.stringify(unavailable ? { message: provider } : documents[suffix]), { status: unavailable ? 403 : 200, headers: { "content-type": "application/json" } });
    } };
  }
  await check(async () => {
    const remote = responseSource(); const result = await runGitHubLiveValidation(input, { token, fetchImpl: remote.fetchImpl }); outputs.push(result.outputPath);
    assert.equal(result.valid, true); assert.equal(result.corePackages, 4); assert.equal(result.networkRequests, 16); assert.equal(remote.calls, 16);
    assert.equal(result.packageDigest, `sha256:${createHash("sha256").update(await readFile(packagePath)).digest("hex")}`);
    for (const key of ["observationPreservedArtifact", "explicitUpdatePreservedObservations", "rereadWithoutNetwork"]) assert.equal(result[key], true);
    for (const key of ["formalHumanMeasurement", "credentialsRetained", "sourceBodiesRetained"]) assert.equal(result[key], false);
    assert.equal(result.executionBinding, "not-verified");
    for (const forbidden of [token, source, provider]) assert.equal(JSON.stringify(result).includes(forbidden), false);
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), `${source}after`);
  });
  await check(async () => {
    const remote = responseSource();
    await assert.rejects(runGitHubLiveValidation({ ...input, allowNetwork: false }, { token, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_NETWORK_NOT_ALLOWED" });
    assert.equal(remote.calls, 0);
  });
  await check(async () => {
    const remote = responseSource();
    for (const value of [undefined, "", "contains newline\n", "x".repeat(8193)]) await assert.rejects(runGitHubLiveValidation(input, { token: value, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_TOKEN_INVALID" });
    assert.equal(remote.calls, 0);
  });
  await check(async () => {
    const remote = responseSource();
    for (const patch of [{ extra: true }, { after: before }, { before: "main" }, { locator: "../source.txt" }, { repositoryId: 0 }])
      await assert.rejects(runGitHubLiveValidation({ ...input, ...patch }, { token, fetchImpl: remote.fetchImpl }));
    assert.equal(remote.calls, 0);
  });
  await check(async () => {
    const remote = responseSource();
    await assert.rejects(runGitHubLiveValidation({ ...input, packagePath: root }, { token, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_PACKAGE_INVALID" });
    assert.equal(remote.calls, 0);
  });
  await check(async () => {
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "same content"]);
    const remote = responseSource();
    await assert.rejects(runGitHubLiveValidation({ ...input, before: after, after: git(["rev-parse", "HEAD"]) }, { token, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_NO_CONTENT_CHANGE" });
    assert.equal(remote.calls, 0);
  });
  await check(async () => {
    const remote = responseSource({ unavailable: true });
    await assert.rejects(runGitHubLiveValidation(input, { token, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_SOURCE_UNAVAILABLE" }); assert.equal(remote.calls, 1);
  });
  await check(async () => {
    const remote = responseSource({ mismatch: true });
    await assert.rejects(runGitHubLiveValidation(input, { token, fetchImpl: remote.fetchImpl }), { code: "GITHUB_LIVE_DIGEST_MISMATCH" }); assert.equal(remote.calls, 4);
  });
  await check(async () => {
    const entry = fileURLToPath(new URL("./github-live-validation.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [entry, "--unknown", provider], { encoding: "utf8", env: { ...process.env, MORIVYX_GITHUB_TOKEN: token }, timeout: 5000 });
    assert.equal(child.status, 1); const output = child.stdout + child.stderr;
    for (const forbidden of [token, provider, root]) assert.equal(output.includes(forbidden), false);
    assert.equal(JSON.parse(child.stderr).valid, false);
  });
} finally {
  for (const output of outputs) await rm(output, { recursive: true });
  await rm(root, { recursive: true });
}
assert.equal(checks, 9);
console.log(`GitHub live validation audit passed: ${checks} offline checks; no real network used.`);
