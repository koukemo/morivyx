import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { convertGitHubImportResponses, validateGitHubImportRequest, GITHUB_IMPORTER_PLUGIN_ID } from "./github-importer.js";
import { convertFigmaImportResponse, validateFigmaImportRequest, FIGMA_IMPORTER_PLUGIN_ID } from "./figma-importer.js";
import { NETWORK_IMPORT_INPUT_FORMAT, NETWORK_IMPORT_INPUT_PERMISSION, NETWORK_IMPORT_INDEX_FILE,
  NETWORK_IMPORT_LIMITS as LIMITS, networkResponseList, networkJson, networkDigest, networkJsonDigest,
  networkRecord, requireNetworkImport as check, networkImportError } from "./network-import-input.js";

export function validateNetworkImportRequest(value) {
  const request = networkJson(value);
  if (request.plugin?.id === GITHUB_IMPORTER_PLUGIN_ID) validateGitHubImportRequest(request);
  else if (request.plugin?.id === FIGMA_IMPORTER_PLUGIN_ID) validateFigmaImportRequest(request);
  else throw networkImportError("REQUEST_INVALID");
  return request;
}

function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Only raw response bytes are staged. Completed RunResults never enter the worker.
export function packNetworkImportInput(request, responses, retrievedAt) {
  const fixed = validateNetworkImportRequest(request), captured = networkResponseList(responses);
  check(validTime(retrievedAt));
  const files = [];
  const entries = captured.map(({ path, bytes }, ordinal) => {
    const chunks = [];
    for (let offset = 0; offset < bytes.length || offset === 0; offset += LIMITS.maxFileBytes) {
      const name = `response-${ordinal}-${chunks.length}.bin`;
      chunks.push(name);
      files.push({ path: name, permission: NETWORK_IMPORT_INPUT_PERMISSION,
        bytes: Buffer.from(bytes.subarray(offset, offset + LIMITS.maxFileBytes)) });
    }
    return { ordinal, path, bodyBytes: bytes.length, bodyDigest: networkDigest(bytes), chunks };
  });
  const index = { format: NETWORK_IMPORT_INPUT_FORMAT, requestDigest: networkJsonDigest(fixed), retrievedAt, responses: entries };
  const bytes = Buffer.from(JSON.stringify(index));
  check(bytes.length <= LIMITS.maxIndexBytes && files.length + 1 <= LIMITS.maxFiles &&
    files.reduce((sum, file) => sum + file.bytes.length, bytes.length) <= LIMITS.maxTotalBytes, "INPUT_LIMIT");
  files.unshift({ path: NETWORK_IMPORT_INDEX_FILE, permission: NETWORK_IMPORT_INPUT_PERMISSION, bytes });
  return { files, inputDigest: networkDigest(bytes) };
}

async function readBoundedFile(root, name, maximum) {
  let handle;
  try {
    handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= maximum && stat.nlink === 1, "INPUT_INVALID");
    const bytes = Buffer.alloc(maximum + 1); let size = 0;
    while (size <= maximum) {
      const part = await handle.read(bytes, size, bytes.length - size, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    check(size <= maximum && size === stat.size, "INPUT_LIMIT");
    return Buffer.from(bytes.subarray(0, size));
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("NETWORK_IMPORT_")) throw error;
    throw networkImportError("INPUT_INVALID");
  } finally { await handle?.close(); }
}

export async function readNetworkImportInput(request, root) {
  const fixed = validateNetworkImportRequest(request);
  check(typeof root === "string");
  let names;
  try { names = await readdir(root); } catch { throw networkImportError("INPUT_INVALID"); }
  check(names.length > 1 && names.length <= LIMITS.maxFiles, "INPUT_LIMIT");
  const rawIndex = await readBoundedFile(root, NETWORK_IMPORT_INDEX_FILE, LIMITS.maxIndexBytes);
  let index;
  try { index = networkJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawIndex)), LIMITS.maxIndexBytes); }
  catch { throw networkImportError("INPUT_INVALID"); }
  check(networkRecord(index, ["format", "requestDigest", "retrievedAt", "responses"]) &&
    index.format === NETWORK_IMPORT_INPUT_FORMAT && index.requestDigest === networkJsonDigest(fixed) &&
    validTime(index.retrievedAt) && Array.isArray(index.responses) && index.responses.length > 0 &&
    index.responses.length <= LIMITS.maxRequests, "INPUT_INVALID");
  const seen = new Set([NETWORK_IMPORT_INDEX_FILE]), responses = []; let total = rawIndex.length;
  for (const [ordinal, entry] of index.responses.entries()) {
    check(networkRecord(entry, ["ordinal", "path", "bodyBytes", "bodyDigest", "chunks"]) &&
      entry.ordinal === ordinal && Number.isSafeInteger(entry.bodyBytes) && entry.bodyBytes >= 0 &&
      entry.bodyBytes <= LIMITS.maxResponseBytes && typeof entry.bodyDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(entry.bodyDigest) && Array.isArray(entry.chunks) &&
      entry.chunks.length === Math.max(1, Math.ceil(entry.bodyBytes / LIMITS.maxFileBytes)), "INPUT_INVALID");
    const chunks = [];
    for (const [part, name] of entry.chunks.entries()) {
      check(name === `response-${ordinal}-${part}.bin` && names.includes(name) && !seen.has(name), "INPUT_INVALID");
      seen.add(name);
      const bytes = await readBoundedFile(root, name, LIMITS.maxFileBytes);
      check(bytes.length === Math.min(LIMITS.maxFileBytes, entry.bodyBytes - part * LIMITS.maxFileBytes), "INPUT_INVALID");
      total += bytes.length; check(total <= LIMITS.maxTotalBytes, "INPUT_LIMIT"); chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    check(networkDigest(bytes) === entry.bodyDigest, "INPUT_MISMATCH");
    responses.push({ path: entry.path, bytes });
  }
  const finalNames = await readdir(root);
  check(names.length === seen.size && finalNames.length === seen.size && finalNames.every(name => seen.has(name)), "INPUT_INVALID");
  return { responses: networkResponseList(responses), retrievedAt: index.retrievedAt, inputDigest: networkDigest(rawIndex) };
}

export async function convertNetworkImportInput(request, root) {
  const fixed = validateNetworkImportRequest(request);
  const { responses, retrievedAt } = await readNetworkImportInput(fixed, root);
  if (fixed.plugin.id === GITHUB_IMPORTER_PLUGIN_ID) return convertGitHubImportResponses(fixed, responses, retrievedAt);
  const { fileKey, nodeId, version } = fixed.input;
  const path = `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}&version=${encodeURIComponent(version)}`;
  check(responses.length === 1 && responses[0].path === path, "INPUT_MISMATCH");
  return convertFigmaImportResponse(fixed, responses[0].bytes, retrievedAt);
}
