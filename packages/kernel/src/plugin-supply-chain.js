import { createHash } from "node:crypto";
import { types } from "node:util";
import { validatePluginManifest } from "./plugin-manifest.js";

export const PLUGIN_SUPPLY_CHAIN_FORMAT = "morivyx.plugin-supply-chain/0.1";
export const PLUGIN_SUPPLY_CHAIN_LIMITS = Object.freeze({
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ARTIFACTS = ["package", "signature", "sbom"];
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getters = Object.fromEntries(["buffer", "byteOffset", "byteLength"].map((key) =>
  [key, Object.getOwnPropertyDescriptor(typedArrayPrototype, key).get]));

function record(value, allowed, required = allowed) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return allowed.includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, "value");
  }) && required.every((key) => Object.hasOwn(value, key));
}

function report(status, issues, manifest = null, expectedPackageDigest = null) {
  return {
    format: PLUGIN_SUPPLY_CHAIN_FORMAT,
    plugin: manifest === null ? null : {
      id: manifest.identity.id, version: manifest.identity.version, distributor: manifest.identity.distributor,
    },
    source: manifest?.supplyChain.source ?? null,
    expectedPackageDigest,
    package: null,
    signature: null,
    sbom: null,
    status,
    authenticity: "not-verified",
    issues,
  };
}

function invalid(code) {
  return report("invalid", [{ code: `PLUGIN_SUPPLY_CHAIN_${code}` }]);
}

function byteView(value) {
  if (!types.isUint8Array(value)) throw new TypeError("bytes required");
  // Intrinsic getters ignore user-defined byteLength/buffer/iterator properties.
  const buffer = Reflect.apply(getters.buffer, value, []);
  if (types.isSharedArrayBuffer(buffer)) throw new TypeError("shared bytes rejected");
  const offset = Reflect.apply(getters.byteOffset, value, []);
  const length = Reflect.apply(getters.byteLength, value, []);
  return new Uint8Array(buffer, offset, length); // Also rejects detached buffers.
}

export function verifyPluginSupplyChain(input) {
  if (!record(input, ["manifest", "expectedPackageDigest", "artifacts"])) return invalid("INPUT_INVALID");
  const { manifest, expectedPackageDigest, artifacts } = input;
  try { validatePluginManifest(manifest); } catch { return invalid("MANIFEST_INVALID"); }
  if (typeof expectedPackageDigest !== "string" || !DIGEST.test(expectedPackageDigest)) {
    return invalid("PIN_INVALID");
  }
  if (manifest.identity.packageDigest !== expectedPackageDigest) {
    return report("mismatch", [{ code: "PLUGIN_SUPPLY_CHAIN_PIN_MISMATCH" }], manifest, expectedPackageDigest);
  }
  if (!record(artifacts, ARTIFACTS, [])) return invalid("ARTIFACTS_INVALID");
  const expected = {
    package: expectedPackageDigest,
    signature: manifest.supplyChain.signatureDigest ?? null,
    sbom: manifest.supplyChain.sbomDigest ?? null,
  };
  const views = {};
  let total = 0;
  for (const name of ARTIFACTS) {
    if (!Object.hasOwn(artifacts, name)) continue;
    if (expected[name] === null) return invalid("ARTIFACT_UNDECLARED");
    try { views[name] = byteView(artifacts[name]); } catch { return invalid("BYTES_INVALID"); }
    total += views[name].byteLength;
    if (views[name].byteLength > PLUGIN_SUPPLY_CHAIN_LIMITS.maxArtifactBytes ||
        total > PLUGIN_SUPPLY_CHAIN_LIMITS.maxTotalBytes) return invalid("LIMIT_EXCEEDED");
  }
  const result = report("matched", [], manifest, expectedPackageDigest);
  for (const name of ARTIFACTS) {
    if (expected[name] === null) continue;
    const bytes = views[name];
    const digest = bytes === undefined ? null : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const status = digest === null ? "missing" : digest === expected[name] ? "matched" : "mismatch";
    result[name] = { expectedDigest: expected[name], actualDigest: digest,
      byteLength: bytes?.byteLength ?? null, status };
    if (status !== "matched") {
      result.issues.push({ code: `PLUGIN_SUPPLY_CHAIN_ARTIFACT_${status === "missing" ? "MISSING" : "MISMATCH"}`,
        artifact: name });
      // A detected mismatch dominates incomplete evidence, regardless of artifact order.
      if (status === "mismatch") result.status = "mismatch";
      else if (result.status === "matched") result.status = "incomplete";
    }
  }
  return result;
}
