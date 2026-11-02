import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";

export const PLUGIN_MANIFEST_FORMAT = "morivyx.plugin-manifest/0.1";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EFFECTS = new Set([
  "pure",
  "read-only",
  "artifact-write",
  "external-effect",
  "physical-effect",
]);
const RETRY_MODES = new Set([
  "idempotent",
  "safe-to-retry",
  "reconcile-required",
  "manual-recovery",
]);
const PLUGIN_RUN_REQUEST_FORMAT = "morivyx.plugin-run-request/0.1";
const PLUGIN_RUN_RESULT_FORMAT = "morivyx.plugin-run-result/0.1";
const SUPPORTED_COMMUNICATION_CONTRACTS = new Set([
  PLUGIN_RUN_REQUEST_FORMAT,
  PLUGIN_RUN_RESULT_FORMAT,
]);

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
        "PLUGIN_MANIFEST_FIELD_UNKNOWN",
        `${path}/${key}`,
        `未定義のPlugin manifest項目です: ${key}`,
      );
    }
  }
}

function assertDigest(value, path) {
  if (!isText(value) || !DIGEST_PATTERN.test(value)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Plugin manifestのdigestはsha256形式でなければなりません。",
    );
  }
}

function assertStringSet(value, path, { nonEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    value.some((entry) => !isText(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Plugin manifestの文字列集合が不正です。",
    );
  }
}

function assertIdentity(identity) {
  if (!isLogicalRecord(identity)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/identity",
      "Plugin identityは対応表でなければなりません。",
    );
  }
  assertKeys(
    identity,
    new Set(["id", "version", "packageDigest", "distributor"]),
    "/identity",
  );
  if (!isText(identity.id) || !isText(identity.version) || !isText(identity.distributor)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/identity",
      "Plugin ID、version、distributorは空でない文字列でなければなりません。",
    );
  }
  assertDigest(identity.packageDigest, "/identity/packageDigest");
}

function assertCompatibility(compatibility) {
  if (!isLogicalRecord(compatibility)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/compatibility",
      "Plugin compatibilityは対応表でなければなりません。",
    );
  }
  assertKeys(
    compatibility,
    new Set(["communicationContracts", "coreSchemas", "profileSchemas"]),
    "/compatibility",
  );
  assertStringSet(
    compatibility.communicationContracts,
    "/compatibility/communicationContracts",
    { nonEmpty: true },
  );
  assertStringSet(compatibility.coreSchemas, "/compatibility/coreSchemas");
  assertStringSet(compatibility.profileSchemas, "/compatibility/profileSchemas");
  if (
    compatibility.communicationContracts.some(
      (contract) => !SUPPORTED_COMMUNICATION_CONTRACTS.has(contract),
    ) ||
    !compatibility.communicationContracts.includes(PLUGIN_RUN_REQUEST_FORMAT) ||
    !compatibility.communicationContracts.includes(PLUGIN_RUN_RESULT_FORMAT)
  ) {
    throw new PackageError(
      "PLUGIN_MANIFEST_COMPATIBILITY_UNSUPPORTED",
      "/compatibility/communicationContracts",
      "Plugin manifestが現在のPlugin通信契約と互換ではありません。",
    );
  }
}

function assertPermissions(permissions, path) {
  if (!isLogicalRecord(permissions)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Capability permissionsは対応表でなければなりません。",
    );
  }
  const names = ["graphRead", "fileRead", "network", "secrets", "devices"];
  assertKeys(permissions, new Set(names), path);
  for (const name of names) {
    assertStringSet(permissions[name], `${path}/${name}`);
  }
}

function assertResources(resources, path) {
  if (!isLogicalRecord(resources)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Capability resourcesは対応表でなければなりません。",
    );
  }
  assertKeys(
    resources,
    new Set(["timeoutMs", "maxOutputBytes", "maxMemoryBytes", "maxCostUnits"]),
    path,
  );
  for (const required of ["timeoutMs", "maxOutputBytes"]) {
    if (!Number.isSafeInteger(resources[required]) || resources[required] <= 0) {
      throw new PackageError(
        "PLUGIN_MANIFEST_INVALID",
        `${path}/${required}`,
        "Capability resource上限は正の安全な整数でなければなりません。",
      );
    }
  }
  for (const optional of ["maxMemoryBytes", "maxCostUnits"]) {
    if (
      Object.hasOwn(resources, optional) &&
      (!Number.isSafeInteger(resources[optional]) || resources[optional] <= 0)
    ) {
      throw new PackageError(
        "PLUGIN_MANIFEST_INVALID",
        `${path}/${optional}`,
        "Capability resource上限は正の安全な整数でなければなりません。",
      );
    }
  }
}

function assertCapability(capability, path) {
  if (!isLogicalRecord(capability)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Capability宣言は対応表でなければなりません。",
    );
  }
  assertKeys(
    capability,
    new Set([
      "id",
      "effect",
      "inputFormat",
      "outputFormat",
      "permissions",
      "retry",
      "resources",
    ]),
    path,
  );
  if (
    !isText(capability.id) ||
    !EFFECTS.has(capability.effect) ||
    !isText(capability.inputFormat) ||
    !isText(capability.outputFormat) ||
    !RETRY_MODES.has(capability.retry)
  ) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      path,
      "Capability ID、effect、入出力形式、retryのいずれかが不正です。",
    );
  }
  assertPermissions(capability.permissions, `${path}/permissions`);
  assertResources(capability.resources, `${path}/resources`);
}

function assertSupplyChain(supplyChain) {
  if (!isLogicalRecord(supplyChain)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/supplyChain",
      "Supply chain情報は対応表でなければなりません。",
    );
  }
  assertKeys(
    supplyChain,
    new Set(["source", "signatureDigest", "sbomDigest"]),
    "/supplyChain",
  );
  if (!isText(supplyChain.source)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/supplyChain/source",
      "Supply chainのsourceは空でない文字列でなければなりません。",
    );
  }
  for (const digest of ["signatureDigest", "sbomDigest"]) {
    if (Object.hasOwn(supplyChain, digest)) {
      assertDigest(supplyChain[digest], `/supplyChain/${digest}`);
    }
  }
}

export function validatePluginManifest(manifest) {
  if (!isLogicalRecord(manifest)) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/",
      "Plugin manifestは論理的な対応表でなければなりません。",
    );
  }
  assertKeys(
    manifest,
    new Set([
      "format",
      "identity",
      "compatibility",
      "capabilities",
      "supplyChain",
      "migrations",
    ]),
    "",
  );
  if (manifest.format !== PLUGIN_MANIFEST_FORMAT) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/format",
      "Plugin manifestのformatが不正です。",
    );
  }
  assertIdentity(manifest.identity);
  assertCompatibility(manifest.compatibility);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new PackageError(
      "PLUGIN_MANIFEST_INVALID",
      "/capabilities",
      "Plugin manifestには1件以上のCapability宣言が必要です。",
    );
  }
  const capabilityIds = new Set();
  for (let index = 0; index < manifest.capabilities.length; index += 1) {
    const capability = manifest.capabilities[index];
    assertCapability(capability, `/capabilities/${index}`);
    if (capabilityIds.has(capability.id)) {
      throw new PackageError(
        "PLUGIN_MANIFEST_CAPABILITY_DUPLICATE",
        `/capabilities/${index}/id`,
        `Capability IDが重複しています: ${capability.id}`,
      );
    }
    capabilityIds.add(capability.id);
  }
  assertSupplyChain(manifest.supplyChain);
  assertStringSet(manifest.migrations, "/migrations");
  return manifest;
}

export function getDeclaredPluginCapability(manifest, capabilityId) {
  validatePluginManifest(manifest);
  if (!isText(capabilityId)) {
    throw new PackageError(
      "PLUGIN_CAPABILITY_UNDECLARED",
      "/capabilityId",
      "Capability IDは空でない文字列でなければなりません。",
    );
  }
  const capability = manifest.capabilities.find((entry) => entry.id === capabilityId);
  if (!capability) {
    throw new PackageError(
      "PLUGIN_CAPABILITY_UNDECLARED",
      "/capabilityId",
      `Plugin manifestに宣言されていないCapabilityです: ${capabilityId}`,
    );
  }
  return capability;
}
