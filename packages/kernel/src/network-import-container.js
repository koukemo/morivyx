import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createNetworkImportTransport } from "./network-import-transport.js";
import { canonicalJson } from "./canonical.js";
import { createPluginExecutionGrant } from "./plugin-communication.js";
import { runPluginContainer, PLUGIN_CONTAINER_LIMITS } from "./plugin-container.js";
import { verifyPluginSupplyChain } from "./plugin-supply-chain.js";
import { importGitHubFile, GITHUB_IMPORTER_PLUGIN_ID, GITHUB_API_ORIGIN, GITHUB_IMPORT_LIMITS } from "./github-importer.js";
import { importFigmaNode, FIGMA_API_ORIGIN, FIGMA_IMPORT_LIMITS } from "./figma-importer.js";
import { packNetworkImportInput, validateNetworkImportRequest } from "./network-import-conversion.js";
import { networkRecord, networkJson, networkJsonDigest, requireNetworkImport as check, networkImportError,
  networkBytes, NETWORK_IMPORT_INPUT_PERMISSION, NETWORK_IMPORT_LIMITS } from "./network-import-input.js";

const same = isDeepStrictEqual;
const noPermissions = (grant, keys) => keys.every(key => grant.capability.permissions[key].length === 0);
const SAFE_CODES = new Set(["INPUT_INVALID", "INPUT_LIMIT", "OPTIONS_INVALID", "BINDING_MISMATCH", "PACKAGE_MISMATCH",
  "REQUEST_INVALID", "PERMISSION_DENIED", "CREDENTIAL_INVALID", "LIMITS_INVALID", "CANCELLED", "TIMEOUT",
  "OPERATION_DENIED", "TARGET_MISMATCH", "REQUEST_LIMIT", "REDIRECT_DENIED", "SOURCE_UNAVAILABLE", "RESPONSE_INVALID",
  "RESPONSE_LIMIT", "CLOCK_INVALID", "RESULT_MISMATCH", "ISOLATION_UNAVAILABLE", "PLUGIN_FAILED"].map(code => `NETWORK_IMPORT_${code}`));
function codeOf(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" ? descriptor.value : "";
  } catch { return ""; }
}
function boundedError(error, fallback) {
  const code = codeOf(error);
  return networkImportError(SAFE_CODES.has(code) ? code.slice("NETWORK_IMPORT_".length) : fallback);
}

function prepare(input, options) {
  check(networkRecord(input, ["request", "acquisition", "execution"]));
  check(networkRecord(input.execution, ["manifest", "policy", "imageId", "artifacts"]));
  check(networkRecord(options, ["runtimeBinding", "fetchImpl", "transport", "dockerPath", "signal", "now"], ["runtimeBinding"]), "OPTIONS_INVALID");
  const candidate = networkJson(input.request);
  check(candidate.capability?.effect === "read-only", "OPERATION_DENIED");
  let request;
  try { request = validateNetworkImportRequest(candidate); } catch { throw networkImportError("REQUEST_INVALID"); }
  const acquisition = networkJson(input.acquisition);
  const execution = { manifest: networkJson(input.execution.manifest), policy: networkJson(input.execution.policy),
    imageId: networkJson(input.execution.imageId) };
  const binding = networkJson(options.runtimeBinding);
  check(networkRecord(binding, ["manifestDigest", "packageDigest", "imageId"]) &&
    typeof execution.imageId === "string" && /^sha256:[0-9a-f]{64}$/.test(execution.imageId) &&
    binding.imageId === execution.imageId && binding.manifestDigest === networkJsonDigest(execution.manifest) &&
    binding.packageDigest === execution.manifest.identity?.packageDigest, "BINDING_MISMATCH");
  // runtimeBinding is a trusted host build/approval record, not evidence supplied by a Plugin.
  // The image is selected by immutable ID; artifact hashing does not authenticate its publisher.
  const supplyChain = verifyPluginSupplyChain({ manifest: execution.manifest,
    expectedPackageDigest: binding.packageDigest, artifacts: input.execution.artifacts });
  check(supplyChain.status === "matched", "PACKAGE_MISMATCH");
  check(networkRecord(acquisition, ["manifest", "policy", "permission", "credential", "limits"],
    ["manifest", "policy", "permission"]));
  let hostGrant, workerGrant;
  try {
    hostGrant = createPluginExecutionGrant(acquisition.manifest, request, acquisition.policy);
    workerGrant = createPluginExecutionGrant(execution.manifest, request, execution.policy);
  } catch { throw networkImportError("PERMISSION_DENIED"); }
  const github = request.plugin.id === GITHUB_IMPORTER_PLUGIN_ID;
  const inputFormat = github ? "morivyx.github-read-input/0.1" : "morivyx.figma-node-input/0.1";
  const outputFormat = github ? "morivyx.github-file-snapshot/0.1" : "morivyx.figma-node-snapshot/0.1";
  for (const manifest of [acquisition.manifest, execution.manifest]) {
    const capability = manifest.capabilities.find(value => value.id === request.capability.id);
    check(capability.inputFormat === inputFormat && capability.outputFormat === outputFormat, "REQUEST_INVALID");
  }
  const origin = github ? GITHUB_API_ORIGIN : FIGMA_API_ORIGIN;
  const secret = github ? "github-read-token" : "figma-read-token";
  check(noPermissions(hostGrant, ["graphRead", "fileRead", "devices"]) &&
    same(hostGrant.capability.permissions.network, [origin]) &&
    (same(hostGrant.capability.permissions.secrets, [secret]) ||
      (github && acquisition.credential === undefined && hostGrant.capability.permissions.secrets.length === 0)), "PERMISSION_DENIED");
  check(noPermissions(workerGrant, ["graphRead", "network", "secrets", "devices"]) &&
    same(workerGrant.capability.permissions.fileRead, [NETWORK_IMPORT_INPUT_PERMISSION]), "PERMISSION_DENIED");
  const permission = github ? { apiOrigin: origin, owner: request.input.owner,
    repository: request.input.repository, repositoryId: request.input.repositoryId } : { apiOrigin: origin, fileKey: request.input.fileKey };
  check(same(acquisition.permission, permission), "PERMISSION_DENIED");
  if (acquisition.credential !== undefined || !github) {
    const credential = acquisition.credential;
    check(networkRecord(credential, github ? ["token"] : ["kind", "token"]) &&
      (github || ["oauth", "personal-access-token"].includes(credential.kind)) &&
      typeof credential.token === "string" && credential.token.length > 0 && credential.token.length <= 8192 &&
      !/[\s\u0000-\u001f\u007f]/u.test(credential.token), "CREDENTIAL_INVALID");
  }
  const defaults = github ? GITHUB_IMPORT_LIMITS : FIGMA_IMPORT_LIMITS, overrides = acquisition.limits ?? {};
  check(networkRecord(overrides, Object.keys(defaults), []), "LIMITS_INVALID");
  const limits = { ...defaults, ...overrides };
  check(Object.entries(limits).every(([key, value]) => Number.isSafeInteger(value) && value > 0 && value <= defaults[key]), "LIMITS_INVALID");
  for (const grant of [hostGrant, workerGrant]) {
    check(!Object.hasOwn(grant.capability.resources, "maxCostUnits") &&
      (grant.capability.resources.maxMemoryBytes ?? PLUGIN_CONTAINER_LIMITS.defaultMemoryBytes) >= PLUGIN_CONTAINER_LIMITS.minMemoryBytes,
    "LIMITS_INVALID");
  }
  limits.timeoutMs = Math.min(limits.timeoutMs, hostGrant.capability.resources.timeoutMs,
    workerGrant.capability.resources.timeoutMs, NETWORK_IMPORT_LIMITS.timeoutMs);
  execution.policy.capability.resources.maxOutputBytes = Math.min(hostGrant.capability.resources.maxOutputBytes,
    workerGrant.capability.resources.maxOutputBytes, PLUGIN_CONTAINER_LIMITS.maxOutputBytes);
  check(Buffer.byteLength(JSON.stringify(request)) + 1 <= PLUGIN_CONTAINER_LIMITS.maxRequestBytes &&
    Buffer.byteLength(canonicalJson(workerGrant)) <= PLUGIN_CONTAINER_LIMITS.maxGrantBytes, "INPUT_LIMIT");
  const fetchImpl = options.fetchImpl, now = options.now ?? (() => new Date().toISOString());
  check((fetchImpl === undefined || typeof fetchImpl === "function") && typeof now === "function" &&
    (options.transport === undefined || typeof options.transport === "function") &&
    (options.signal === undefined || options.signal instanceof AbortSignal) &&
    (options.dockerPath === undefined || (typeof options.dockerPath === "string" && isAbsolute(options.dockerPath) && !options.dockerPath.includes("\0"))), "OPTIONS_INVALID");
  return { request, acquisition, execution, binding, github, origin, limits, fetchImpl, now,
    transport: options.transport, signal: options.signal, dockerPath: options.dockerPath };
}

// Explicit public API adopted under ADR-0019. No implicit CLI route or Core write.
export async function runNetworkImportContainer(input, options = {}) {
  let p;
  try { p = prepare(input, options); }
  catch (error) { throw boundedError(error, "INPUT_INVALID"); }
  // All caller-owned data used after await is owned or a trusted host adapter.
  check(!p.signal?.aborted, "CANCELLED");
  const ownedTransport = p.fetchImpl === undefined ? createNetworkImportTransport() : null;
  p.fetchImpl ??= ownedTransport.fetchImpl;
  const controller = new AbortController(), responses = [];
  const started = Date.now(), deadline = started + p.limits.timeoutMs;
  let stopCode = null, captureError = null, retrievedAt = null, totalBytes = 0, requestCount = 0;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // A later abort during Docker cleanup must not cause an unhandled rejection.
  void stopped.catch(() => {});
  const stop = code => { if (!stopCode) { stopCode = code; controller.abort(); rejectStopped(networkImportError(code)); } };
  const abort = () => stop("CANCELLED");
  const timer = setTimeout(() => stop("TIMEOUT"), p.limits.timeoutMs);
  p.signal?.addEventListener("abort", abort, { once: true });
  const active = () => { if (Date.now() >= deadline) stop("TIMEOUT"); check(!stopCode, stopCode ?? "TIMEOUT"); };
  const fetchCaptured = async (url, settings) => {
    let response, reader, complete = false;
    const cancelBody = () => {
      try { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); } catch { /* bounded best effort */ }
    };
    try {
      active();
      check(typeof url === "string" && url.startsWith(`${p.origin}/`) && settings.method === "GET" &&
        settings.redirect === "manual" && settings.body === undefined, "OPERATION_DENIED");
      const path = url.slice(p.origin.length);
      const prefix = `/repos/${p.request.input.owner}/${p.request.input.repository}`;
      const figmaPath = `/v1/files/${encodeURIComponent(p.request.input.fileKey)}/nodes?ids=${encodeURIComponent(p.request.input.nodeId)}&version=${encodeURIComponent(p.request.input.version)}`;
      check(p.github ? (path === prefix || (path.startsWith(`${prefix}/git/`) &&
        /\/(?:commits|trees|blobs)\/[0-9a-f]{40}$/.test(path))) : path === figmaPath, "TARGET_MISMATCH");
      requestCount++;
      check(requestCount <= (p.github ? p.limits.maxRequests : 1), "REQUEST_LIMIT");
      response = await p.fetchImpl(url, { ...settings, signal: AbortSignal.any([settings.signal, controller.signal]) });
      active();
      check(response && !response.redirected && (!response.url || response.url === url) &&
        !(response.status >= 300 && response.status < 400), "REDIRECT_DENIED");
      check(response.status === 200, "SOURCE_UNAVAILABLE");
      check(/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? ""), "RESPONSE_INVALID");
      const declared = response.headers.get("content-length");
      check(declared === null || (/^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) && Number(declared) <= p.limits.maxResponseBytes), "RESPONSE_LIMIT");
      check(response.body !== null, "RESPONSE_INVALID");
      reader = response.body.getReader();
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      const chunks = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); active();
        if (chunk.done) { complete = true; break; }
        let bytes;
        try { bytes = networkBytes(chunk.value, p.limits.maxResponseBytes); }
        catch (error) { throw networkImportError(codeOf(error) === "NETWORK_IMPORT_INPUT_LIMIT" ? "RESPONSE_LIMIT" : "RESPONSE_INVALID"); }
        size += bytes.length; totalBytes += bytes.length;
        check(size <= p.limits.maxResponseBytes && totalBytes <= (p.github ? p.limits.maxTotalResponseBytes : p.limits.maxResponseBytes), "RESPONSE_LIMIT");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      retrievedAt = p.now();
      check(typeof retrievedAt === "string" && Number.isFinite(Date.parse(retrievedAt)), "CLOCK_INVALID");
      retrievedAt = new Date(retrievedAt).toISOString();
      responses.push({ path, bytes });
      return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      captureError = boundedError(error, "SOURCE_UNAVAILABLE");
      throw captureError;
    } finally {
      controller.signal.removeEventListener("abort", cancelBody);
      if (!complete) cancelBody();
      try { reader?.releaseLock(); } catch { /* no result is trusted on failure */ }
    }
  };
  try {
    const settings = { permission: p.acquisition.permission, limits: p.limits, fetchImpl: fetchCaptured, now: () => retrievedAt };
    const acquisition = p.github ? importGitHubFile(p.request, { ...settings, token: p.acquisition.credential?.token }) :
      importFigmaNode(p.request, { ...settings, credential: p.acquisition.credential });
    const baseline = await Promise.race([acquisition, stopped]);
    active();
    if (captureError) throw captureError;
    if (baseline.status !== "success") {
      const code = baseline.failure.code;
      throw networkImportError(code.endsWith("IDENTITY_MISMATCH") || code.endsWith("TARGET_MISSING") ? "TARGET_MISMATCH" :
        code.endsWith("TIMEOUT") ? "TIMEOUT" : code.endsWith("REQUEST_LIMIT") ? "REQUEST_LIMIT" :
          code.endsWith("RESPONSE_LIMIT") || code.endsWith("RESPONSE_DEPTH") ? "RESPONSE_LIMIT" : "RESPONSE_INVALID");
    }
    const packed = packNetworkImportInput(p.request, responses, retrievedAt);
    active();
    p.execution.policy.capability.resources.timeoutMs = Math.max(1, deadline - Date.now());
    // Do not race this promise: cleanup must finish (or fail explicitly) before returning.
    const isolated = await runPluginContainer({ ...p.execution, request: p.request, files: packed.files },
      { transport: p.transport, signal: controller.signal, dockerPath: p.dockerPath });
    active();
    check(isolated.result.status === "success", "PLUGIN_FAILED");
    check(same(isolated.result, baseline), "RESULT_MISMATCH");
    active();
    return { format: "morivyx.network-import-run/0.1", result: isolated.result, isolation: isolated.isolation,
      acquisition: { apiOrigin: p.origin, requestCount, responseBytes: totalBytes, retrievedAt },
      binding: { ...p.binding, requestDigest: networkJsonDigest(p.request), inputDigest: packed.inputDigest,
        status: "host-pins-matched", authenticity: "not-verified", executionBinding: "not-verified" } };
  } catch (error) {
    if (codeOf(error) === "PLUGIN_ISOLATION_CLEANUP_FAILED") throw error;
    if (stopCode) throw networkImportError(stopCode);
    const code = codeOf(error);
    if (SAFE_CODES.has(code)) throw boundedError(error, "PLUGIN_FAILED");
    throw networkImportError(code === "PLUGIN_ISOLATION_TIMEOUT" ? "TIMEOUT" :
      code === "PLUGIN_ISOLATION_CANCELLED" ? "CANCELLED" :
      ["PLUGIN_ISOLATION_UNAVAILABLE", "PLUGIN_ISOLATION_IMAGE_UNAVAILABLE"].includes(code) ? "ISOLATION_UNAVAILABLE" : "PLUGIN_FAILED");
  } finally {
    clearTimeout(timer); p.signal?.removeEventListener("abort", abort); controller.abort(); responses.length = 0;
    // Credentials exist only in the trusted acquisition closure and are never staged or reported.
    delete p.acquisition.credential;
    await ownedTransport?.close();
  }
}
