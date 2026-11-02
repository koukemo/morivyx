import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_MANIFEST_FORMAT,
  getDeclaredPluginCapability,
  validatePluginManifest,
} from "../src/plugin-manifest.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const kernelDirectory = join(scriptDirectory, "..");
const fixturePath = join(
  kernelDirectory,
  "test",
  "fixtures",
  "plugin-manifest",
  "repository-importer.json",
);
const contractPath = join(
  kernelDirectory,
  "..",
  "..",
  "contracts",
  "plugin-manifest@0.1.schema.json",
);

async function fixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

let checks = 0;
async function check(name, operation) {
  try {
    await operation();
    checks += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

await check("fixed fixture", async () => {
  const manifest = await fixture();
  assert.equal(validatePluginManifest(manifest), manifest);
});

await check("language-independent contract", async () => {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(contract.properties.format.const, PLUGIN_MANIFEST_FORMAT);
  assert.deepEqual(contract.required, [
    "format",
    "identity",
    "compatibility",
    "capabilities",
    "supplyChain",
    "migrations",
  ]);
  assert.deepEqual(contract.$defs.Capability.required, [
    "id",
    "effect",
    "inputFormat",
    "outputFormat",
    "permissions",
    "retry",
    "resources",
  ]);
});

await check("repository importer declaration", async () => {
  const manifest = await fixture();
  const capability = getDeclaredPluginCapability(manifest, "repository.read-file");
  assert.equal(capability.effect, "read-only");
  assert.deepEqual(capability.permissions.fileRead, ["repository-root"]);
  assert.deepEqual(capability.permissions.network, []);
  assert.deepEqual(capability.permissions.secrets, []);
  assert.deepEqual(capability.permissions.devices, []);
});

await check("invalid package digest", async () => {
  const manifest = await fixture();
  manifest.identity.packageDigest = "sha256:not-a-digest";
  assert.throws(
    () => validatePluginManifest(manifest),
    (error) => error.code === "PLUGIN_MANIFEST_INVALID",
  );
});

await check("duplicate capability", async () => {
  const manifest = await fixture();
  manifest.capabilities.push(structuredClone(manifest.capabilities[0]));
  assert.throws(
    () => validatePluginManifest(manifest),
    (error) => error.code === "PLUGIN_MANIFEST_CAPABILITY_DUPLICATE",
  );
});

await check("unsupported communication contract", async () => {
  const manifest = await fixture();
  manifest.compatibility.communicationContracts = ["morivyx.plugin-run-request/9.9"];
  assert.throws(
    () => validatePluginManifest(manifest),
    (error) => error.code === "PLUGIN_MANIFEST_COMPATIBILITY_UNSUPPORTED",
  );
});

await check("unknown effect", async () => {
  const manifest = await fixture();
  manifest.capabilities[0].effect = "unknown-effect";
  assert.throws(
    () => validatePluginManifest(manifest),
    (error) => error.code === "PLUGIN_MANIFEST_INVALID",
  );
});

await check("undeclared capability", async () => {
  const manifest = await fixture();
  assert.throws(
    () => getDeclaredPluginCapability(manifest, "repository.read-tree"),
    (error) => error.code === "PLUGIN_CAPABILITY_UNDECLARED",
  );
});

assert.equal(checks, 8);
console.log(`Plugin manifest contract audit passed: ${checks} checks.`);
