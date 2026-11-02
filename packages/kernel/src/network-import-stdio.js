import { servePluginStdio } from "./plugin-stdio.js";
import { PLUGIN_EXECUTION_GRANT_ENV, PLUGIN_EXECUTION_GRANT_FORMAT } from "./plugin-communication.js";
import { canonicalJson } from "./canonical.js";
import { networkJson, networkRecord, requireNetworkImport as check, NETWORK_IMPORT_INPUT_PERMISSION } from "./network-import-input.js";
import { convertNetworkImportInput, validateNetworkImportRequest } from "./network-import-conversion.js";

// The container fixes cwd=/input. No credentials, network adapter, or Core path is accepted.
const result = await servePluginStdio({
  validateRequest: request => {
    validateNetworkImportRequest(request);
    const text = process.env[PLUGIN_EXECUTION_GRANT_ENV];
    check(typeof text === "string" && Buffer.byteLength(text) <= 65536, "GRANT_INVALID");
    const grant = networkJson(JSON.parse(text), 65536);
    check(networkRecord(grant, ["format", "runId", "plugin", "capability"]) &&
      grant.format === PLUGIN_EXECUTION_GRANT_FORMAT && grant.runId === request.runId &&
      canonicalJson(grant.plugin) === canonicalJson(request.plugin) &&
      networkRecord(grant.capability, ["id", "effect", "permissions", "resources"]) &&
      grant.capability.id === request.capability.id && grant.capability.effect === "read-only", "GRANT_INVALID");
    const permissions = grant.capability.permissions;
    check(networkRecord(permissions, ["graphRead", "fileRead", "network", "secrets", "devices"]) &&
      ["graphRead", "network", "secrets", "devices"].every(key => Array.isArray(permissions[key]) && permissions[key].length === 0) &&
      canonicalJson(permissions.fileRead) === canonicalJson([NETWORK_IMPORT_INPUT_PERMISSION]), "GRANT_INVALID");
  },
  handleRequest: request => convertNetworkImportInput(request, process.cwd()),
});
process.exitCode = result.exitCode;
