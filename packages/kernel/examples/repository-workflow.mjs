import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../src/canonical.js";
import { restoreImportBaseline } from "../src/import-baseline.js";
import {
  IMPORT_SNAPSHOT_CREATION_FORMAT, prepareImportSnapshotCreation,
  validateImportSnapshotCreationRequest, writeImportedSnapshotPackage,
} from "../src/import-snapshot-creation.js";
import {
  IMPORT_SNAPSHOT_REVISION_FORMAT, prepareImportSnapshotRevision,
  validateImportSnapshotRevisionRequest, writeReimportedSnapshotPackage,
} from "../src/import-snapshot-revision.js";
import { readGraphPackage } from "../src/package-reader.js";
import { validatePluginManifest } from "../src/plugin-manifest.js";
import { assessRepositoryReimport } from "../src/repository-reimport-assessment.js";
import {
  REPOSITORY_IMPORTER_PLUGIN_ID, REPOSITORY_IMPORTER_PLUGIN_VERSION,
  compareRepositoryImportSnapshots, importRepositoryFile, repositoryImportRequest,
} from "../src/repository-importer.js";
import { validatePackage } from "../src/validator.js";

const PREPARATION = "morivyx.repository-workflow-example/0.1";
const JSON_LIMIT = 1048576;
const PACKAGE_LIMIT = 67108864;
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OPTIONS = {
  manifest: ["package", "output"],
  "prepare-create": ["base", "repository-root", "locator", "external-id", "manifest", "actor", "request"],
  "prepare-reimport": ["base", "previous", "repository-root", "actor", "request", "manifest"],
  apply: ["prepared", "output"],
};
const HELP = `使用方法:
  node packages/kernel/examples/repository-workflow.mjs manifest --package 配布ファイル --output 新規宣言ファイル
  node packages/kernel/examples/repository-workflow.mjs prepare-create --base 既存Core --repository-root 取込元 --locator 相対パス --external-id 外部識別値 --manifest 宣言ファイル --actor 主体ID --request 新規要求ファイル
  node packages/kernel/examples/repository-workflow.mjs prepare-reimport --base 保存済みCore --previous 前回要求ファイル --repository-root 取込元 --actor 主体ID --request 新規要求ファイル [--manifest 宣言ファイル]
  node packages/kernel/examples/repository-workflow.mjs apply --prepared 要求ファイル --output 新規Core出力先

準備と保存は別操作です。取込元と既存Coreは変更しません。
本文、Decision、人間の承認、正式測定値は保存しません。
保存するのは準備時の観測であり、保存時点の最新状態ではありません。
配布宣言と実行物の対応、署名、真正性は検証しません。
`;

function fail(code) {
  const error = new Error("実行例の入力、保存先、取込結果を確認してください。");
  error.code = `REPOSITORY_EXAMPLE_${code}`;
  throw error;
}

async function readBounded(path, limit, digestOnly = false) {
  if (!(await stat(path)).isFile()) fail("INPUT_LIMIT");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) fail("INPUT_LIMIT");
    const hash = createHash("sha256");
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) fail("INPUT_LIMIT");
      hash.update(buffer.subarray(0, bytesRead));
      if (!digestOnly) chunks.push(buffer.subarray(0, bytesRead));
    }
    return digestOnly ? `sha256:${hash.digest("hex")}` : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await file.close(); }
}

async function readJson(path) {
  const value = JSON.parse(await readBounded(path, JSON_LIMIT));
  canonicalJson(value);
  return value;
}

function contains(root, path) {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

async function outputPath(path, protectedRoots = []) {
  const absolute = resolve(path);
  const target = resolve(await realpath(dirname(absolute)), basename(absolute));
  for (const root of protectedRoots) {
    // A missing source remains protected by its lexical location.
    let canonicalRoot;
    try { canonicalRoot = await realpath(root); }
    catch (error) { if (error.code !== "ENOENT") throw error; canonicalRoot = resolve(root); }
    if (contains(canonicalRoot, target)) fail("OUTPUT_INSIDE_SOURCE");
  }
  return target;
}

async function saveJson(path, value, protectedRoots = []) {
  const target = await outputPath(path, protectedRoots);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > JSON_LIMIT) fail("INPUT_LIMIT");
  const file = await open(target, "wx", 0o600);
  try { await file.writeFile(text); } finally { await file.close(); }
  return target;
}

function validatePrepared(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "artifactRevision,basePath,format,request" ||
      value.format !== PREPARATION || typeof value.basePath !== "string" || !isAbsolute(value.basePath) ||
      typeof value.artifactRevision !== "string" || !DIGEST.test(value.artifactRevision)) fail("PREPARATION_INVALID");
  if (value.request?.format === IMPORT_SNAPSHOT_CREATION_FORMAT) validateImportSnapshotCreationRequest(value.request);
  else if (value.request?.format === IMPORT_SNAPSHOT_REVISION_FORMAT) validateImportSnapshotRevisionRequest(value.request);
  else fail("PREPARATION_INVALID");
  if (value.request.runResult.plugin.id !== REPOSITORY_IMPORTER_PLUGIN_ID) fail("PREPARATION_INVALID");
  return value;
}

async function loadBase(path) {
  const basePath = await realpath(path);
  if (!(await validatePackage(basePath)).valid) fail("BASE_INVALID");
  return { basePath, base: await readGraphPackage(basePath) };
}

async function manifest(options) {
  const packageDigest = await readBounded(options.package, PACKAGE_LIMIT, true);
  const value = {
    format: "morivyx.plugin-manifest/0.1",
    identity: { id: REPOSITORY_IMPORTER_PLUGIN_ID, version: REPOSITORY_IMPORTER_PLUGIN_VERSION,
      packageDigest, distributor: "morivyx" },
    compatibility: { communicationContracts: ["morivyx.plugin-run-request/0.1", "morivyx.plugin-run-result/0.1"],
      coreSchemas: [], profileSchemas: [] },
    capabilities: [{ id: "repository.read-file", effect: "read-only", inputFormat: "morivyx.repository-read-input/0.1",
      outputFormat: "morivyx.repository-file-snapshot/0.1",
      permissions: { graphRead: [], fileRead: ["repository-root"], network: [], secrets: [], devices: [] },
      retry: "safe-to-retry", resources: { timeoutMs: 5000, maxOutputBytes: JSON_LIMIT } }],
    supplyChain: { source: "local-package-declaration" }, migrations: [],
  };
  validatePluginManifest(value);
  const saved = await saveJson(options.output, value);
  return { valid: true, action: "manifest", outputPath: saved, packageDigest, executionBinding: "not-verified" };
}

function summary(request, prepared, comparison = null, assessment = null) {
  const snapshot = request.runResult.status === "success" ? request.runResult.output : null;
  const failure = request.runResult.failure?.code;
  const initialStatus = snapshot ? "new" : failure === "REPOSITORY_IMPORT_TARGET_MISSING" ? "missing" :
    ["REPOSITORY_IMPORT_SOURCE_UNAVAILABLE", "REPOSITORY_IMPORT_FAILED"].includes(failure) ? "unavailable" : "invalid";
  return {
    valid: true, savedToCore: false, artifactId: request.artifactId,
    comparison: comparison?.status ?? initialStatus, assessment,
    before: comparison?.previous ?? null,
    after: snapshot === null ? null : { digest: snapshot.digest, retrievedAt: snapshot.retrievedAt },
    source: { externalId: request.runRequest.input.externalId, locator: request.runRequest.input.locator },
    artifactRevision: prepared?.candidateElement.revision ?? null,
    executionBinding: "not-verified",
    informationLoss: prepared?.candidateElement.extensions["morivyx.import/snapshot"].informationLoss ??
      ["file-content-not-retained", "non-file-metadata-not-imported", "rename-history-not-tracked", "repository-commit-not-recorded"],
    failureCode: request.runResult.failure?.code ?? null,
  };
}

async function prepare(action, options) {
  if (!UUID.test(options.actor)) fail("ACTOR_INVALID");
  const { basePath, base } = await loadBase(options.base);
  const previous = action === "prepare-reimport" ? validatePrepared(await readJson(options.previous)) : null;
  const declared = options.manifest ? await readJson(options.manifest) : previous.request.manifest;
  validatePluginManifest(declared);
  const runRequest = repositoryImportRequest({
    runId: `run:${randomUUID()}`, repositoryRoot: resolve(options["repository-root"]),
    externalId: previous?.request.runRequest.input.externalId ?? options["external-id"],
    locator: previous?.request.runRequest.input.locator ?? options.locator,
  });
  const runResult = await importRepositoryFile(runRequest);
  const request = {
    format: previous ? IMPORT_SNAPSHOT_REVISION_FORMAT : IMPORT_SNAPSHOT_CREATION_FORMAT,
    artifactId: previous?.request.artifactId ?? `urn:uuid:${randomUUID()}`,
    changeSetId: `urn:uuid:${randomUUID()}`, baseRevision: base.revision.id, baseRootDigest: base.revision.rootDigest,
    resultingRevision: `graph:${randomUUID()}`, actor: options.actor, recordedAt: new Date().toISOString(),
    manifest: declared, runRequest, runResult,
    ...(previous ? { baselineArtifactRevision: previous.artifactRevision } : {}),
  };
  let prepared, comparison = null, assessment = null;
  if (previous) {
    const restored = restoreImportBaseline(base, request);
    comparison = compareRepositoryImportSnapshots({ previousResult: restored.previousResult, currentRequest: runRequest, currentResult: runResult });
    const target = base.elements.find(value => value.id === request.artifactId);
    assessment = assessRepositoryReimport({ comparison,
      baselineTarget: { id: request.artifactId, revision: previous.artifactRevision },
      currentTarget: target ? { id: target.id, revision: target.revision } : null });
    if (assessment.status !== "external-changed") return { ...summary(request, null, comparison, assessment), requestPath: null };
    prepared = prepareImportSnapshotRevision(base, request);
  } else {
    if (runResult.status !== "success") return { ...summary(request, null), requestPath: null };
    prepared = prepareImportSnapshotCreation(base, request);
  }
  const envelope = { format: PREPARATION, basePath, request, artifactRevision: prepared.candidateElement.revision };
  validatePrepared(envelope);
  const requestPath = await saveJson(options.request, envelope, [basePath, runRequest.input.repositoryRoot]);
  return { ...summary(request, prepared, comparison, assessment), requestPath };
}

async function apply(options) {
  const envelope = validatePrepared(await readJson(options.prepared));
  const { basePath, base } = await loadBase(envelope.basePath);
  const request = envelope.request;
  const create = request.format === IMPORT_SNAPSHOT_CREATION_FORMAT;
  const prepared = create ? prepareImportSnapshotCreation(base, request) : prepareImportSnapshotRevision(base, request);
  if (prepared.candidateElement.revision !== envelope.artifactRevision) fail("PREPARATION_CHANGED");
  const target = await outputPath(options.output, [basePath, request.runRequest.input.repositoryRoot]);
  const write = create ? writeImportedSnapshotPackage : writeReimportedSnapshotPackage;
  const result = await write({ basePath, outputPath: target, request });
  return { ...result, action: "apply", savedToCore: true, observedAt: request.runResult.output.retrievedAt,
    executionBinding: "not-verified", sourceRereadAtApply: false };
}

export async function runRepositoryWorkflow(args) {
  if (args.length === 1 && args[0] === "--help") return { help: HELP };
  const [action, ...rest] = args;
  if (!Object.hasOwn(OPTIONS, action)) fail("ARGUMENTS_INVALID");
  const { values, tokens } = parseArgs({ args: rest, options: Object.fromEntries(OPTIONS[action].map(key => [key, { type: "string" }])),
    strict: true, allowPositionals: false, tokens: true });
  const names = tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) fail("ARGUMENTS_INVALID");
  const required = OPTIONS[action].filter(key => !(action === "prepare-reimport" && key === "manifest"));
  if (required.some(key => typeof values[key] !== "string" || !values[key].trim())) fail("ARGUMENTS_INVALID");
  if (action === "manifest") return manifest(values);
  if (action === "apply") return apply(values);
  return prepare(action, values);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRepositoryWorkflow(process.argv.slice(2));
    process.stdout.write(result.help ?? `${JSON.stringify(result, null, 2)}\n`);
    if (result.requestPath === null && result.assessment?.status !== "unchanged") process.exitCode = 1;
  } catch (error) {
    // Do not echo malformed arguments, source values, absolute paths or native error messages.
    const code = /^(?:REPOSITORY_EXAMPLE_|IMPORT_SNAPSHOT_|IMPORT_REVISION_|IMPORT_BASELINE_)[A-Z_]+$/.test(error.code ?? "")
      ? error.code : "REPOSITORY_EXAMPLE_FAILED";
    process.stderr.write(`${JSON.stringify({ valid: false, savedToCore: false, code })}\n`);
    process.exitCode = 1;
  }
}
