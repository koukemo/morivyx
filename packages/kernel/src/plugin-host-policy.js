import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";
import { getDeclaredPluginCapability } from "./plugin-manifest.js";

export const PLUGIN_HOST_POLICY_FORMAT = "morivyx.plugin-host-policy/0.1";
const PERMISSIONS = ["graphRead", "fileRead", "network", "secrets", "devices"];
const REQUIRED_LIMITS = ["timeoutMs", "maxOutputBytes"];
const OPTIONAL_LIMITS = ["maxMemoryBytes", "maxCostUnits"];
const text = (value) => typeof value === "string" && value.length > 0;
function deny(code) {
  throw new PackageError(`PLUGIN_HOST_POLICY_${code}`, "/policy", "実行側の許可情報とPluginの要求を照合できません。");
}
function record(value, keys, required = keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

export function validatePluginHostPolicy(policy) {
  try { canonicalJson(policy); } catch { deny("INVALID"); }
  if (!record(policy, ["format", "plugin", "capability"]) || policy.format !== PLUGIN_HOST_POLICY_FORMAT ||
      !record(policy.plugin, ["id", "version", "packageDigest"]) || !text(policy.plugin.id) ||
      !text(policy.plugin.version) || typeof policy.plugin.packageDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(policy.plugin.packageDigest) ||
      !record(policy.capability, ["id", "effect", "permissions", "resources"]) ||
      !text(policy.capability.id) || !["pure", "read-only"].includes(policy.capability.effect)) deny("INVALID");
  const { permissions, resources } = policy.capability;
  if (!record(permissions, PERMISSIONS) || PERMISSIONS.some((key) =>
    !Array.isArray(permissions[key]) || permissions[key].some((name) => !text(name)) ||
    new Set(permissions[key]).size !== permissions[key].length)) deny("INVALID");
  if (!record(resources, [...REQUIRED_LIMITS, ...OPTIONAL_LIMITS], REQUIRED_LIMITS) ||
      Object.values(resources).some((value) => !Number.isSafeInteger(value) || value <= 0)) deny("INVALID");
  return policy;
}

export function authorizePluginHostPolicy(manifest, capabilityId, policy) {
  const capability = getDeclaredPluginCapability(manifest, capabilityId);
  validatePluginHostPolicy(policy);
  if (["id", "version", "packageDigest"].some((key) => manifest.identity[key] !== policy.plugin[key])) {
    deny("IDENTITY_MISMATCH");
  }
  if (capability.id !== policy.capability.id || capability.effect !== policy.capability.effect) deny("CAPABILITY_DENIED");
  if (PERMISSIONS.some((key) => capability.permissions[key].some((name) =>
    !policy.capability.permissions[key].includes(name)))) deny("PERMISSION_DENIED");
  const resources = {};
  for (const key of [...REQUIRED_LIMITS, ...OPTIONAL_LIMITS]) {
    const declared = capability.resources[key];
    const allowed = policy.capability.resources[key];
    if (declared !== undefined || allowed !== undefined) resources[key] = Math.min(declared ?? Infinity, allowed ?? Infinity);
  }
  return { ...structuredClone(capability), resources };
}
