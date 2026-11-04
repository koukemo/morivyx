import { spawnSync } from "node:child_process";
import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";
import { authorizePluginHostPolicy } from "./plugin-host-policy.js";
import {
  getDeclaredPluginCapability,
  validatePluginManifest,
} from "./plugin-manifest.js";

export const PLUGIN_RUN_REQUEST_FORMAT = "morivyx.plugin-run-request/0.1";
export const PLUGIN_RUN_RESULT_FORMAT = "morivyx.plugin-run-result/0.1";
export const PLUGIN_EXECUTION_GRANT_FORMAT = "morivyx.plugin-execution-grant/0.1";
export const PLUGIN_EXECUTION_GRANT_ENV = "MORIVYX_PLUGIN_EXECUTION_GRANT";

const EFFECTS = new Set([
  "pure",
  "read-only",
  "artifact-write",
  "external-effect",
  "physical-effect",
]);
const RESULT_STATUSES = new Set(["success", "failure"]);

function isLogicalRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function isText(value) {
  return typeof value === "string" && value.length > 0;
}

function assertKeys(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PackageError(
        "PLUGIN_MESSAGE_FIELD_UNKNOWN",
        `${path}/${key}`,
        `未定義のPlugin通信項目です: ${key}`,
      );
    }
  }
}

function assertPlugin(plugin, path) {
  if (!isLogicalRecord(plugin)) {
    throw new PackageError(
      "PLUGIN_MESSAGE_INVALID",
      path,
      "Plugin識別情報は対応表でなければなりません。",
    );
  }
  assertKeys(plugin, new Set(["id", "version"]), path);
  if (!isText(plugin.id) || !isText(plugin.version)) {
    throw new PackageError(
      "PLUGIN_MESSAGE_INVALID",
      path,
      "Plugin IDとversionは空でない文字列でなければなりません。",
    );
  }
}

function assertCapability(capability, path) {
  if (!isLogicalRecord(capability)) {
    throw new PackageError(
      "PLUGIN_MESSAGE_INVALID",
      path,
      "Capabilityは対応表でなければなりません。",
    );
  }
  assertKeys(capability, new Set(["id", "effect"]), path);
  if (!isText(capability.id) || !EFFECTS.has(capability.effect)) {
    throw new PackageError(
      "PLUGIN_MESSAGE_INVALID",
      path,
      "Capability IDとeffectが不正です。",
    );
  }
}

function assertFailure(failure, path) {
  if (!isLogicalRecord(failure)) {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      path,
      "Plugin失敗情報は対応表でなければなりません。",
    );
  }
  assertKeys(failure, new Set(["code", "message"]), path);
  if (!isText(failure.code) || !isText(failure.message)) {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      path,
      "Plugin失敗情報のcodeとmessageは空でない文字列でなければなりません。",
    );
  }
}

function frozenStringSet(values) {
  return Object.freeze([...values]);
}

function frozenPermissions(permissions) {
  return Object.freeze({
    graphRead: frozenStringSet(permissions.graphRead),
    fileRead: frozenStringSet(permissions.fileRead),
    network: frozenStringSet(permissions.network),
    secrets: frozenStringSet(permissions.secrets),
    devices: frozenStringSet(permissions.devices),
  });
}

function frozenResources(resources) {
  const result = {
    timeoutMs: resources.timeoutMs,
    maxOutputBytes: resources.maxOutputBytes,
  };
  for (const optional of ["maxMemoryBytes", "maxCostUnits"]) {
    if (Object.hasOwn(resources, optional)) {
      result[optional] = resources[optional];
    }
  }
  return Object.freeze(result);
}

export function validatePluginRunRequest(request) {
  if (!isLogicalRecord(request)) {
    throw new PackageError(
      "PLUGIN_REQUEST_INVALID",
      "/",
      "Plugin RunRequestは論理的な対応表でなければなりません。",
    );
  }
  assertKeys(
    request,
    new Set(["format", "runId", "plugin", "capability", "input"]),
    "",
  );
  if (request.format !== PLUGIN_RUN_REQUEST_FORMAT || !isText(request.runId)) {
    throw new PackageError(
      "PLUGIN_REQUEST_INVALID",
      "/",
      "Plugin RunRequestのformatまたはrunIdが不正です。",
    );
  }
  assertPlugin(request.plugin, "/plugin");
  assertCapability(request.capability, "/capability");
  if (!isLogicalRecord(request.input)) {
    throw new PackageError(
      "PLUGIN_REQUEST_INVALID",
      "/input",
      "Plugin入力は対応表でなければなりません。",
    );
  }
  return request;
}

export function authorizePluginRunRequest(manifest, request) {
  validatePluginManifest(manifest);
  validatePluginRunRequest(request);
  if (
    request.plugin.id !== manifest.identity.id ||
    request.plugin.version !== manifest.identity.version
  ) {
    throw new PackageError(
      "PLUGIN_MANIFEST_IDENTITY_MISMATCH",
      "/plugin",
      "Plugin RunRequestのIdentityがmanifest宣言と一致しません。",
    );
  }
  if (!manifest.compatibility.communicationContracts.includes(request.format)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_COMPATIBILITY_UNSUPPORTED",
      "/format",
      "Plugin RunRequestの通信契約がmanifest宣言と一致しません。",
    );
  }
  const capability = getDeclaredPluginCapability(manifest, request.capability.id);
  if (request.capability.effect !== capability.effect) {
    throw new PackageError(
      "PLUGIN_CAPABILITY_EFFECT_MISMATCH",
      "/capability/effect",
      "Plugin RunRequestのEffectがmanifest宣言と一致しません。",
    );
  }
  return capability;
}

export function createPluginExecutionGrant(manifest, request, policy) {
  authorizePluginRunRequest(manifest, request);
  const capability = authorizePluginHostPolicy(manifest, request.capability.id, policy);
  return Object.freeze({
    format: PLUGIN_EXECUTION_GRANT_FORMAT,
    runId: request.runId,
    plugin: Object.freeze({
      id: manifest.identity.id,
      version: manifest.identity.version,
    }),
    capability: Object.freeze({
      id: capability.id,
      effect: capability.effect,
      permissions: frozenPermissions(capability.permissions),
      resources: frozenResources(capability.resources),
    }),
  });
}

export function validatePluginRunResult(result, request = null) {
  if (!isLogicalRecord(result)) {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      "/",
      "Plugin RunResultは論理的な対応表でなければなりません。",
    );
  }
  assertKeys(
    result,
    new Set([
      "format",
      "runId",
      "plugin",
      "capabilityId",
      "status",
      "output",
      "failure",
    ]),
    "",
  );
  if (
    result.format !== PLUGIN_RUN_RESULT_FORMAT ||
    !isText(result.runId) ||
    !isText(result.capabilityId) ||
    !RESULT_STATUSES.has(result.status)
  ) {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      "/",
      "Plugin RunResultの基本項目が不正です。",
    );
  }
  assertPlugin(result.plugin, "/plugin");
  if (request !== null) {
    validatePluginRunRequest(request);
    if (
      result.runId !== request.runId ||
      result.plugin.id !== request.plugin.id ||
      result.plugin.version !== request.plugin.version ||
      result.capabilityId !== request.capability.id
    ) {
      throw new PackageError(
        "PLUGIN_RESULT_MISMATCH",
        "/",
        "Plugin RunResultがRunRequestの識別情報と一致しません。",
      );
    }
  }
  if (result.status === "success") {
    if (
      !Object.hasOwn(result, "output") ||
      Object.hasOwn(result, "failure") ||
      !isLogicalRecord(result.output)
    ) {
      throw new PackageError(
        "PLUGIN_RESULT_INVALID",
        "/output",
        "成功したPlugin RunResultには対応表のoutputだけが必要です。",
      );
    }
  } else {
    if (!Object.hasOwn(result, "failure") || Object.hasOwn(result, "output")) {
      throw new PackageError(
        "PLUGIN_RESULT_INVALID",
        "/",
        "失敗したPlugin RunResultにはfailureだけが必要です。",
      );
    }
    assertFailure(result.failure, "/failure");
  }
  return result;
}

export function runPluginProcess({
  command,
  args = [],
  manifest,
  request,
  policy,
  cwd,
}) {
  const grant = createPluginExecutionGrant(manifest, request, policy);
  if (["maxMemoryBytes", "maxCostUnits"].some((key) => Object.hasOwn(grant.capability.resources, key))) {
    throw new PackageError("PLUGIN_RUN_RESOURCE_UNSUPPORTED", "/policy/capability/resources",
      "この実行方式では指定された資源上限を強制できません。");
  }
  if (
    !isText(command) || command.includes("\0") ||
    !Array.isArray(args) ||
    args.findIndex((argument) => typeof argument !== "string" || argument.includes("\0")) !== -1 ||
    (cwd !== undefined && (typeof cwd !== "string" || cwd.includes("\0")))
  ) {
    throw new PackageError(
      "PLUGIN_RUN_INVALID",
      "/command",
      "Plugin実行command、args、cwdのいずれかが不正です。",
    );
  }
  const runFailed = () => new PackageError("PLUGIN_RUN_FAILED", "/",
    "Pluginプロセスの起動又は実行に失敗しました。");
  let execution;
  try {
    execution = spawnSync(command, args, {
      cwd,
      env: {
        [PLUGIN_EXECUTION_GRANT_ENV]: canonicalJson(grant),
      },
      input: `${JSON.stringify(request)}\n`,
      maxBuffer: grant.capability.resources.maxOutputBytes,
      shell: false,
      timeout: grant.capability.resources.timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch {
    throw runFailed();
  }
  if (execution.error) {
    throw runFailed();
  }
  if (execution.status !== 0) {
    throw new PackageError(
      "PLUGIN_RUN_FAILED",
      "/",
      `Plugin process exited with status ${execution.status}.`,
    );
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(execution.stdout).trim();
  } catch {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      "/",
      "Pluginの標準出力は正しいUTF-8でなければなりません。",
    );
  }
  if (text.length === 0 || text.includes("\n")) {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      "/",
      "Pluginは標準出力へJSONを1件だけ返さなければなりません。",
    );
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new PackageError(
      "PLUGIN_RESULT_INVALID",
      "/",
      "Pluginの標準出力はJSONでなければなりません。",
    );
  }
  return validatePluginRunResult(result, request);
}
