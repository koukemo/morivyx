import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";

// Internal framing for the ADR-0017 path adopted under ADR-0019. No network or credentials.
export const NETWORK_IMPORT_INPUT_FORMAT = "morivyx.network-import-input/0.1";
export const NETWORK_IMPORT_INPUT_PERMISSION = "network-import-input";
export const NETWORK_IMPORT_INDEX_FILE = "network-input.json";
export const NETWORK_IMPORT_LIMITS = Object.freeze({
  maxResponseBytes: 2097152, maxTotalBytes: 8388608, maxFileBytes: 1048576,
  maxIndexBytes: 65536, maxFiles: 256, maxRequests: 19, timeoutMs: 30000,
});
const prototype = Object.getPrototypeOf(Uint8Array.prototype);
const getters = Object.fromEntries(["buffer", "byteOffset", "byteLength"].map(key =>
  [key, Object.getOwnPropertyDescriptor(prototype, key).get]));

export function networkImportError(code) {
  return new PackageError(`NETWORK_IMPORT_${code}`, "/network-import", "外部取得と隔離変換を完了できません。");
}
export function requireNetworkImport(value, code = "INPUT_INVALID") {
  if (!value) throw networkImportError(code);
}
export function networkRecord(value, keys, required = keys) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const p = Object.getPrototypeOf(value);
  return (p === Object.prototype || p === null) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return keys.includes(key) && d.enumerable && Object.hasOwn(d, "value");
  }) && required.every(key => Object.hasOwn(value, key));
}
export function networkJson(value, maxBytes = 1048576) {
  let text;
  try { text = canonicalJson(value); } catch { throw networkImportError("INPUT_INVALID"); }
  requireNetworkImport(Buffer.byteLength(text) <= maxBytes, "INPUT_LIMIT");
  // canonicalJson validates logical data but normalizes date-like strings. Keep source identifiers unchanged.
  const encoded = JSON.stringify(value);
  requireNetworkImport(Buffer.byteLength(encoded) <= maxBytes, "INPUT_LIMIT");
  return JSON.parse(encoded);
}
export function networkBytes(value, maxBytes = NETWORK_IMPORT_LIMITS.maxResponseBytes) {
  requireNetworkImport(types.isUint8Array(value));
  try {
    const buffer = Reflect.apply(getters.buffer, value, []);
    requireNetworkImport(!types.isSharedArrayBuffer(buffer));
    const offset = Reflect.apply(getters.byteOffset, value, []);
    const length = Reflect.apply(getters.byteLength, value, []);
    requireNetworkImport(length <= maxBytes, "INPUT_LIMIT");
    return Buffer.from(new Uint8Array(buffer, offset, length));
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw networkImportError("INPUT_INVALID");
  }
}
export const networkDigest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const networkJsonDigest = value => networkDigest(canonicalJson(value));

export function networkResponseList(value) {
  requireNetworkImport(Array.isArray(value) && !types.isProxy(value) && value.length > 0 &&
    value.length <= NETWORK_IMPORT_LIMITS.maxRequests && Reflect.ownKeys(value).length === value.length + 1);
  const result = []; let total = 0;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireNetworkImport(descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
    const item = descriptor.value;
    requireNetworkImport(networkRecord(item, ["path", "bytes"]) && typeof item.path === "string" &&
      item.path.startsWith("/") && !item.path.startsWith("//") && !/[\\\u0000-\u0020\u007f]/u.test(item.path));
    const path = networkJson(item.path, 4096), bytes = networkBytes(item.bytes);
    total += bytes.length;
    requireNetworkImport(total <= NETWORK_IMPORT_LIMITS.maxTotalBytes, "INPUT_LIMIT");
    result.push({ path, bytes });
  }
  return result;
}
