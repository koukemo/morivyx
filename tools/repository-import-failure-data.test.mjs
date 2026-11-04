import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PackageError } from "../packages/kernel/src/errors.js";
import { validatePluginRunResult } from "../packages/kernel/src/plugin-communication.js";
import { importRepositoryFile, repositoryImportRequest } from "../packages/kernel/src/repository-importer.js";

const repositoryRoot = fileURLToPath(new URL("../packages/kernel/test/fixtures/plugin-communication/repository/", import.meta.url));
const request = overrides => repositoryImportRequest({ runId: "run:repository-fixture", repositoryRoot,
  externalId: "repository:fixture", locator: "source.txt", ...overrides });
const genericFailure = { code: "REPOSITORY_IMPORT_FAILED", message: "repositoryを読み取れませんでした。" };
function validFailure(result, runId = "invalid-run") {
  assert.equal(result.status, "failure");
  assert.equal(result.runId, runId);
  assert.equal(validatePluginRunResult(result), result);
}

test("rejected Proxy requests and accessors do not execute while building failures", async () => {
  let calls = 0;
  const trapped = new Proxy({}, {
    get() { calls++; throw new Error("OWNED_SENTINEL"); },
    getOwnPropertyDescriptor() { calls++; throw new Error("OWNED_SENTINEL"); },
    getPrototypeOf() { calls++; throw new Error("OWNED_SENTINEL"); },
    ownKeys() { calls++; throw new Error("OWNED_SENTINEL"); },
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessor = { get runId() { calls++; throw new Error("OWNED_SENTINEL"); } };
  const nested = request();
  Object.defineProperty(nested.input, "locator", { enumerable: true,
    get() { calls++; throw new Error("OWNED_SENTINEL"); } });
  for (const value of [trapped, revoked.proxy, accessor, null, [], 1, "invalid"]) {
    validFailure(await importRepositoryFile(value));
  }
  validFailure(await importRepositoryFile(nested), nested.runId);
  assert.equal(calls, 0);
});

test("only valid own enumerable string run identifiers survive request rejection", async () => {
  for (const runId of ["e\u0301", "é", "run:2026-09-05T01:00:00Z", " "]) {
    const value = { runId };
    validFailure(await importRepositoryFile(value), runId);
  }
  for (const runId of ["", "\ud800", "\udfff", "2026-02-30T00:00:00Z", 1, null, {}, undefined]) {
    validFailure(await importRepositoryFile({ runId }));
  }
  const hidden = {};
  Object.defineProperty(hidden, "runId", { value: "hidden" });
  validFailure(await importRepositoryFile(hidden));
  validFailure(await importRepositoryFile(Object.create({ runId: "inherited" })));
  const nullPrototype = Object.assign(Object.create(null), { runId: "own:null-prototype" });
  validFailure(await importRepositoryFile(nullPrototype), "own:null-prototype");
  // This identifier previously produced a failure that violated the result contract.
  validFailure(await importRepositoryFile(request({ runId: "\ud800" })));
});

test("thrown proxies, prototype proxies and diagnostic accessors yield fixed failures without execution", async () => {
  let calls = 0;
  const traps = {
    get() { calls++; throw new Error("OWNED_SENTINEL"); },
    getPrototypeOf() { calls++; throw new Error("OWNED_SENTINEL"); },
    getOwnPropertyDescriptor() { calls++; throw new Error("OWNED_SENTINEL"); },
  };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessorCode = new PackageError("OWNED_CODE", "/", "OWNED_MESSAGE");
  Object.defineProperty(accessorCode, "code", { get() { calls++; throw new Error("OWNED_SENTINEL"); } });
  const accessorMessage = new PackageError("OWNED_CODE", "/", "OWNED_MESSAGE");
  Object.defineProperty(accessorMessage, "message", { get() { calls++; throw new Error("OWNED_SENTINEL"); } });
  const inherited = Object.create(new PackageError("OWNED_CODE", "/", "OWNED_MESSAGE"));
  for (const error of [new Proxy({}, traps), revoked.proxy, Object.create(new Proxy({}, traps)),
    accessorCode, accessorMessage, inherited, { code: "OWNED_CODE", message: "OWNED_MESSAGE" },
    new Error("OWNED_SENTINEL"), null, Symbol("OWNED_SENTINEL")]) {
    const value = request();
    const result = await importRepositoryFile(value, { now() { throw error; } });
    validFailure(result, value.runId);
    assert.deepEqual(result.failure, genericFailure);
  }
  assert.equal(calls, 0);
});

test("valid PackageError data including subclasses is retained and malformed diagnostic data is refused", async () => {
  class LocalError extends PackageError {}
  for (const ErrorType of [PackageError, LocalError]) {
    const value = request();
    const error = new ErrorType("OWNED_LOCAL_CODE", "/", "e\u0301: local diagnostic");
    const result = await importRepositoryFile(value, { now() { throw error; } });
    validFailure(result, value.runId);
    assert.deepEqual(result.failure, { code: error.code, message: error.message });
  }
  for (const [code, message] of [["", "message"], ["CODE", ""], ["\ud800", "message"],
    ["CODE", "\udfff"], [1, "message"], ["CODE", {}]]) {
    const error = new PackageError("CODE", "/", "message");
    Object.defineProperties(error, { code: { value: code }, message: { value: message } });
    const value = request();
    const result = await importRepositoryFile(value, { now() { throw error; } });
    validFailure(result, value.runId);
    assert.deepEqual(result.failure, genericFailure);
  }
});

test("ordinary byte snapshots and specific missing, unavailable, locator and outside-root failures are preserved", async () => {
  const value = request();
  const result = await importRepositoryFile(value, { now: () => "2026-09-05T01:00:00Z" });
  assert.equal(result.status, "success");
  assert.equal(result.output.digest, "sha256:41719047f9824d28ef29e87214bbeb2c25e31dcd2a8c9ff3a28fda3ca4cd1353");
  assert.equal(validatePluginRunResult(result), result);
  const directory = await mkdtemp(join(tmpdir(), "morivyx-import-failure-"));
  try {
    await writeFile(join(directory, "outside.txt"), "owned local fixture\n");
    // A root inside this owned directory makes the absolute symlink point outside it.
    await mkdir(join(directory, "root"));
    await symlink(join(directory, "outside.txt"), join(directory, "root", "escape.txt"));
    for (const [overrides, code] of [
      [{ locator: "missing.txt" }, "REPOSITORY_IMPORT_TARGET_MISSING"],
      [{ repositoryRoot: join(directory, "absent") }, "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE"],
      [{ locator: "../outside.txt" }, "REPOSITORY_IMPORT_LOCATOR_INVALID"],
      [{ repositoryRoot: join(directory, "root"), locator: "escape.txt" }, "REPOSITORY_IMPORT_OUTSIDE_ROOT"],
    ]) {
      const input = request(overrides), failure = await importRepositoryFile(input);
      validFailure(failure, input.runId);
      assert.equal(failure.failure.code, code);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
