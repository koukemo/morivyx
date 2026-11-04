import { createHash } from "node:crypto";
import { types } from "node:util";
import { parseDocument } from "yaml";
import { canonicalJson, compareUnicode } from "./canonical.js";
import { importErrorCode } from "./import-failure-data.js";
import { PLUGIN_RUN_RESULT_FORMAT, validatePluginRunRequest, validatePluginRunResult } from "./plugin-communication.js";
import { servePluginStdio } from "./plugin-stdio.js";
import { networkBytes } from "./network-import-input.js";

export const FIGMA_IMPORTER_PLUGIN_ID = "morivyx.figma-importer.dev";
export const FIGMA_IMPORTER_PLUGIN_VERSION = "0.1.0";
export const FIGMA_IMPORT_CAPABILITY_ID = "figma.read-node";
export const FIGMA_API_ORIGIN = "https://api.figma.com";
export const FIGMA_IMPORT_LIMITS = Object.freeze({ timeoutMs: 30000, maxResponseBytes: 2097152, maxDepth: 64 });
const LOSS = ["node-json-not-retained", "node-names-and-text-not-retained", "geometry-and-paint-not-retained", "images-not-downloaded",
  "component-and-style-tables-not-retained", "plugin-data-not-requested", "file-metadata-not-retained", "node-rename-history-not-tracked", "json-number-lexemes-not-retained"];
const KEY = /^[A-Za-z0-9_-]{1,128}$/; const NODE_ID = /^[A-Za-z0-9:;_-]{1,256}$/;
const NODE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
class ImportError extends Error {
  constructor(code) { super("Figmaの読取条件または取得結果を確認できません。"); this.code = `FIGMA_IMPORT_${code}`; }
}
function check(value, code = "RESPONSE_INVALID") { if (!value) throw new ImportError(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, names) { return record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)); }
function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }
function logical(value, code) { try { canonicalJson(value); } catch { throw new ImportError(code); } }
function plugin() { return { id: FIGMA_IMPORTER_PLUGIN_ID, version: FIGMA_IMPORTER_PLUGIN_VERSION }; }

export function validateFigmaImportRequest(request) {
  try {
    check(!types.isProxy(request), "REQUEST_INVALID");
    validatePluginRunRequest(request);
    check(Buffer.byteLength(canonicalJson(request)) <= 1048576 &&
      request.plugin.id === FIGMA_IMPORTER_PLUGIN_ID && request.plugin.version === FIGMA_IMPORTER_PLUGIN_VERSION &&
      request.capability.id === FIGMA_IMPORT_CAPABILITY_ID && request.capability.effect === "read-only" &&
      typeof request.runId === "string" && request.runId.length <= 256 && canonicalJson(request.runId) === JSON.stringify(request.runId) &&
      keys(request.input, ["fileKey", "nodeId", "version"]) && matches(request.input.fileKey, KEY) &&
      matches(request.input.nodeId, NODE_ID) && matches(request.input.version, KEY), "REQUEST_INVALID");
  } catch { throw new ImportError("REQUEST_INVALID"); }
  return request;
}

export function validateFigmaImportResult(result, request = null) {
  try {
    validatePluginRunResult(result, request);
    if (request !== null) validateFigmaImportRequest(request);
    check(result.plugin.id === FIGMA_IMPORTER_PLUGIN_ID && result.plugin.version === FIGMA_IMPORTER_PLUGIN_VERSION &&
      result.capabilityId === FIGMA_IMPORT_CAPABILITY_ID, "RESULT_INVALID");
    if (result.status === "failure") return result;
    const value = result.output;
    check(keys(value, ["kind", "externalIdentity", "locator", "source", "node", "digest", "digestRule", "retrievedAt", "informationLoss"]) &&
      value.kind === "figma-node-snapshot" && keys(value.externalIdentity, ["system", "fileKey", "externalId"]) &&
      value.externalIdentity.system === "figma" && matches(value.externalIdentity.fileKey, KEY) && matches(value.locator, NODE_ID) &&
      value.externalIdentity.externalId === `figma:${value.externalIdentity.fileKey}:${value.locator}` &&
      keys(value.source, ["apiOrigin", "fileKey", "version"]) && value.source.apiOrigin === FIGMA_API_ORIGIN &&
      value.source.fileKey === value.externalIdentity.fileKey && matches(value.source.version, KEY) &&
      keys(value.node, ["id", "type"]) && value.node.id === value.locator && matches(value.node.type, NODE_TYPE) &&
      matches(value.digest, /^sha256:[0-9a-f]{64}$/) && value.digestRule === "sha256-sorted-json-node/0.1" &&
      matches(value.retrievedAt, TIME) && canonicalJson(value.informationLoss) === canonicalJson(LOSS), "RESULT_INVALID");
    if (request !== null) check(value.source.fileKey === request.input.fileKey && value.locator === request.input.nodeId &&
      value.source.version === request.input.version, "RESULT_MISMATCH");
  } catch (error) {
    if (importErrorCode(error, ImportError.prototype, null) === "FIGMA_IMPORT_RESULT_MISMATCH") throw error;
    throw new ImportError("RESULT_INVALID");
  }
  return result;
}

// External JSON digest only. This does not alter Core canonical form or normalize strings as dates/NFC.
function sortedNodeJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") { check(value.isWellFormed()); return JSON.stringify(value); }
  if (typeof value === "number") {
    check(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(sortedNodeJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareUnicode).map(key => {
    check(key.isWellFormed()); return `${JSON.stringify(key)}:${sortedNodeJson(value[key])}`;
  }).join(",")}}`;
}

function selectedNode(raw, input, limits) {
  let document;
  try { document = JSON.parse(raw); } catch { throw new ImportError("RESPONSE_INVALID"); }
  const pending = [[document, 1]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (!record(value) && !Array.isArray(value)) continue;
    check(depth <= limits.maxDepth, "RESPONSE_DEPTH");
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  let parsed;
  try { parsed = parseDocument(raw, { strict: true, uniqueKeys: true }); } catch { throw new ImportError("RESPONSE_INVALID"); }
  check(parsed.errors.length === 0 && record(document));
  check(document.err === undefined || document.err === null || document.err === "");
  check(document.version === input.version, "IDENTITY_MISMATCH");
  check(record(document.nodes) && Object.hasOwn(document.nodes, input.nodeId));
  const selected = document.nodes[input.nodeId]; check(selected !== null, "TARGET_MISSING");
  check(record(selected) && record(selected.document));
  const node = selected.document;
  check(node.id === input.nodeId, "IDENTITY_MISMATCH"); check(matches(node.type, NODE_TYPE));
  const encoded = sortedNodeJson(node); check(Buffer.byteLength(encoded) <= limits.maxResponseBytes, "RESPONSE_LIMIT");
  return { node: { id: node.id, type: node.type }, digest: `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}` };
}

async function snapshot(request, { fetchImpl, credential, now, limits, signal }) {
  const input = request.input;
  const url = `${FIGMA_API_ORIGIN}/v1/files/${encodeURIComponent(input.fileKey)}/nodes?ids=${encodeURIComponent(input.nodeId)}&version=${encodeURIComponent(input.version)}`;
  const headers = { Accept: "application/json" };
  if (credential.kind === "oauth") headers.Authorization = `Bearer ${credential.token}`;
  else headers["X-Figma-Token"] = credential.token;
  function active() { check(!signal.aborted, "TIMEOUT"); }
  const response = await fetchImpl(url, { method: "GET", redirect: "manual", cache: "no-store", headers, signal });
  let reader;
  try {
    active();
    check(response && !response.redirected && (!response.url || response.url === url) &&
      !(response.status >= 300 && response.status < 400), "REDIRECT_DENIED");
    check(response.status === 200, "SOURCE_UNAVAILABLE");
    check(/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? ""));
    const declared = response.headers.get("content-length");
    if (declared !== null) check(/^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) &&
      Number(declared) <= limits.maxResponseBytes, "RESPONSE_LIMIT");
    check(response.body !== null);
    reader = response.body.getReader();
  } catch (error) {
    // Unread and late responses also need cleanup; never wait for the adapter.
    try { void response?.body?.cancel().catch(() => {}); } catch { /* Keep the original failure. */ }
    throw error;
  }
  const chunks = []; let bytes = 0; let complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); active(); if (done) break;
      check(value instanceof Uint8Array); bytes += value.byteLength; check(bytes <= limits.maxResponseBytes, "RESPONSE_LIMIT");
      chunks.push(Buffer.from(value));
    }
    complete = true;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new ImportError("RESPONSE_INVALID"); }
  const selected = selectedNode(raw, input, limits); active();
  return resultFromNode(request, selected, now());
}

function resultFromNode(request, selected, retrievedAt) {
  const input = request.input;
  const result = { format: PLUGIN_RUN_RESULT_FORMAT, runId: request.runId, plugin: plugin(), capabilityId: FIGMA_IMPORT_CAPABILITY_ID,
    status: "success", output: { kind: "figma-node-snapshot", externalIdentity: { system: "figma", fileKey: input.fileKey,
      externalId: `figma:${input.fileKey}:${input.nodeId}` }, locator: input.nodeId,
      source: { apiOrigin: FIGMA_API_ORIGIN, fileKey: input.fileKey, version: input.version }, ...selected,
      digestRule: "sha256-sorted-json-node/0.1", retrievedAt, informationLoss: [...LOSS] } };
  validateFigmaImportResult(result, request); return result;
}

// Pure conversion of an already captured body; no token and no network adapter.
export function convertFigmaImportResponse(request, bytes, retrievedAt, overrides = {}) {
  validateFigmaImportRequest(request);
  logical(overrides, "LIMITS_INVALID");
  check(record(overrides) && Object.keys(overrides).every(key => Object.hasOwn(FIGMA_IMPORT_LIMITS, key)), "LIMITS_INVALID");
  const limits = { ...FIGMA_IMPORT_LIMITS, ...overrides };
  check(Object.entries(limits).every(([key, value]) => Number.isSafeInteger(value) && value > 0 &&
    value <= FIGMA_IMPORT_LIMITS[key]), "LIMITS_INVALID");
  const raw = networkBytes(bytes, limits.maxResponseBytes);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw new ImportError("RESPONSE_INVALID"); }
  return resultFromNode(request, selectedNode(text, request.input, limits), retrievedAt);
}

export async function importFigmaNode(input, options = {}) {
  let runId = "invalid-run"; let timer; let controller;
  try {
    validateFigmaImportRequest(input); const request = structuredClone(input); runId = request.runId;
    const { permission, credential, limits: overrides = {}, fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = options;
    logical(permission, "PERMISSION_DENIED");
    check(keys(permission, ["apiOrigin", "fileKey"]) && permission.apiOrigin === FIGMA_API_ORIGIN &&
      permission.fileKey === request.input.fileKey, "PERMISSION_DENIED");
    logical(credential, "CREDENTIAL_INVALID");
    check(keys(credential, ["kind", "token"]) && ["oauth", "personal-access-token"].includes(credential.kind) &&
      typeof credential.token === "string" && credential.token.length > 0 && credential.token.length <= 8192 &&
      !/[\s\x00-\x1f\x7f]/u.test(credential.token), "CREDENTIAL_INVALID");
    logical(overrides, "LIMITS_INVALID");
    check(record(overrides) && Object.keys(overrides).every(key => Object.hasOwn(FIGMA_IMPORT_LIMITS, key)), "LIMITS_INVALID");
    const limits = { ...FIGMA_IMPORT_LIMITS, ...overrides };
    check(Object.entries(limits).every(([key, value]) => Number.isSafeInteger(value) && value > 0 && value <= FIGMA_IMPORT_LIMITS[key]), "LIMITS_INVALID");
    check(typeof fetchImpl === "function" && typeof now === "function", "OPTIONS_INVALID");
    controller = new AbortController();
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      reject(new ImportError("TIMEOUT")); controller.abort();
    }, limits.timeoutMs); });
    return await Promise.race([snapshot(request, { fetchImpl, credential: structuredClone(credential), now, limits, signal: controller.signal }), deadline]);
  } catch (error) {
    return { format: PLUGIN_RUN_RESULT_FORMAT, runId, plugin: plugin(), capabilityId: FIGMA_IMPORT_CAPABILITY_ID, status: "failure",
      failure: { code: importErrorCode(error, ImportError.prototype, "FIGMA_IMPORT_FAILED"), message: "Figmaの読取条件または取得結果を確認できません。" } };
  } finally { clearTimeout(timer); controller?.abort(); }
}

export function serveFigmaImporter(options, streams) {
  return servePluginStdio({ handleRequest: request => importFigmaNode(request, options),
    validateRequest: validateFigmaImportRequest, validateResult: validateFigmaImportResult }, streams);
}
