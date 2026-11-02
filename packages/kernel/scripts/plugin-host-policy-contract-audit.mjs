import assert from "node:assert/strict";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePluginHostPolicy, authorizePluginHostPolicy } from "../src/plugin-host-policy.js";
import { createPluginExecutionGrant, runPluginProcess, PLUGIN_EXECUTION_GRANT_ENV } from "../src/plugin-communication.js";

const fixture = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await fixture("../test/fixtures/plugin-manifest/repository-importer.json");
const policy = await fixture("../test/fixtures/plugin-manifest/host-policy.json");
const request = await fixture("../test/fixtures/plugin-communication/request.json");
const clone = structuredClone;
const grant = (m = manifest, p = policy, r = request) => createPluginExecutionGrant(m, r, p);
const rejects = (operation, code) => assert.throws(operation, error => error.code === code);
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await check("fixed host policy contract", async () => {
  const schema = await fixture("../../../contracts/plugin-host-policy@0.1.schema.json");
  assert.equal(validatePluginHostPolicy(policy), policy);
  assert.deepEqual(Object.keys(policy), schema.required);
  assert.deepEqual(Object.keys(policy.plugin), schema.properties.plugin.required);
  assert.deepEqual(Object.keys(policy.capability), schema.properties.capability.required);
  assert.deepEqual(Object.keys(policy.capability.permissions), schema.properties.capability.properties.permissions.required);
  assert.deepEqual(grant().capability.permissions, policy.capability.permissions);
  assert.deepEqual(grant().capability.resources, policy.capability.resources);
});

await check("missing and malformed host policies are denied", () => {
  for (const value of [undefined, null, {}, [], new Date(), { ...policy, extra: true },
    { ...policy, format: "future" }, { ...policy, plugin: {} }, { ...policy, capability: {} }]) {
    rejects(() => createPluginExecutionGrant(manifest, request, value), "PLUGIN_HOST_POLICY_INVALID");
  }
  rejects(() => createPluginExecutionGrant(manifest, request), "PLUGIN_HOST_POLICY_INVALID");
});

await check("plugin identity version and digest must match the host pin", () => {
  for (const field of ["id", "version", "packageDigest"]) {
    const p = clone(policy); p.plugin[field] = field === "packageDigest" ? `sha256:${"2".repeat(64)}` : "other";
    rejects(() => grant(manifest, p), "PLUGIN_HOST_POLICY_IDENTITY_MISMATCH");
  }
});

await check("capability identity and effect must match", () => {
  for (const [key, value] of [["id", "another-capability"], ["effect", "pure"]]) {
    const p = clone(policy); p.capability[key] = value;
    rejects(() => grant(manifest, p), "PLUGIN_HOST_POLICY_CAPABILITY_DENIED");
  }
  for (const effect of ["artifact-write", "external-effect", "physical-effect"]) {
    const m = clone(manifest); m.capabilities[0].effect = effect;
    const r = clone(request); r.capability.effect = effect;
    rejects(() => grant(m, policy, r), "PLUGIN_HOST_POLICY_CAPABILITY_DENIED");
    const p = clone(policy); p.capability.effect = effect;
    rejects(() => validatePluginHostPolicy(p), "PLUGIN_HOST_POLICY_INVALID");
  }
  const m = clone(manifest); m.capabilities[0].effect = "pure";
  const p = clone(policy); p.capability.effect = "pure";
  const r = clone(request); r.capability.effect = "pure";
  assert.equal(grant(m, p, r).capability.effect, "pure");
});

for (const name of ["graphRead", "fileRead", "network", "secrets", "devices"]) {
  await check(`${name} requires every requested permission to be allowed`, () => {
    const m = clone(manifest); m.capabilities[0].permissions[name].push("additional-resource");
    rejects(() => grant(m), "PLUGIN_HOST_POLICY_PERMISSION_DENIED");
    const p = clone(policy); p.capability.permissions[name].push("additional-resource", "unused-resource");
    const result = grant(m, p);
    assert.deepEqual(result.capability.permissions[name], m.capabilities[0].permissions[name]);
    assert.equal(result.capability.permissions[name].includes("unused-resource"), false);
  });
}

await check("permission names are exact and wildcards are not expanded", () => {
  for (const allowed of [["*"], ["repository-*"], ["REPOSITORY-ROOT"], []]) {
    const p = clone(policy); p.capability.permissions.fileRead = allowed;
    rejects(() => grant(manifest, p), "PLUGIN_HOST_POLICY_PERMISSION_DENIED");
  }
});

await check("resource limits can only become smaller", () => {
  const p = clone(policy); p.capability.resources.timeoutMs = 30;
  p.capability.resources.maxOutputBytes = 4096;
  assert.deepEqual(grant(manifest, p).capability.resources, { timeoutMs: 30, maxOutputBytes: 4096 });
  const larger = clone(policy); larger.capability.resources.timeoutMs *= 2;
  larger.capability.resources.maxOutputBytes *= 2;
  assert.deepEqual(grant(manifest, larger).capability.resources, manifest.capabilities[0].resources);
  for (const key of ["maxMemoryBytes", "maxCostUnits"]) {
    const m = clone(manifest); m.capabilities[0].resources[key] = 100;
    const host = clone(policy); host.capability.resources[key] = 50;
    assert.equal(grant(m, host).capability.resources[key], 50);
    assert.equal(grant(m).capability.resources[key], 100);
    assert.equal(grant(manifest, host).capability.resources[key], 50);
  }
});

await check("invalid sets resources and logical values are rejected", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { ...policy, plugin: undefined }]) {
    rejects(() => validatePluginHostPolicy(value), "PLUGIN_HOST_POLICY_INVALID");
  }
  for (const bad of [null, [], {}, { ...policy.capability.permissions, extra: [] },
    { ...policy.capability.permissions, fileRead: ["x", "x"] },
    { ...policy.capability.permissions, fileRead: [""] },
    { ...policy.capability.permissions, network: "*" }]) {
    const p = clone(policy); p.capability.permissions = bad;
    rejects(() => validatePluginHostPolicy(p), "PLUGIN_HOST_POLICY_INVALID");
  }
  for (const bad of [null, {}, { timeoutMs: 0, maxOutputBytes: 1 },
    { timeoutMs: 1, maxOutputBytes: 1.5 }, { timeoutMs: 1, maxOutputBytes: 1, extra: 1 },
    { timeoutMs: 1, maxOutputBytes: 1, maxMemoryBytes: -1 }]) {
    const p = clone(policy); p.capability.resources = bad;
    rejects(() => validatePluginHostPolicy(p), "PLUGIN_HOST_POLICY_INVALID");
  }
});

await check("accessors are rejected without invocation", () => {
  for (const locate of [p => [p, "plugin"], p => [p.plugin, "packageDigest"],
    p => [p.capability.permissions, "network"]]) {
    const p = clone(policy); const [object, key] = locate(p); let invoked = false;
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return "private-value"; } });
    rejects(() => grant(manifest, p), "PLUGIN_HOST_POLICY_INVALID");
    assert.equal(invoked, false);
  }
});

await check("grant and authorized capability own their copies", () => {
  const m = clone(manifest); const p = clone(policy);
  const before = JSON.stringify({ m, p });
  const result = grant(m, p);
  assert.equal(Object.isFrozen(result.capability.resources), true);
  assert.equal(Object.isFrozen(result.capability.permissions.fileRead), true);
  const authorized = authorizePluginHostPolicy(m, request.capability.id, p);
  authorized.permissions.fileRead.push("mutated"); authorized.resources.timeoutMs = 999;
  assert.equal(JSON.stringify({ m, p }), before);
  p.capability.permissions.fileRead.push("later");
  assert.deepEqual(result.capability.permissions.fileRead, ["repository-root"]);
});

await check("denied and unsupported policies do not start a child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morivyx-host-policy-"));
  const marker = join(dir, "started");
  const args = ["--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`];
  try {
    rejects(() => runPluginProcess({ command: process.execPath, args, manifest, request }), "PLUGIN_HOST_POLICY_INVALID");
    const p = clone(policy); p.capability.permissions.fileRead = [];
    rejects(() => runPluginProcess({ command: process.execPath, args, manifest, request, policy: p }),
      "PLUGIN_HOST_POLICY_PERMISSION_DENIED");
    for (const key of ["maxMemoryBytes", "maxCostUnits"]) {
      const limited = clone(policy); limited.capability.resources[key] = 1024;
      rejects(() => runPluginProcess({ command: process.execPath, args, manifest, request, policy: limited }),
        "PLUGIN_RUN_RESOURCE_UNSUPPORTED");
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("real child receives the reduced grant without ambient environment", () => {
  const p = clone(policy); p.capability.resources.maxOutputBytes = 4096;
  const output = { format: "morivyx.plugin-run-result/0.1", runId: request.runId,
    plugin: request.plugin, capabilityId: request.capability.id, status: "success" };
  const code = `const result=${JSON.stringify(output)};result.output={grant:JSON.parse(process.env[${JSON.stringify(PLUGIN_EXECUTION_GRANT_ENV)}]),ambient:Object.hasOwn(process.env,'MORIVYX_TEST_HOST_SECRET')};process.stdout.write(JSON.stringify(result));`;
  const previous = process.env.MORIVYX_TEST_HOST_SECRET;
  process.env.MORIVYX_TEST_HOST_SECRET = "not-for-child";
  try {
    const result = runPluginProcess({ command: process.execPath, args: ["--eval", code], manifest, request, policy: p });
    assert.deepEqual(result.output.grant, grant(manifest, p));
    assert.equal(result.output.ambient, false);
  } finally {
    if (previous === undefined) delete process.env.MORIVYX_TEST_HOST_SECRET;
    else process.env.MORIVYX_TEST_HOST_SECRET = previous;
  }
});

await check("host output and timeout bounds stop real children", () => {
  const p = clone(policy); p.capability.resources.maxOutputBytes = 64;
  rejects(() => runPluginProcess({ command: process.execPath, args: ["--eval", 'process.stdout.write("x".repeat(1024))'],
    manifest, request, policy: p }), "PLUGIN_RUN_FAILED");
  p.capability.resources.maxOutputBytes = 1024;
  p.capability.resources.timeoutMs = 300;
  const started = Date.now();
  rejects(() => runPluginProcess({ command: process.execPath,
    args: ["--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], manifest, request, policy: p }), "PLUGIN_RUN_FAILED");
  assert.ok(Date.now() - started < 5000);
});

console.log(`Plugin host policy contract audit passed: ${checks} checks.`);
