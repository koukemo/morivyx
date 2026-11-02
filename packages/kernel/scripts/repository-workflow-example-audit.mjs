import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRepositoryWorkflow as workflow } from "../examples/repository-workflow.mjs";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { validatePackage } from "../src/validator.js";

const example = fileURLToPath(new URL("../examples/repository-workflow.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "morivyx-repository-example-"));
const actor = `urn:uuid:${randomUUID()}`;
const hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const json = async path => JSON.parse(await readFile(path, "utf8"));
const args = (action, options) => [action, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
const run = (action, options) => workflow(args(action, options));
const missing = path => assert.rejects(access(path), { code: "ENOENT" });
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
async function tree(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    result[entry.name] = entry.isDirectory() ? await tree(target) : hash(await readFile(target));
  }
  return result;
}

try {
  const base = join(root, "base"), source = join(root, "source");
  const declaration = join(root, "manifest.json"), packageFile = join(root, "package.tgz");
  const first = join(root, "first.json"), second = join(root, "second.json");
  const created = join(root, "created"), updated = join(root, "updated");
  await cp(new URL("../../../docs/validation/fixtures/decision-maintenance-base", import.meta.url), base, { recursive: true });
  await mkdir(join(base, ".morivyx/schemas"), { recursive: true });
  await cp(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url), join(base, ".morivyx/schemas/morivyx.core@0.1.yaml"));
  await mkdir(source);
  // Only this fixture claims these bytes as its package. Runtime binding stays unverified.
  await writeFile(packageFile, "fixture-package-bytes\n");
  await writeFile(join(source, "source.txt"), "before\n");
  const baseBefore = await tree(base), sourceBefore = await tree(source);
  const initial = { base, "repository-root": source, locator: "source.txt", "external-id": "repository:example-test",
    manifest: declaration, actor, request: first };
  let firstSummary;

  await check("manifest uses actual supplied bytes and keeps unverified binding", async () => {
    const result = await run("manifest", { package: packageFile, output: declaration });
    assert.equal(result.packageDigest, hash("fixture-package-bytes\n"));
    assert.equal((await json(declaration)).identity.packageDigest, result.packageDigest);
    assert.equal(result.executionBinding, "not-verified");
    if (process.platform !== "win32") assert.equal((await stat(declaration)).mode & 0o777, 0o600);
  });
  await check("new import preparation leaves source and Core untouched", async () => {
    firstSummary = await run("prepare-create", initial);
    assert.equal(firstSummary.savedToCore, false);
    assert.equal(firstSummary.comparison, "new");
    assert.equal(firstSummary.before, null);
    assert.equal(firstSummary.after.digest, hash("before\n"));
    assert.ok(firstSummary.informationLoss.includes("file-content-not-retained"));
    assert.equal((await json(first)).request.actor, actor);
    assert.deepEqual(await tree(base), baseBefore);
    assert.deepEqual(await tree(source), sourceBefore);
    await missing(created);
  });
  await check("existing request and manifest are never overwritten", async () => {
    const before = await readFile(first);
    await assert.rejects(run("prepare-create", initial), { code: "EEXIST" });
    await assert.rejects(run("manifest", { package: packageFile, output: declaration }), { code: "EEXIST" });
    assert.deepEqual(await readFile(first), before);
  });
  await check("prepared and applied snapshots agree even after source changes", async () => {
    await writeFile(join(source, "source.txt"), "after\n");
    const result = await run("apply", { prepared: first, output: created });
    assert.equal(result.savedToCore, true);
    assert.equal(result.sourceRereadAtApply, false);
    const contents = await readGraphPackage(created);
    assert.equal(contents.elements[0].attributes.digest, hash("before\n"));
    assert.equal(contents.elements[0].revision, firstSummary.artifactRevision);
    assert.equal(contents.elements[0].reviewState, "unreviewed");
    assert.equal((await validatePackage(created)).valid, true);
    assert.equal(JSON.stringify(contents.elements).includes("before\\n"), false);
    assert.deepEqual(await tree(base), baseBefore);
    assert.equal(await readFile(join(source, "source.txt"), "utf8"), "after\n");
  });
  await check("existing Core output is protected", async () => {
    const before = await tree(created);
    await assert.rejects(run("apply", { prepared: first, output: created }));
    assert.deepEqual(await tree(created), before);
  });
  const reimport = { base: created, previous: first, "repository-root": source, actor, request: second };
  await check("changed import reports both digests before explicit save", async () => {
    const before = await tree(created);
    const result = await run("prepare-reimport", reimport);
    assert.equal(result.comparison, "stale");
    assert.equal(result.assessment.status, "external-changed");
    assert.equal(result.before.digest, hash("before\n"));
    assert.equal(result.after.digest, hash("after\n"));
    assert.equal(result.savedToCore, false);
    assert.equal(result.artifactId, firstSummary.artifactId);
    assert.deepEqual(await tree(created), before);
    await missing(updated);
    await run("apply", { prepared: second, output: updated });
    const contents = await readGraphPackage(updated);
    assert.equal(contents.elements[0].attributes.digest, hash("after\n"));
    assert.equal(contents.changeSets.length, 2);
    assert.equal((await validatePackage(updated)).valid, true);
  });
  const next = { ...reimport, base: updated, previous: second, request: join(root, "next.json") };
  await check("unchanged external file creates no update request", async () => {
    const result = await run("prepare-reimport", next);
    assert.equal(result.comparison, "current");
    assert.equal(result.assessment.status, "unchanged");
    assert.equal(result.requestPath, null);
    await missing(next.request);
  });
  await check("missing target and unavailable repository stay distinct", async () => {
    await rm(join(source, "source.txt"));
    const result = await run("prepare-reimport", next);
    assert.equal(result.comparison, "missing");
    assert.equal(result.assessment.status, "external-missing");
    await rename(source, `${source}-held`);
    const unavailable = await run("prepare-reimport", next);
    assert.equal(unavailable.comparison, "unavailable");
    assert.equal(unavailable.assessment.status, "blocked-unavailable");
    await rename(`${source}-held`, source);
    await writeFile(join(source, "source.txt"), "third\n");
    await missing(next.request);
  });
  await check("simulated local edit is reported without update or overwrite", async () => {
    const contents = await readGraphPackage(updated);
    const original = contents.elements[0], edited = structuredClone(original);
    edited.attributes.externalVersion = "simulated-local-edit";
    edited.revision = revisionId(edited);
    const rootDigest = graphRootDigest([edited]);
    const resultingRevision = { ...contents.revision, id: `graph:${randomUUID()}`,
      parentRevision: contents.revision.id, rootDigest };
    const changeSet = { format: "morivyx.changeset/0.1", id: `urn:uuid:${randomUUID()}`,
      baseRevision: contents.revision.id, resultingRevision: resultingRevision.id, resultingRootDigest: rootDigest,
      schemaLockDigest: contents.calculatedSchemaLockDigest,
      operations: [{ op: "revise", targetId: edited.id, beforeRevision: original.revision, afterRevision: edited.revision }],
      provenance: { method: "asserted", actor, recordedAt: new Date().toISOString() }, recordedAt: new Date().toISOString() };
    const local = join(root, "locally-edited");
    await writeAppliedPackage({ basePath: updated, outputPath: local, changeSet, candidateElements: [edited], resultingRevision });
    const before = await tree(local);
    const result = await run("prepare-reimport", { ...next, base: local });
    assert.equal(result.comparison, "stale");
    assert.equal(result.assessment.status, "conflict");
    assert.equal(result.assessment.localStatus, "changed");
    assert.equal(result.requestPath, null);
    assert.deepEqual(await tree(local), before);
    await missing(next.request);
    await writeFile(join(source, "source.txt"), "after\n");
    const current = spawnSync(process.execPath, [example, ...args("prepare-reimport", { ...next, base: local })], { encoding: "utf8" });
    assert.equal(current.status, 1);
    assert.equal(JSON.parse(current.stdout).comparison, "current");
    assert.equal(JSON.parse(current.stdout).assessment.status, "local-changed");
    await writeFile(join(source, "source.txt"), "third\n");
  });
  await check("outputs inside source and base including symlink parents are blocked", async () => {
    for (const protectedRoot of [source, base]) {
      const target = join(protectedRoot, "forbidden.json");
      await assert.rejects(run("prepare-create", { ...initial, request: target }), { code: "REPOSITORY_EXAMPLE_OUTPUT_INSIDE_SOURCE" });
      await assert.rejects(run("apply", { prepared: first, output: join(protectedRoot, "forbidden-core") }), { code: "REPOSITORY_EXAMPLE_OUTPUT_INSIDE_SOURCE" });
      await missing(target);
    }
    const alias = join(root, "source-alias");
    await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(run("prepare-create", { ...initial, request: join(alias, "forbidden.json") }), { code: "REPOSITORY_EXAMPLE_OUTPUT_INSIDE_SOURCE" });
  });
  await check("changed preparation and wrong base are rejected before writing", async () => {
    const changed = await json(first);
    changed.artifactRevision = `sha256:${"0".repeat(64)}`;
    const tampered = join(root, "changed-request.json"), target = join(root, "rejected-output");
    await writeFile(tampered, JSON.stringify(changed));
    await assert.rejects(run("apply", { prepared: tampered, output: target }), { code: "REPOSITORY_EXAMPLE_PREPARATION_CHANGED" });
    changed.artifactRevision = firstSummary.artifactRevision;
    changed.basePath = created;
    await writeFile(tampered, JSON.stringify(changed));
    await assert.rejects(run("apply", { prepared: tampered, output: target }), { code: "IMPORT_SNAPSHOT_BASE_MISMATCH" });
    await missing(target);
  });
  await check("CLI errors do not echo untrusted values and help is read-only", async () => {
    const before = await tree(base);
    const help = spawnSync(process.execPath, [example, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /準備と保存は別操作/);
    for (const argv of [[], ["unknown-untrusted-value"], ["apply", "--unknown-untrusted-value", "secret-value"],
      args("prepare-create", { ...initial, actor: "secret-value" }),
      [...args("apply", { prepared: first, output: join(root, "never") }), "--output", "secret-value"]]) {
      const result = spawnSync(process.execPath, [example, ...argv], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).valid, false);
      assert.equal(result.stderr.includes("secret-value"), false);
      assert.equal(result.stderr.includes(root), false);
    }
    assert.deepEqual(await tree(base), before);
  });
  await check("bounded JSON inputs and invalid prepared formats are rejected", async () => {
    const path = join(root, "invalid.json");
    for (const value of ["null", "[]", "{broken", JSON.stringify({ format: "wrong" }), " ".repeat(1048577)]) {
      await writeFile(path, value);
      await assert.rejects(run("apply", { prepared: path, output: join(root, "invalid-output") }));
      await missing(join(root, "invalid-output"));
    }
    await writeFile(path, Buffer.from([0xff, 0x7b, 0x7d]));
    await assert.rejects(run("apply", { prepared: path, output: join(root, "invalid-output") }));
    await assert.rejects(run("apply", { prepared: base, output: join(root, "invalid-output") }), { code: "REPOSITORY_EXAMPLE_INPUT_LIMIT" });
  });
  await check("new import failures produce no prepared request", async () => {
    const target = join(root, "failed-create.json");
    for (const [patch, expected] of [[{ locator: "missing.txt" }, "missing"],
      [{ "repository-root": join(root, "missing-repository") }, "unavailable"],
      [{ locator: "../outside.txt" }, "invalid"]]) {
      const result = await run("prepare-create", { ...initial, ...patch, request: target });
      assert.equal(result.comparison, expected);
      assert.equal(result.requestPath, null);
      assert.equal(result.savedToCore, false);
      await missing(target);
    }
  });
  assert.equal(checks, 14);
  console.log(`Repository workflow example audit passed: ${checks} checks; explicit prepare/apply, real file changes and protected Core verified.`);
} finally { await rm(root, { recursive: true, force: true }); }
