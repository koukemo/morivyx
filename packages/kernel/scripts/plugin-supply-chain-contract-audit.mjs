import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyPluginSupplyChain, PLUGIN_SUPPLY_CHAIN_LIMITS } from "../src/plugin-supply-chain.js";

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await json("../test/fixtures/plugin-manifest/repository-importer.json");
const fixed = await json("../test/fixtures/plugin-manifest/supply-chain.json");
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const clone = structuredClone;
function input() {
  const value = { manifest: clone(manifest), expectedPackageDigest: fixed.expectedPackageDigest,
    artifacts: { package: Buffer.from("abc") } };
  value.manifest.identity.packageDigest = value.expectedPackageDigest;
  return value;
}
function withSidecars() {
  const value = input();
  for (const name of ["signature", "sbom"]) {
    value.artifacts[name] = Buffer.from(name);
    value.manifest.supplyChain[`${name}Digest`] = sha(value.artifacts[name]);
  }
  return value;
}
function verify(value, status, code) {
  const report = verifyPluginSupplyChain(value);
  assert.equal(report.status, status);
  assert.equal(report.authenticity, "not-verified");
  if (code) assert.ok(report.issues.some((issue) => issue.code === `PLUGIN_SUPPLY_CHAIN_${code}`));
  return report;
}
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await check("fixed abc vector and contract", async () => {
  assert.deepEqual(verify(input(), "matched"), fixed);
  const schema = await json("../../../contracts/plugin-supply-chain@0.1.schema.json");
  assert.deepEqual(Object.keys(fixed), schema.required);
  assert.equal(fixed.format, schema.properties.format.const);
  assert.equal(fixed.authenticity, schema.properties.authenticity.const);
  assert.deepEqual(Object.keys(fixed.package), schema.$defs.Artifact.oneOf[1].required);
  assert.equal(PLUGIN_SUPPLY_CHAIN_LIMITS.maxArtifactBytes,
    schema.$defs.Artifact.oneOf[1].properties.byteLength.maximum);
});

await check("all declared sidecars match independently", () => {
  const report = verify(withSidecars(), "matched");
  for (const name of ["package", "signature", "sbom"]) assert.equal(report[name].status, "matched");
});

for (const name of ["package", "signature", "sbom"]) {
  await check(`${name} content mismatch`, () => {
    const value = withSidecars(); value.artifacts[name] = Buffer.from("different-content");
    const report = verify(value, "mismatch", "ARTIFACT_MISMATCH");
    assert.equal(report[name].status, "mismatch");
    assert.equal(report.issues[0].artifact, name);
  });
  await check(`${name} missing evidence`, () => {
    const value = withSidecars(); delete value.artifacts[name];
    const report = verify(value, "incomplete", "ARTIFACT_MISSING");
    assert.equal(report[name].actualDigest, null);
    assert.equal(report[name].byteLength, null);
  });
}

await check("mismatch dominates missing evidence in either order", () => {
  for (const [missing, mismatch] of [["package", "signature"], ["sbom", "package"]]) {
    const value = withSidecars(); delete value.artifacts[missing];
    value.artifacts[mismatch] = Buffer.from("modified");
    verify(value, "mismatch", "ARTIFACT_MISMATCH");
  }
});

await check("missing package is never matched", () => {
  const value = input(); value.artifacts = {};
  verify(value, "incomplete", "ARTIFACT_MISSING");
});

await check("an independent host pin is mandatory and mismatches stop before artifact access", () => {
  const value = input(); value.expectedPackageDigest = `sha256:${"0".repeat(64)}`;
  value.artifacts = new Proxy({}, { ownKeys() { throw new Error("must not inspect"); } });
  const report = verify(value, "mismatch", "PIN_MISMATCH");
  assert.equal(report.package, null);
  for (const pin of [null, undefined, "", "abc", `sha256:${"A".repeat(64)}`, []]) {
    const bad = input(); bad.expectedPackageDigest = pin;
    verify(bad, "invalid", "PIN_INVALID");
  }
});

await check("undeclared evidence and unknown artifact names are rejected", () => {
  for (const name of ["signature", "sbom"]) {
    const value = input(); value.artifacts[name] = Buffer.from("unbound-evidence");
    verify(value, "invalid", "ARTIFACT_UNDECLARED");
  }
  const value = input(); value.artifacts.extra = Buffer.alloc(0);
  verify(value, "invalid", "ARTIFACTS_INVALID");
});

await check("empty and binary contents are hashed as bytes", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 195, 40, 10])]) {
    const value = input(); value.artifacts.package = bytes;
    value.expectedPackageDigest = sha(bytes); value.manifest.identity.packageDigest = sha(bytes);
    const report = verify(value, "matched");
    assert.equal(report.package.byteLength, bytes.length);
  }
});

await check("only a Uint8Array view's selected region is hashed", () => {
  const value = input();
  const backing = new Uint8Array([255, 97, 98, 99, 255]);
  value.artifacts.package = backing.subarray(1, 4);
  assert.deepEqual(verify(value, "matched"), fixed);
});

await check("byte properties cannot substitute another buffer or execute getters", () => {
  const value = input(); let invoked = false;
  for (const key of ["buffer", "byteLength", "byteOffset", Symbol.iterator]) {
    Object.defineProperty(value.artifacts.package, key, { get() { invoked = true; throw new Error("private-value"); } });
  }
  assert.deepEqual(verify(value, "matched"), fixed);
  assert.equal(invoked, false);
});

await check("non-byte, shared and detached inputs are rejected", () => {
  const detached = new Uint8Array(3);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const bytes of [null, "abc", [97, 98, 99], new Uint16Array(3), new DataView(new ArrayBuffer(3)),
    new ArrayBuffer(3), new Uint8Array(new SharedArrayBuffer(3)), detached,
    new Proxy(new Uint8Array(3), {})]) {
    const value = input(); value.artifacts.package = bytes;
    verify(value, "invalid", "BYTES_INVALID");
  }
});

await check("per-artifact and aggregate limits are enforced before hashing", () => {
  const value = input(); value.artifacts.package = Buffer.alloc(PLUGIN_SUPPLY_CHAIN_LIMITS.maxArtifactBytes + 1);
  verify(value, "invalid", "LIMIT_EXCEEDED");
  const total = withSidecars();
  total.artifacts.package = Buffer.alloc(PLUGIN_SUPPLY_CHAIN_LIMITS.maxArtifactBytes);
  total.artifacts.signature = Buffer.alloc(PLUGIN_SUPPLY_CHAIN_LIMITS.maxArtifactBytes);
  total.artifacts.sbom = Buffer.alloc(1);
  verify(total, "invalid", "LIMIT_EXCEEDED");
  delete total.artifacts.sbom; delete total.manifest.supplyChain.sbomDigest;
  for (const name of ["package", "signature"]) {
    const digest = sha(total.artifacts[name]);
    if (name === "package") total.expectedPackageDigest = total.manifest.identity.packageDigest = digest;
    else total.manifest.supplyChain.signatureDigest = digest;
  }
  verify(total, "matched");
});

await check("root and artifact records reject accessors and unknown fields", () => {
  for (const locate of [v => [v, "manifest"], v => [v.artifacts, "package"]]) {
    const value = input(); const [object, key] = locate(value); let invoked = false;
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return "secret"; } });
    verify(value, "invalid"); assert.equal(invoked, false);
  }
  for (const value of [null, undefined, [], {}, new Date(), new Proxy(input(), {}),
    { ...input(), extra: true }, { ...input(), artifacts: [] }]) verify(value, "invalid");
  const symbol = input(); symbol[Symbol("unknown")] = true; verify(symbol, "invalid");
  const hidden = input(); Object.defineProperty(hidden, "hidden", { value: 1 }); verify(hidden, "invalid");
  const nullPrototype = Object.assign(Object.create(null), input()); verify(nullPrototype, "matched");
});

await check("invalid manifests and manifest accessors are rejected", () => {
  for (const bad of [null, {}, { ...manifest, identity: [] }]) {
    const value = input(); value.manifest = bad; verify(value, "invalid", "MANIFEST_INVALID");
  }
  const value = input(); let invoked = false;
  Object.defineProperty(value.manifest.identity, "packageDigest", {
    enumerable: true, get() { invoked = true; return fixed.expectedPackageDigest; },
  });
  verify(value, "invalid", "MANIFEST_INVALID"); assert.equal(invoked, false);
});

await check("immutable inputs and reports do not share mutable state or retain bytes", () => {
  const value = withSidecars(); const before = clone(value);
  function freeze(object) {
    if (object && typeof object === "object" && !ArrayBuffer.isView(object)) {
      Object.values(object).forEach(freeze); Object.freeze(object);
    }
  }
  freeze(value);
  const report = verify(value, "matched");
  report.plugin.id = "changed"; report.package.expectedDigest = "changed";
  assert.deepEqual(clone(value), before);
  assert.equal(JSON.stringify(report).includes('"data"'), false);
  assert.equal(Object.hasOwn(report, "artifacts"), false);
  const stable = verify(value, "matched");
  value.artifacts.package.fill(0);
  assert.equal(stable.package.actualDigest, fixed.package.actualDigest);
});

await check("real source bytes match without execution, network or writes", async () => {
  const bytes = await readFile(new URL("../src/repository-importer-stdio.js", import.meta.url));
  const value = input(); value.artifacts.package = bytes;
  value.expectedPackageDigest = value.manifest.identity.packageDigest = sha(bytes);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network prohibited"); };
  try { verify(value, "matched"); } finally { globalThis.fetch = original; }
});

console.log(`Plugin supply chain contract audit passed: ${checks} checks.`);
