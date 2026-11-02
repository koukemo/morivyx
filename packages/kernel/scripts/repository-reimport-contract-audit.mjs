import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_IMPORT_COMPARISON_FORMAT,
  compareRepositoryImportSnapshots,
  importRepositoryFile,
  repositoryImportRequest,
} from "../src/repository-importer.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const kernelDirectory = join(scriptDirectory, "..");
const fixtureDirectory = join(
  kernelDirectory,
  "test",
  "fixtures",
  "plugin-communication",
);
const repositoryDirectory = join(fixtureDirectory, "repository");

async function fixture(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

function requestFor(repositoryRoot, externalId = "repository:fixture") {
  return repositoryImportRequest({
    runId: `run:reimport:${externalId}`,
    repositoryRoot,
    externalId,
    locator: "source.txt",
  });
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

const previousResult = await fixture("result.json");

await check("current snapshot", async () => {
  const currentRequest = requestFor(repositoryDirectory);
  const currentResult = await importRepositoryFile(currentRequest, {
    now: () => "2026-09-05T02:00:00Z",
  });
  const comparison = compareRepositoryImportSnapshots({
    previousResult,
    currentRequest,
    currentResult,
  });
  assert.equal(comparison.format, REPOSITORY_IMPORT_COMPARISON_FORMAT);
  assert.equal(comparison.status, "current");
  assert.deepEqual(comparison.issues, []);
  assert.equal(comparison.previous.digest, previousResult.output.digest);
  assert.equal(comparison.current.digest, previousResult.output.digest);
});

await check("changed snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-reimport-stale-"));
  try {
    await writeFile(join(directory, "source.txt"), "changed\n", "utf8");
    const currentRequest = requestFor(directory);
    const currentResult = await importRepositoryFile(currentRequest, {
      now: () => "2026-09-05T02:01:00Z",
    });
    const comparison = compareRepositoryImportSnapshots({
      previousResult,
      currentRequest,
      currentResult,
    });
    assert.equal(comparison.status, "stale");
    assert.deepEqual(comparison.issues, [
      { code: "REPOSITORY_REIMPORT_DIGEST_CHANGED" },
    ]);
    assert.notEqual(comparison.current.digest, comparison.previous.digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await check("missing target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-reimport-missing-"));
  try {
    const currentRequest = requestFor(directory);
    const currentResult = await importRepositoryFile(currentRequest, {
      now: () => "2026-09-05T02:02:00Z",
    });
    assert.equal(currentResult.failure.code, "REPOSITORY_IMPORT_TARGET_MISSING");
    const comparison = compareRepositoryImportSnapshots({
      previousResult,
      currentRequest,
      currentResult,
    });
    assert.equal(comparison.status, "missing");
    assert.equal(comparison.current.status, "missing");
    assert.deepEqual(comparison.issues, [
      { code: "REPOSITORY_REIMPORT_TARGET_MISSING" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await check("unavailable source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-reimport-unavailable-"));
  await rm(directory, { recursive: true, force: true });
  const currentRequest = requestFor(directory);
  const currentResult = await importRepositoryFile(currentRequest, {
    now: () => "2026-09-05T02:03:00Z",
  });
  assert.equal(currentResult.failure.code, "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE");
  const comparison = compareRepositoryImportSnapshots({
    previousResult,
    currentRequest,
    currentResult,
  });
  assert.equal(comparison.status, "unavailable");
  assert.equal(comparison.current.status, "unavailable");
  assert.deepEqual(comparison.issues, [
    { code: "REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE" },
  ]);
});

await check("identity mismatch", async () => {
  const currentRequest = requestFor(repositoryDirectory, "repository:other");
  const currentResult = await importRepositoryFile(currentRequest, {
    now: () => "2026-09-05T02:04:00Z",
  });
  const comparison = compareRepositoryImportSnapshots({
    previousResult,
    currentRequest,
    currentResult,
  });
  assert.equal(comparison.status, "invalid");
  assert.deepEqual(comparison.issues, [
    { code: "REPOSITORY_REIMPORT_IDENTITY_MISMATCH" },
  ]);
});

await check("snapshot field types reject invalid comparison inputs", async () => {
  const currentRequest = requestFor(repositoryDirectory);
  const currentResult = await importRepositoryFile(currentRequest);
  for (const side of ["previousResult", "currentResult"]) {
    for (const field of ["digest", "retrievedAt"]) {
      const input = {
        previousResult: structuredClone(previousResult),
        currentRequest,
        currentResult: structuredClone(currentResult),
      };
      input[side].output[field] = [input[side].output[field]];
      const comparison = compareRepositoryImportSnapshots(input);
      assert.equal(comparison.status, "invalid", `${side}.${field}`);
      assert.deepEqual(comparison.issues, [
        { code: "REPOSITORY_REIMPORT_INPUT_INVALID" },
      ]);
      assert.equal(comparison.previous, null);
      assert.equal(comparison.current, null);
    }
  }
});

async function validInput() {
  const currentRequest = requestFor(repositoryDirectory);
  return {
    previousResult: structuredClone(previousResult),
    currentRequest,
    currentResult: await importRepositoryFile(currentRequest, {
      now: () => "2026-09-08T06:00:00Z",
    }),
  };
}

function assertInvalidInput(input) {
  assert.deepEqual(compareRepositoryImportSnapshots(input), {
    format: REPOSITORY_IMPORT_COMPARISON_FORMAT,
    externalIdentity: null,
    locator: null,
    previous: null,
    current: null,
    status: "invalid",
    issues: [{ code: "REPOSITORY_REIMPORT_INPUT_INVALID" }],
  });
}

await check("invalid comparison input roots", async () => {
  assert.equal(compareRepositoryImportSnapshots.length, 1);
  for (const input of [
    undefined, null, [], true, 123, "text", 1n, Symbol("input"), () => {},
  ]) {
    assertInvalidInput(input);
  }
});

await check("nonlogical comparison input records", async () => {
  const valid = await validInput();
  const hidden = { ...valid };
  Object.defineProperty(hidden, "hidden", { value: "private-root-sentinel" });
  const cyclic = { ...valid };
  cyclic.self = cyclic;
  const array = Object.assign([], valid);
  for (const input of [
    Object.create(valid), new Date(), new Map(), hidden, cyclic, array,
    { ...valid, [Symbol("extra")]: "private-root-sentinel" },
    { ...valid, extra: Infinity },
  ]) {
    assertInvalidInput(input);
  }
});

await check("comparison input accessors are not executed", async () => {
  for (const path of [
    ["previousResult"], ["currentRequest"], ["currentResult"],
    ["previousResult", "output", "digest"],
    ["currentRequest", "input", "locator"],
    ["currentResult", "output", "retrievedAt"],
  ]) {
    const input = await validInput();
    let container = input;
    for (const key of path.slice(0, -1)) container = container[key];
    let reads = 0;
    Object.defineProperty(container, path.at(-1), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private-root-sentinel");
      },
    });
    assertInvalidInput(input);
    assert.equal(reads, 0, path.join("."));
  }
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

await check("frozen comparison input is deterministic and unchanged", async () => {
  const input = deepFreeze(await validInput());
  const before = JSON.stringify(input);
  const first = compareRepositoryImportSnapshots(input);
  assert.equal(first.status, "current");
  assert.deepEqual(first, compareRepositoryImportSnapshots(input));
  assert.equal(JSON.stringify(input), before);
  first.externalIdentity.externalId = "output-only";
  first.previous.digest = "output-only";
  first.current.digest = "output-only";
  assert.equal(JSON.stringify(input), before);
});

await check("null prototype comparison input", async () => {
  const input = Object.assign(Object.create(null), await validInput());
  assert.equal(compareRepositoryImportSnapshots(input).status, "current");
});

assert.equal(checks, 11);
console.log(`Repository reimport contract audit passed: ${checks} checks.`);
