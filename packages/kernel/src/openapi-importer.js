import { createHash } from "node:crypto";
import { types } from "node:util";
import { parseDocument } from "yaml";
import { canonicalJson } from "./canonical.js";
import { importErrorCode } from "./import-failure-data.js";
import { PLUGIN_RUN_RESULT_FORMAT, validatePluginRunRequest, validatePluginRunResult } from "./plugin-communication.js";

export const OPENAPI_IMPORTER_PLUGIN_ID = "morivyx.openapi-importer.dev";
export const OPENAPI_IMPORTER_PLUGIN_VERSION = "0.1.0";
export const OPENAPI_IMPORT_CAPABILITY_ID = "openapi.inspect-operation";
export const OPENAPI_IMPORT_LIMITS = Object.freeze({ maxDocumentBytes: 524288, maxDepth: 64 });
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const LOSS = ["document-text-not-retained", "non-selected-operations-not-retained", "descriptions-and-examples-not-retained",
  "parameters-and-schemas-not-interpreted", "security-and-server-settings-not-retained", "references-not-resolved", "operation-rename-history-not-tracked"];
const VERSION = /^3\.1\.[0-9]+$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SNAPSHOT_KEYS = ["kind", "externalIdentity", "locator", "digest", "digestRule", "retrievedAt", "openapiVersion", "operation", "informationLoss"];

class ImportError extends Error {
  constructor(code) { super("OpenAPIの取込条件または結果を確認できません。"); this.code = `OPENAPI_IMPORT_${code}`; }
}
function check(value, code) { if (!value) throw new ImportError(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, names) { return record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)); }
function text(value, limit) {
  try {
    return typeof value === "string" && value.length > 0 && [...value].length <= limit &&
      !/[\x00-\x1f\x7f]/u.test(value) && canonicalJson(value) === JSON.stringify(value);
  } catch { return false; }
}
function path(value) { return text(value, 2048) && value.startsWith("/"); }
function pointer(value, method) { return `/paths/${value.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}`; }
function plugin() { return { id: OPENAPI_IMPORTER_PLUGIN_ID, version: OPENAPI_IMPORTER_PLUGIN_VERSION }; }

export function validateOpenApiImportRequest(request) {
  try {
    check(!types.isProxy(request), "REQUEST_INVALID");
    validatePluginRunRequest(request);
    check(request.plugin.id === OPENAPI_IMPORTER_PLUGIN_ID && request.plugin.version === OPENAPI_IMPORTER_PLUGIN_VERSION &&
      request.capability.id === OPENAPI_IMPORT_CAPABILITY_ID && request.capability.effect === "pure" && text(request.runId, 256) &&
      keys(request.input, ["externalId", "documentText", "path", "method"]) && text(request.input.externalId, 512) &&
      path(request.input.path) && METHODS.includes(request.input.method) && typeof request.input.documentText === "string" &&
      request.input.documentText.length > 0, "REQUEST_INVALID");
    check(Buffer.byteLength(request.input.documentText) <= OPENAPI_IMPORT_LIMITS.maxDocumentBytes, "INPUT_LIMIT");
    check(Buffer.byteLength(JSON.stringify(request)) <= 1048576, "INPUT_LIMIT");
  } catch (error) {
    if (importErrorCode(error, ImportError.prototype, null) !== null) throw error;
    throw new ImportError("REQUEST_INVALID");
  }
  return request;
}

function metadata(input) {
  let document;
  try { document = JSON.parse(input.documentText); } catch { throw new ImportError("DOCUMENT_INVALID"); }
  const pending = [[document, 1]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (value === null || typeof value !== "object") continue;
    check(depth <= OPENAPI_IMPORT_LIMITS.maxDepth, "DOCUMENT_DEPTH");
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  // JSON.parse accepts duplicate names; the existing YAML parser checks names without converting numeric values.
  let parsed;
  try { parsed = parseDocument(input.documentText, { strict: true, uniqueKeys: true }); }
  catch { throw new ImportError("DOCUMENT_INVALID"); }
  check(parsed.errors.length === 0, "DOCUMENT_INVALID");
  check(record(document) && typeof document.openapi === "string" && VERSION.test(document.openapi), "VERSION_UNSUPPORTED");
  check(record(document.info) && typeof document.info.title === "string" && typeof document.info.version === "string", "DOCUMENT_INVALID");
  check(Object.hasOwn(document, "paths"), "TARGET_MISSING");
  check(record(document.paths), "DOCUMENT_INVALID");
  check(Object.hasOwn(document.paths, input.path), "TARGET_MISSING");
  const item = document.paths[input.path];
  check(record(item), "DOCUMENT_INVALID");
  check(!Object.hasOwn(item, "$ref"), "REFERENCE_UNSUPPORTED");
  check(Object.hasOwn(item, input.method), "TARGET_MISSING");
  const operation = item[input.method];
  check(record(operation), "DOCUMENT_INVALID");
  check(!Object.hasOwn(operation, "$ref"), "REFERENCE_UNSUPPORTED");
  const selected = { path: input.path, method: input.method };
  if (Object.hasOwn(operation, "operationId")) {
    check(text(operation.operationId, 512), "DOCUMENT_INVALID"); selected.operationId = operation.operationId;
  }
  return {
    kind: "openapi-operation-snapshot", externalIdentity: { system: "openapi", externalId: input.externalId },
    locator: pointer(input.path, input.method), digest: `sha256:${createHash("sha256").update(input.documentText, "utf8").digest("hex")}`,
    digestRule: "sha256-utf8-document", openapiVersion: document.openapi, operation: selected, informationLoss: [...LOSS],
  };
}

export function validateOpenApiImportResult(result, request = null) {
  try {
    validatePluginRunResult(result, request);
    if (request !== null) validateOpenApiImportRequest(request);
    check(result.plugin.id === OPENAPI_IMPORTER_PLUGIN_ID && result.plugin.version === OPENAPI_IMPORTER_PLUGIN_VERSION &&
      result.capabilityId === OPENAPI_IMPORT_CAPABILITY_ID, "RESULT_INVALID");
    if (result.status === "failure") return result;
    const value = result.output;
    check(keys(value, SNAPSHOT_KEYS) && value.kind === "openapi-operation-snapshot" &&
      keys(value.externalIdentity, ["system", "externalId"]) && value.externalIdentity.system === "openapi" &&
      text(value.externalIdentity.externalId, 512) && typeof value.openapiVersion === "string" && VERSION.test(value.openapiVersion) &&
      keys(value.operation, Object.hasOwn(value.operation ?? {}, "operationId") ? ["path", "method", "operationId"] : ["path", "method"]) &&
      path(value.operation.path) && METHODS.includes(value.operation.method) &&
      (!Object.hasOwn(value.operation, "operationId") || text(value.operation.operationId, 512)) &&
      value.locator === pointer(value.operation.path, value.operation.method) &&
      typeof value.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(value.digest) &&
      value.digestRule === "sha256-utf8-document" && typeof value.retrievedAt === "string" && TIME.test(value.retrievedAt) &&
      canonicalJson(value.informationLoss) === canonicalJson(LOSS), "RESULT_INVALID");
    if (request !== null) {
      const { retrievedAt, ...snapshot } = value;
      check(canonicalJson(snapshot) === canonicalJson(metadata(request.input)), "RESULT_MISMATCH");
    }
  } catch (error) {
    if (importErrorCode(error, ImportError.prototype, null) === "OPENAPI_IMPORT_RESULT_MISMATCH") throw error;
    throw new ImportError("RESULT_INVALID");
  }
  return result;
}

export function importOpenApiOperation(input, options = {}) {
  let runId = "invalid-run";
  try {
    validateOpenApiImportRequest(input);
    const request = structuredClone(input); runId = request.runId;
    const output = metadata(request.input);
    const { now = () => new Date().toISOString() } = options;
    check(typeof now === "function", "CLOCK_INVALID");
    const retrievedAt = now();
    check(typeof retrievedAt === "string" && TIME.test(retrievedAt), "CLOCK_INVALID");
    const result = { format: PLUGIN_RUN_RESULT_FORMAT, runId, plugin: plugin(), capabilityId: OPENAPI_IMPORT_CAPABILITY_ID,
      status: "success", output: { ...output, retrievedAt } };
    validateOpenApiImportResult(result, request);
    return result;
  } catch (error) {
    return { format: PLUGIN_RUN_RESULT_FORMAT, runId, plugin: plugin(), capabilityId: OPENAPI_IMPORT_CAPABILITY_ID,
      status: "failure", failure: { code: importErrorCode(error, ImportError.prototype, "OPENAPI_IMPORT_FAILED"),
        message: "OpenAPIの取込条件または結果を確認できません。" } };
  }
}
