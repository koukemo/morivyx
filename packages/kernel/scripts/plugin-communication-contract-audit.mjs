import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_EXECUTION_GRANT_ENV,
  PLUGIN_EXECUTION_GRANT_FORMAT,
  PLUGIN_RUN_REQUEST_FORMAT,
  PLUGIN_RUN_RESULT_FORMAT,
  authorizePluginRunRequest,
  createPluginExecutionGrant,
  runPluginProcess,
  validatePluginRunRequest,
  validatePluginRunResult,
} from "../src/plugin-communication.js";
import {
  importRepositoryFile,
  repositoryImportRequest,
  validateRepositoryImportResult,
} from "../src/repository-importer.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const kernelDirectory = join(scriptDirectory, "..");
const fixtureDirectory = join(
  kernelDirectory,
  "test",
  "fixtures",
  "plugin-communication",
);
const manifestFixturePath = join(
  kernelDirectory,
  "test",
  "fixtures",
  "plugin-manifest",
  "repository-importer.json",
);
const hostPolicy = JSON.parse(await readFile(new URL("../test/fixtures/plugin-manifest/host-policy.json", import.meta.url), "utf8"));
const repositoryDirectory = join(fixtureDirectory, "repository");
const importerStdio = join(
  kernelDirectory,
  "src",
  "repository-importer-stdio.js",
);
const contractPath = join(
  kernelDirectory,
  "..",
  "..",
  "contracts",
  "plugin-communication@0.1.schema.json",
);

async function fixture(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

async function manifestFixture() {
  return JSON.parse(await readFile(manifestFixturePath, "utf8"));
}

function executableRequest(base) {
  return {
    ...base,
    input: {
      ...base.input,
      repositoryRoot: repositoryDirectory,
    },
  };
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
  const request = await fixture("request.json");
  const result = await fixture("result.json");
  assert.equal(validatePluginRunRequest(request), request);
  assert.equal(validatePluginRunResult(result, request), result);
  assert.equal(validateRepositoryImportResult(result, request), result);
});

await check("repository snapshot field types", async () => {
  const valid = await fixture("result.json");
  for (const field of ["digest", "retrievedAt"]) {
    for (const value of [
      [valid.output[field]],
      [[valid.output[field]]],
      [],
      {},
      null,
      true,
      123,
    ]) {
      const result = structuredClone(valid);
      result.output[field] = value;
      assert.throws(
        () => validateRepositoryImportResult(result),
        (error) => error.code === "REPOSITORY_IMPORT_RESULT_INVALID",
        `${field}: ${JSON.stringify(value)}`,
      );
    }
  }
});

await check("repository snapshot string timestamps", async () => {
  for (const timestamp of [
    "2026-09-05T01:00:00Z",
    "2026-09-05T01:00:00.123Z",
    "2026-09-05T10:00:00+09:00",
    "2026-09-04T20:00:00-05:00",
  ]) {
    const result = await fixture("result.json");
    result.output.retrievedAt = timestamp;
    assert.equal(validateRepositoryImportResult(result), result);
  }
});

await check("repository snapshot rejects array clock result", async () => {
  const request = executableRequest(await fixture("request.json"));
  const result = await importRepositoryFile(request, {
    now: () => ["2026-09-05T01:00:00Z"],
  });
  assert.equal(result.status, "failure");
  assert.equal(result.failure.code, "REPOSITORY_IMPORT_RESULT_INVALID");
  assert.equal(validateRepositoryImportResult(result, request), result);
});

await check("language-independent contract", async () => {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(
    contract.$defs.RunRequest.properties.format.const,
    PLUGIN_RUN_REQUEST_FORMAT,
  );
  for (const branch of contract.$defs.RunResult.oneOf) {
    assert.equal(branch.properties.format.const, PLUGIN_RUN_RESULT_FORMAT);
  }
  assert.deepEqual(contract.$defs.RunRequest.required, [
    "format",
    "runId",
    "plugin",
    "capability",
    "input",
  ]);
});

await check("repository snapshot", async () => {
  const request = executableRequest(await fixture("request.json"));
  const originalRequest = structuredClone(request);
  const expected = await fixture("result.json");
  const result = await importRepositoryFile(request, {
    now: () => "2026-09-05T01:00:00Z",
  });
  assert.deepEqual(result, expected);
  assert.equal(validateRepositoryImportResult(result, request), result);
  assert.deepEqual(request, originalRequest);
});

await check("repository request snapshot before asynchronous reads", async () => {
  const mutations = [
    (request) => { request.runId = "run:changed"; },
    (request) => { request.input.externalId = "repository:changed"; },
    (request) => { request.input.locator = "missing.txt"; },
    (request) => { request.input.repositoryRoot = join(repositoryDirectory, "missing-root"); },
    (request) => { request.plugin.id = "morivyx.changed"; },
    (request) => { request.capability.id = "repository.changed"; },
    (request) => { request.input = null; },
  ];
  const expected = await fixture("result.json");
  for (const mutate of mutations) {
    const request = executableRequest(await fixture("request.json"));
    const originalRequest = structuredClone(request);
    const pending = importRepositoryFile(request, {
      now: () => "2026-09-05T01:00:00Z",
    });
    mutate(request);
    const callerState = structuredClone(request);
    const result = await pending;
    assert.deepEqual(result, expected);
    assert.equal(validateRepositoryImportResult(result, originalRequest), result);
    assert.deepEqual(request, callerState);
  }
});

await check("repository request snapshot during clock callback", async () => {
  for (const timestamp of ["2026-09-05T01:00:00Z", null]) {
    const request = executableRequest(await fixture("request.json"));
    const originalRequest = structuredClone(request);
    const result = await importRepositoryFile(request, {
      now: () => {
        request.runId = "run:changed-by-clock";
        request.input.externalId = "repository:changed-by-clock";
        request.input.locator = "missing.txt";
        return timestamp;
      },
    });
    if (timestamp === null) {
      assert.equal(result.status, "failure");
      assert.equal(result.failure.code, "REPOSITORY_IMPORT_RESULT_INVALID");
      assert.equal(result.runId, originalRequest.runId);
    } else {
      assert.deepEqual(result, await fixture("result.json"));
    }
    assert.equal(validateRepositoryImportResult(result, originalRequest), result);
  }
});

await check("repository request snapshot on asynchronous failures", async () => {
  for (const [input, code] of [
    [{ repositoryRoot: join(repositoryDirectory, "missing-root") }, "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE"],
    [{ locator: "missing.txt" }, "REPOSITORY_IMPORT_TARGET_MISSING"],
  ]) {
    const request = executableRequest(await fixture("request.json"));
    Object.assign(request.input, input);
    const originalRequest = structuredClone(request);
    const pending = importRepositoryFile(request);
    request.runId = "run:changed-after-failure-start";
    request.input = null;
    const result = await pending;
    assert.equal(result.status, "failure");
    assert.equal(result.failure.code, code);
    assert.equal(result.runId, originalRequest.runId);
    assert.equal(validateRepositoryImportResult(result, originalRequest), result);
  }
});

await check("stdio process", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  const result = runPluginProcess({
    policy: hostPolicy,
    command: process.execPath,
    args: [importerStdio],
    manifest,
    request,
  });
  assert.equal(result.status, "success");
  assert.equal(result.output.externalIdentity.externalId, "repository:fixture");
  assert.equal(result.output.locator, "source.txt");
  assert.equal(
    result.output.digest,
    "sha256:41719047f9824d28ef29e87214bbeb2c25e31dcd2a8c9ff3a28fda3ca4cd1353",
  );
  validateRepositoryImportResult(result, request);
});

await check("process failures", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", 'process.stdout.write("not-json\\n")'],
        manifest,
        request,
      }),
    (error) => error.code === "PLUGIN_RESULT_INVALID",
  );
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "process.exit(7)"],
        manifest,
        request,
      }),
    (error) => error.code === "PLUGIN_RUN_FAILED",
  );
});

await check("process rejects malformed UTF-8 without exposing output", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  const result = await fixture("result.json");
  result.output = { note: "private-fixture-MARKER" };
  const encoded = Buffer.from(`${JSON.stringify(result)}\n`);
  const offset = encoded.indexOf("MARKER");
  for (const invalid of [[255], [128], [192, 175], [227, 129], [237, 160, 128], [244, 144, 128, 128]]) {
    const bytes = Buffer.concat([encoded.subarray(0, offset), Buffer.from(invalid), encoded.subarray(offset + 6)]);
    assert.throws(() => runPluginProcess({
      policy: hostPolicy, manifest, request, command: process.execPath,
      args: ["--eval", `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"))`],
    }), error => {
      assert.equal(error.code, "PLUGIN_RESULT_INVALID");
      assert.equal(error.message.includes("private-fixture"), false);
      return true;
    });
  }
});

await check("process preserves valid Japanese and replacement characters", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  const expected = await fixture("result.json");
  expected.output = { note: "日本語と置換文字\uFFFD" };
  const result = runPluginProcess({
    policy: hostPolicy, manifest, request, command: process.execPath,
    args: ["--eval", `process.stdout.write(${JSON.stringify(JSON.stringify(expected))})`],
  });
  assert.deepEqual(result, expected);
});

await check("manifest authorization", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  assert.equal(authorizePluginRunRequest(manifest, request).id, "repository.read-file");
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "process.exit(99)"],
        request,
      }),
    (error) => error.code === "PLUGIN_MANIFEST_INVALID",
  );
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "process.exit(99)"],
        manifest,
        request: {
          ...request,
          plugin: { ...request.plugin, id: "morivyx.other-plugin" },
        },
      }),
    (error) => error.code === "PLUGIN_MANIFEST_IDENTITY_MISMATCH",
  );
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "process.exit(99)"],
        manifest,
        request: {
          ...request,
          capability: { id: "repository.read-tree", effect: "read-only" },
        },
      }),
    (error) => error.code === "PLUGIN_CAPABILITY_UNDECLARED",
  );
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "process.exit(99)"],
        manifest,
        request: {
          ...request,
          capability: { ...request.capability, effect: "external-effect" },
        },
      }),
    (error) => error.code === "PLUGIN_CAPABILITY_EFFECT_MISMATCH",
  );
});

await check("execution grant", async () => {
  const manifest = await manifestFixture();
  const request = executableRequest(await fixture("request.json"));
  const grant = createPluginExecutionGrant(manifest, request, hostPolicy);
  assert.equal(grant.format, PLUGIN_EXECUTION_GRANT_FORMAT);
  assert.equal(grant.runId, request.runId);
  assert.deepEqual(grant.plugin, request.plugin);
  assert.deepEqual(grant.capability.permissions, {
    graphRead: [],
    fileRead: ["repository-root"],
    network: [],
    secrets: [],
    devices: [],
  });
  assert.deepEqual(grant.capability.resources, {
    timeoutMs: 5000,
    maxOutputBytes: 1048576,
  });
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.capability.permissions.fileRead), true);
  manifest.capabilities[0].permissions.fileRead.push("mutated-after-grant");
  assert.deepEqual(grant.capability.permissions.fileRead, ["repository-root"]);

  const executionManifest = await manifestFixture();
  const previousAmbient = process.env.MORIVYX_TEST_AMBIENT_SECRET;
  process.env.MORIVYX_TEST_AMBIENT_SECRET = "must-not-cross-plugin-boundary";
  try {
    const probe = `
const grant = JSON.parse(process.env[${JSON.stringify(PLUGIN_EXECUTION_GRANT_ENV)}]);
process.stdout.write(JSON.stringify({
  format: ${JSON.stringify(PLUGIN_RUN_RESULT_FORMAT)},
  runId: ${JSON.stringify(request.runId)},
  plugin: ${JSON.stringify(request.plugin)},
  capabilityId: ${JSON.stringify(request.capability.id)},
  status: "success",
  output: {
    grant,
    ambientInherited: Object.hasOwn(process.env, "MORIVYX_TEST_AMBIENT_SECRET")
  }
}));
`;
    const result = runPluginProcess({
      policy: hostPolicy,
      command: process.execPath,
      args: ["--eval", probe],
      manifest: executionManifest,
      request,
    });
    assert.deepEqual(result.output.grant, createPluginExecutionGrant(executionManifest, request, hostPolicy));
    assert.equal(result.output.ambientInherited, false);
  } finally {
    if (previousAmbient === undefined) {
      delete process.env.MORIVYX_TEST_AMBIENT_SECRET;
    } else {
      process.env.MORIVYX_TEST_AMBIENT_SECRET = previousAmbient;
    }
  }
});

await check("manifest resource limits", async () => {
  const request = executableRequest(await fixture("request.json"));
  const outputLimited = await manifestFixture();
  outputLimited.capabilities[0].resources.maxOutputBytes = 64;
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", 'process.stdout.write("x".repeat(1024))'],
        manifest: outputLimited,
        request,
      }),
    (error) => error.code === "PLUGIN_RUN_FAILED",
  );

  const timeoutLimited = await manifestFixture();
  timeoutLimited.capabilities[0].resources.timeoutMs = 1;
  assert.throws(
    () =>
      runPluginProcess({
        policy: hostPolicy,
        command: process.execPath,
        args: ["--eval", "while (true) {}"],
        manifest: timeoutLimited,
        request,
      }),
    (error) => error.code === "PLUGIN_RUN_FAILED",
  );
});

await check("request/result identity", async () => {
  const request = await fixture("request.json");
  const result = await fixture("result.json");
  assert.throws(
    () => validatePluginRunResult({ ...result, runId: "run:other" }, request),
    (error) => error.code === "PLUGIN_RESULT_MISMATCH",
  );
});

await check("read-only failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-plugin-read-only-"));
  try {
    const sentinel = join(directory, "sentinel.txt");
    await writeFile(sentinel, "unchanged\n", "utf8");
    const request = repositoryImportRequest({
      runId: "run:missing",
      repositoryRoot: directory,
      externalId: "repository:read-only-fixture",
      locator: "missing.txt",
    });
    const before = await readFile(sentinel, "utf8");
    const result = await importRepositoryFile(request, {
      now: () => "2026-09-05T01:00:00Z",
    });
    const after = await readFile(sentinel, "utf8");
    assert.equal(result.status, "failure");
    assert.equal(before, after);
    assert.equal(validateRepositoryImportResult(result, request), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await check("repository boundary", async () => {
  const request = repositoryImportRequest({
    runId: "run:outside",
    repositoryRoot: repositoryDirectory,
    externalId: "repository:fixture",
    locator: "../outside.txt",
  });
  const result = await importRepositoryFile(request, {
    now: () => "2026-09-05T01:00:00Z",
  });
  assert.equal(result.status, "failure");
  assert.equal(result.failure.code, "REPOSITORY_IMPORT_LOCATOR_INVALID");
  assert.equal(result.failure.message.includes(repositoryDirectory), false);
});

assert.equal(checks, 19);
console.log(`Plugin communication contract audit passed: ${checks} checks.`);
