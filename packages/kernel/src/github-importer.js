import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./canonical.js";
import { importErrorCode, safeImportRunId } from "./import-failure-data.js";
import { networkResponseList } from "./network-import-input.js";
import {
  PLUGIN_RUN_REQUEST_FORMAT,
  PLUGIN_RUN_RESULT_FORMAT,
  validatePluginRunRequest,
  validatePluginRunResult,
} from "./plugin-communication.js";

export const GITHUB_IMPORTER_PLUGIN_ID = "morivyx.github-importer.dev";
export const GITHUB_IMPORTER_PLUGIN_VERSION = "0.1.0";
export const GITHUB_IMPORT_CAPABILITY_ID = "github.read-file";
export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_IMPORT_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalResponseBytes: 8 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxRequests: 19,
});
const INFORMATION_LOSS = Object.freeze([
  "file-content-not-retained",
  "non-file-metadata-not-imported",
  "rename-history-not-tracked",
]);
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
const INPUT_KEYS = ["owner", "repository", "repositoryId", "commit", "locator"];

class ImportError extends Error {
  constructor(code) {
    super("GitHubの読取条件または取得結果を確認できませんでした。");
    this.code = code;
  }
}

function requireCondition(condition, code = "GITHUB_IMPORT_RESPONSE_INVALID") {
  if (!condition) throw new ImportError(code);
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function repositoryId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function locator(value) {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 1024 ||
      /[\\\x00-\x1f\x7f]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= 16 && parts.every((part) =>
    part !== "" && part !== "." && part !== "..");
}

function validInput(input) {
  return exactKeys(input, INPUT_KEYS) && matches(input.owner, OWNER) &&
    matches(input.repository, REPOSITORY) && repositoryId(input.repositoryId) &&
    matches(input.commit, SHA) && locator(input.locator);
}

export function validateGitHubImportRequest(request) {
  requireCondition(!types.isProxy(request), "GITHUB_IMPORT_REQUEST_INVALID");
  try {
    validatePluginRunRequest(request);
  } catch {
    throw new ImportError("GITHUB_IMPORT_REQUEST_INVALID");
  }
  requireCondition(
    request.plugin.id === GITHUB_IMPORTER_PLUGIN_ID &&
      request.plugin.version === GITHUB_IMPORTER_PLUGIN_VERSION &&
      request.capability.id === GITHUB_IMPORT_CAPABILITY_ID &&
      request.capability.effect === "read-only" && validInput(request.input),
    "GITHUB_IMPORT_REQUEST_INVALID",
  );
  return request;
}

function timestamp(value) {
  if (!matches(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)) {
    return false;
  }
  const time = new Date(value);
  try {
    return Number.isFinite(time.getTime()) && canonicalJson(time.toISOString()) === canonicalJson(value);
  } catch { return false; }
}

export function validateGitHubImportResult(result, request = null) {
  try {
    validatePluginRunResult(result, request);
  } catch {
    throw new ImportError("GITHUB_IMPORT_RESULT_INVALID");
  }
  const code = "GITHUB_IMPORT_RESULT_INVALID";
  requireCondition(result.plugin.id === GITHUB_IMPORTER_PLUGIN_ID &&
    result.plugin.version === GITHUB_IMPORTER_PLUGIN_VERSION &&
    result.capabilityId === GITHUB_IMPORT_CAPABILITY_ID, code);
  if (request !== null) validateGitHubImportRequest(request);
  if (result.status === "failure") return result;
  const output = result.output;
  requireCondition(exactKeys(output, ["kind", "externalIdentity", "locator",
    "source", "digest", "digestRule", "byteLength", "retrievedAt", "informationLoss"]), code);
  requireCondition(exactKeys(output.externalIdentity, ["system", "repositoryId", "externalId"]) &&
    exactKeys(output.source, ["apiOrigin", "owner", "repository", "commit", "blobSha", "mode"]), code);
  const identity = output.externalIdentity;
  const source = output.source;
  requireCondition(output.kind === "github-file-snapshot" && identity.system === "github" &&
    validInput({ owner: source.owner, repository: source.repository,
      repositoryId: identity.repositoryId, commit: source.commit, locator: output.locator }) &&
    identity.externalId === `github:${identity.repositoryId}:${output.locator}` &&
    source.apiOrigin === GITHUB_API_ORIGIN && matches(source.blobSha, SHA) &&
    ["100644", "100755"].includes(source.mode) &&
    matches(output.digest, /^sha256:[0-9a-f]{64}$/) && output.digestRule === "sha256-bytes" &&
    Number.isSafeInteger(output.byteLength) && output.byteLength >= 0 &&
    output.byteLength <= GITHUB_IMPORT_LIMITS.maxFileBytes && timestamp(output.retrievedAt) &&
    JSON.stringify(output.informationLoss) === JSON.stringify(INFORMATION_LOSS), code);
  if (request !== null) {
    requireCondition(source.owner === request.input.owner &&
      source.repository === request.input.repository && source.commit === request.input.commit &&
      identity.repositoryId === request.input.repositoryId && output.locator === request.input.locator,
    "GITHUB_IMPORT_RESULT_MISMATCH");
  }
  return result;
}

export function githubImportRequest({ runId, owner, repository, repositoryId, commit, locator }) {
  return validateGitHubImportRequest({
    format: PLUGIN_RUN_REQUEST_FORMAT,
    runId,
    plugin: { id: GITHUB_IMPORTER_PLUGIN_ID, version: GITHUB_IMPORTER_PLUGIN_VERSION },
    capability: { id: GITHUB_IMPORT_CAPABILITY_ID, effect: "read-only" },
    input: { owner, repository, repositoryId, commit, locator },
  });
}

function authorize(input, permission) {
  requireCondition(exactKeys(permission, ["apiOrigin", "owner", "repository", "repositoryId"]) &&
    permission.apiOrigin === GITHUB_API_ORIGIN && permission.owner === input.owner &&
    permission.repository === input.repository && permission.repositoryId === input.repositoryId,
  "GITHUB_IMPORT_PERMISSION_DENIED");
}

function readLimits(overrides = {}) {
  requireCondition(record(overrides) && Object.keys(overrides).every((key) =>
    Object.hasOwn(GITHUB_IMPORT_LIMITS, key)), "GITHUB_IMPORT_LIMITS_INVALID");
  const limits = { ...GITHUB_IMPORT_LIMITS, ...overrides };
  requireCondition(Object.entries(limits).every(([key, value]) =>
    Number.isSafeInteger(value) && value > 0 && value <= GITHUB_IMPORT_LIMITS[key]),
  "GITHUB_IMPORT_LIMITS_INVALID");
  return limits;
}

function failure(request, error) {
  return {
    format: PLUGIN_RUN_RESULT_FORMAT,
    runId: safeImportRunId(request),
    plugin: { id: GITHUB_IMPORTER_PLUGIN_ID, version: GITHUB_IMPORTER_PLUGIN_VERSION },
    capabilityId: GITHUB_IMPORT_CAPABILITY_ID,
    status: "failure",
    failure: {
      code: importErrorCode(error, ImportError.prototype, "GITHUB_IMPORT_FAILED"),
      message: "GitHubの読取条件または取得結果を確認できませんでした。",
    },
  };
}

async function snapshot(request, { fetchImpl, token, now, limits, signal }) {
  const input = request.input;
  const prefix = `${GITHUB_API_ORIGIN}/repos/${input.owner}/${input.repository}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "morivyx-github-importer/0.1.0",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  let requestCount = 0;
  let totalBytes = 0;
  function active() {
    requireCondition(!signal.aborted, "GITHUB_IMPORT_TIMEOUT");
  }
  async function readJson(suffix = "") {
    active();
    requireCondition(++requestCount <= limits.maxRequests, "GITHUB_IMPORT_REQUEST_LIMIT");
    const url = `${prefix}${suffix}`;
    const response = await fetchImpl(url, { method: "GET", redirect: "manual",
      cache: "no-store", headers: { ...headers }, signal });
    let reader;
    try {
      active();
      requireCondition(response && !response.redirected &&
        (!response.url || response.url === url) && !(response.status >= 300 && response.status < 400),
      "GITHUB_IMPORT_REDIRECT_DENIED");
      requireCondition(response.status === 200, "GITHUB_IMPORT_SOURCE_UNAVAILABLE");
      requireCondition(/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
        response.headers.get("content-type") ?? ""));
      const declaredSize = response.headers.get("content-length");
      if (declaredSize !== null) {
        requireCondition(/^\d+$/.test(declaredSize) &&
          Number.isSafeInteger(Number(declaredSize)) && Number(declaredSize) <= limits.maxResponseBytes,
        "GITHUB_IMPORT_RESPONSE_LIMIT");
      }
      requireCondition(response.body !== null);
      reader = response.body.getReader();
    } catch (error) {
      // Unread and late responses also need cleanup; never wait for the adapter.
      try { void response?.body?.cancel().catch(() => {}); } catch { /* Keep the original failure. */ }
      throw error;
    }
    const chunks = [];
    let size = 0;
    let complete = false;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        active();
        if (done) break;
        requireCondition(value instanceof Uint8Array);
        size += value.byteLength;
        totalBytes += value.byteLength;
        requireCondition(size <= limits.maxResponseBytes && totalBytes <= limits.maxTotalResponseBytes,
          "GITHUB_IMPORT_RESPONSE_LIMIT");
        chunks.push(Buffer.from(value));
      }
      complete = true;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      reader.releaseLock();
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new ImportError("GITHUB_IMPORT_RESPONSE_INVALID");
    }
    requireCondition(record(value));
    return value;
  }

  return snapshotFromJson(request, readJson, now, limits, active);
}

async function snapshotFromJson(request, readJson, now, limits, active) {
  const input = request.input;
  const repository = await readJson();
  requireCondition(repository.id === input.repositoryId &&
    typeof repository.full_name === "string" &&
    repository.full_name.toLowerCase() === `${input.owner}/${input.repository}`.toLowerCase(),
  "GITHUB_IMPORT_IDENTITY_MISMATCH");
  const commit = await readJson(`/git/commits/${input.commit}`);
  requireCondition(commit.sha === input.commit && record(commit.tree) && matches(commit.tree.sha, SHA),
    "GITHUB_IMPORT_IDENTITY_MISMATCH");
  let treeSha = commit.tree.sha;
  let entry;
  const parts = input.locator.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const tree = await readJson(`/git/trees/${treeSha}`);
    requireCondition(tree.sha === treeSha && tree.truncated === false && Array.isArray(tree.tree),
      "GITHUB_IMPORT_TREE_INVALID");
    const names = new Set();
    for (const item of tree.tree) {
      requireCondition(record(item) && typeof item.path === "string" && item.path.length > 0 &&
        !item.path.includes("/") && !names.has(item.path), "GITHUB_IMPORT_TREE_INVALID");
      names.add(item.path);
    }
    entry = tree.tree.find((item) => item.path === parts[index]);
    requireCondition(entry !== undefined, "GITHUB_IMPORT_TARGET_MISSING");
    requireCondition(matches(entry.sha, SHA), "GITHUB_IMPORT_TREE_INVALID");
    if (index < parts.length - 1) {
      requireCondition(entry.type === "tree" && entry.mode === "040000", "GITHUB_IMPORT_KIND_UNSUPPORTED");
      treeSha = entry.sha;
    } else {
      requireCondition(entry.type === "blob" && ["100644", "100755"].includes(entry.mode),
        "GITHUB_IMPORT_KIND_UNSUPPORTED");
    }
  }
  requireCondition(Number.isSafeInteger(entry.size) && entry.size >= 0 &&
    entry.size <= limits.maxFileBytes, "GITHUB_IMPORT_FILE_LIMIT");
  const blob = await readJson(`/git/blobs/${entry.sha}`);
  requireCondition(blob.sha === entry.sha && blob.encoding === "base64" &&
    blob.size === entry.size && typeof blob.content === "string", "GITHUB_IMPORT_BLOB_INVALID");
  const encoded = blob.content.replace(/\r?\n/g, "");
  requireCondition(encoded.length <= 4 * Math.ceil(limits.maxFileBytes / 3) &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
  "GITHUB_IMPORT_BLOB_INVALID");
  const content = Buffer.from(encoded, "base64");
  requireCondition(content.length === blob.size && content.toString("base64") === encoded,
    "GITHUB_IMPORT_BLOB_INVALID");
  const blobSha = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  requireCondition(blobSha === entry.sha, "GITHUB_IMPORT_DIGEST_MISMATCH");
  active();
  return validateGitHubImportResult({
    format: PLUGIN_RUN_RESULT_FORMAT,
    runId: request.runId,
    plugin: { ...request.plugin },
    capabilityId: GITHUB_IMPORT_CAPABILITY_ID,
    status: "success",
    output: {
      kind: "github-file-snapshot",
      externalIdentity: { system: "github", repositoryId: input.repositoryId,
        externalId: `github:${input.repositoryId}:${input.locator}` },
      locator: input.locator,
      source: { apiOrigin: GITHUB_API_ORIGIN, owner: input.owner, repository: input.repository,
        commit: input.commit, blobSha, mode: entry.mode },
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      digestRule: "sha256-bytes",
      byteLength: content.length,
      retrievedAt: now(),
      informationLoss: [...INFORMATION_LOSS],
    },
  }, request);
}

// Recompute from captured raw responses; never invokes fetch or accepts credentials.
export async function convertGitHubImportResponses(request, responses, retrievedAt, overrides = {}) {
  validateGitHubImportRequest(request);
  const input = structuredClone(request), limits = readLimits(overrides);
  const captured = networkResponseList(responses);
  requireCondition(timestamp(retrievedAt), "GITHUB_IMPORT_RESULT_INVALID");
  requireCondition(captured.length <= limits.maxRequests, "GITHUB_IMPORT_REQUEST_LIMIT");
  const prefix = `/repos/${input.input.owner}/${input.input.repository}`;
  let cursor = 0, total = 0;
  const readJson = async (suffix = "") => {
    const response = captured[cursor++];
    requireCondition(response?.path === `${prefix}${suffix}`, "GITHUB_IMPORT_IDENTITY_MISMATCH");
    total += response.bytes.length;
    requireCondition(response.bytes.length <= limits.maxResponseBytes && total <= limits.maxTotalResponseBytes,
      "GITHUB_IMPORT_RESPONSE_LIMIT");
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
    catch { throw new ImportError("GITHUB_IMPORT_RESPONSE_INVALID"); }
    requireCondition(record(value));
    return value;
  };
  const result = await snapshotFromJson(input, readJson, () => retrievedAt, limits, () => {});
  requireCondition(cursor === captured.length, "GITHUB_IMPORT_RESPONSE_INVALID");
  return result;
}

export async function importGitHubFile(request, options = {}) {
  let timer;
  let controller;
  let inputRequest = request;
  try {
    validateGitHubImportRequest(request);
    // Keep the authorized identity stable across asynchronous network operations.
    inputRequest = JSON.parse(JSON.stringify(request));
    authorize(inputRequest.input, options.permission);
    const limits = readLimits(options.limits);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const now = options.now ?? (() => new Date().toISOString());
    const token = options.token;
    requireCondition(typeof fetchImpl === "function" && typeof now === "function" &&
      (token === undefined || (typeof token === "string" && token.length > 0 &&
        token.length <= 8192 && !/[\s\x00-\x1f\x7f]/u.test(token))), "GITHUB_IMPORT_OPTIONS_INVALID");
    controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ImportError("GITHUB_IMPORT_TIMEOUT"));
      }, limits.timeoutMs);
    });
    return await Promise.race([
      snapshot(inputRequest, { fetchImpl, token, now, limits, signal: controller.signal }), deadline,
    ]);
  } catch (error) {
    return failure(inputRequest, error);
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
