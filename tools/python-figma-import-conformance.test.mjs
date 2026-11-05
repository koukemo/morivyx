import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { validateFigmaImportRequest, validateFigmaImportResult, convertFigmaImportResponse,
  importFigmaNode, serveFigmaImporter } from "../packages/kernel/src/figma-importer.js";
import { compareFigmaImportSnapshots } from "../packages/kernel/src/figma-reimport.js";

export const sha = value => createHash("sha256").update(value).digest("hex");
export function bodyBytes(spec) {
  if (Object.hasOwn(spec, "bodyValue")) return spec.bodyValue;
  if (Object.hasOwn(spec, "bodyHex")) return Buffer.from(spec.bodyHex, "hex");
  if (spec.expansion) {
    const { prefix, unit, count, suffix, sha256 } = spec.expansion;
    const text = prefix + unit.repeat(count) + suffix;
    assert.equal(sha(text), sha256); return Buffer.from(text);
  }
  return Buffer.from(spec.body ?? "", "utf8");
}

export function scriptedAcquisition(spec) {
  const plan = spec.plan ?? {}, events = { calls: [], reads: 0, aborts: 0, bodyCancels: 0, readerCancels: 0, releases: 0, clocks: 0 };
  let lateResponse, blockedRead;
  const bytes = bodyBytes(spec);
  let offset = 0;
  const reader = {
    async read() {
      events.reads++;
      if (plan.readMode === "throw") throw new Error("OWNED_FAILURE_MUST_NOT_ESCAPE");
      if (plan.readMode === "never") return new Promise(resolve => { blockedRead = resolve; });
      if (offset >= bytes.length) return { done: true, value: undefined };
      const end = Math.min(offset + (plan.chunkSize ?? bytes.length), bytes.length);
      const value = plan.readMode === "invalid" ? [] : bytes.subarray(offset, end); offset = end;
      return { done: false, value };
    },
    async cancel() { events.readerCancels++; blockedRead?.({ done: true, value: undefined }); },
    releaseLock() { events.releases++; },
  };
  const body = {
    getReader() { if (plan.readerMode === "throw") throw Error("OWNED_READER_FAILURE"); return reader; },
    async cancel() { events.bodyCancels++; },
  };
  const response = { status: plan.status ?? 200, redirected: plan.redirected ?? false,
    url: plan.url ?? "", body: plan.bodyMode === "null" ? null : body,
    headers: { get(name) {
      if (name === "content-type") return Object.hasOwn(plan, "contentType") ? plan.contentType : "application/json";
      if (name === "content-length") return Object.hasOwn(plan, "contentLength") ? plan.contentLength : null;
      return null;
    } },
  };
  const fetchImpl = async (url, options) => {
    events.calls.push({ url, method: options.method, redirect: options.redirect, cache: options.cache,
      headers: { ...options.headers }, signalAborted: options.signal.aborted });
    options.signal.addEventListener("abort", () => { events.aborts++; }, { once: true });
    if (plan.fetchMode === "throw") throw Error("OWNED_FETCH_FAILURE");
    if (plan.fetchMode === "never") return new Promise(() => {});
    if (plan.fetchMode === "late") return new Promise(resolve => { lateResponse = resolve; });
    return plan.responseMode === "null" ? null : response;
  };
  const now = () => {
    events.clocks++;
    if (plan.clockMode === "throw") throw Error("OWNED_CLOCK_FAILURE");
    return spec.retrievedAt;
  };
  const options = spec.options === null ? null : { ...spec.options, fetchImpl: plan.adapterMode === "invalid" ? false : fetchImpl,
    now: plan.clockMode === "invalid" ? false : now };
  return { options, events, async settle() {
    lateResponse?.(response);
    // Observe the source's cleanup after a timeout without arbitrary sleeps or
    // keeping an external request or a background timer alive.
    await new Promise(resolve => setImmediate(resolve));
  } };
}

export async function nodeFigmaCase(entry) {
  const spec = JSON.parse(entry.inputText), before = JSON.stringify(spec);
  let result, original, acquisition;
  try {
    if (entry.operation === "validate-request") { original = spec; result = validateFigmaImportRequest(spec); }
    else if (entry.operation === "validate-result") { original = spec.result; result = validateFigmaImportResult(spec.result, spec.request ?? null); }
    else if (entry.operation === "convert") result = Object.hasOwn(spec, "limits")
      ? convertFigmaImportResponse(spec.request, bodyBytes(spec), spec.retrievedAt, spec.limits)
      : convertFigmaImportResponse(spec.request, bodyBytes(spec), spec.retrievedAt);
    else if (entry.operation === "compare") result = compareFigmaImportSnapshots(spec);
    else if (entry.operation === "acquire") {
      acquisition = scriptedAcquisition(spec);
      result = await importFigmaNode(spec.request, acquisition.options);
      await acquisition.settle();
    } else throw Error("UNSUPPORTED_FIXTURE_OPERATION");
    assert.equal(JSON.stringify(spec), before);
    const outputText = JSON.stringify(result);
    return { accepted: true, outputText, outputSha256: sha(outputText), canonicalSha256: sha(canonicalJson(result)),
      sameInput: original === undefined ? null : result === original, events: acquisition?.events ?? null };
  } catch (error) {
    assert.equal(JSON.stringify(spec), before);
    return { accepted: false, code: error.code ?? error.name, path: error.path ?? null, events: acquisition?.events ?? null };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--stdio-worker") {
    const spec = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
    const { options } = scriptedAcquisition(spec);
    const result = await serveFigmaImporter(options);
    process.exitCode = result.exitCode;
  } else {
    const bytes = await readFile(new URL("../packages/portable-core/fixtures/figma-import-vectors.json", import.meta.url));
    const fixture = JSON.parse(bytes);
    test("pinned Figma source functions reproduce all frozen logical and acquisition outcomes", async () => {
      assert.equal(sha(bytes), "a9fe6e7ab19f3b1ce360b6f14c6c0660543c286253c46f5f489bb9dc8a591f0c");
      for (const [path, expected] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), expected, path);
      for (const entry of fixture.cases) assert.deepEqual(await nodeFigmaCase(entry), entry.expected, entry.id);
    });
    const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
    const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
    function runPython(args, { input, cwd = core, env = process.env, executable = python } = {}) {
      const child = spawnSync(executable, ["-B", ...args], { input, cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
    }
    function verifyReplay(text) {
      const results = JSON.parse(text); assert.equal(results.length, fixture.count);
      for (let index = 0; index < fixture.count; index++) {
        assert.equal(results[index].id, fixture.cases[index].id);
        assert.deepEqual(results[index].outcome, fixture.cases[index].expected, fixture.cases[index].id);
      }
    }
    test("independent Python reproduces every raw result and acquisition cleanup event", () => {
      assert.match(runPython(["-m", "unittest", "test_figma_import"]).stderr, /Ran 7 tests/);
      verifyReplay(runPython(["test_figma_import.py", "--replay"]).stdout);
    });
    test("only the public 44 production modules and driver reproduce all cases without Node or Git", async () => {
      const directory = await mkdtemp(join(tmpdir(), "morivyx-figma-isolated-"));
      try {
        const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
        const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
        assert.equal(modules.length, 44);
        for (const name of [...modules, "test_figma_import.py"]) await cp(join(core, name), join(directory, name));
        await mkdir(join(directory, "fixtures")); await cp(join(core, "fixtures/figma-import-vectors.json"), join(directory, "fixtures/figma-import-vectors.json"));
        const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
        verifyReplay(runPython(["test_figma_import.py", "--replay", "--isolated"], { executable, cwd: directory,
          env: { PATH: "", PYTHONIOENCODING: "utf-8" } }).stdout);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
    test("real Node and Python response children agree on framing, failures and redaction", () => {
      const base = { request: fixture.request, body: JSON.stringify(fixture.response), retrievedAt: fixture.retrievedAt, options: fixture.options };
      const cases = [
        { spec: base, input: JSON.stringify(fixture.request) + "\n" },
        { spec: { ...base, options: { ...base.options, permission: null } }, input: JSON.stringify(fixture.request) },
        { spec: { ...base, plan: { fetchMode: "throw" } }, input: JSON.stringify(fixture.request) },
        { spec: { ...base, plan: { fetchMode: "never" }, options: { ...base.options, limits: { timeoutMs: 2 } } }, input: JSON.stringify(fixture.request) },
        ...["{}", "{}\n{}", "{broken", JSON.stringify({ ...fixture.request, input: {} })].map(input => ({ spec: base, input })),
      ];
      for (const { spec, input } of cases) {
        const encoded = Buffer.from(JSON.stringify(spec)).toString("base64");
        const node = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--stdio-worker", encoded], {
          input, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        const portable = spawnSync(python, ["-B", join(core, "test_figma_import.py"), "--stdio-worker", encoded], {
          input, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        assert.equal(node.error, undefined); assert.equal(portable.error, undefined);
        assert.ok([0, 2].includes(node.status));
        assert.deepEqual({ exit: portable.status, stdout: portable.stdout, stderr: portable.stderr },
          { exit: node.status, stdout: node.stdout, stderr: node.stderr }, input);
        assert.doesNotMatch(portable.stdout + portable.stderr, /PRIVATE_|owned-synthetic-test-token|OWNED_.*FAILURE/u);
      }
    });
    test("external JSON numeric spelling and key boundaries agree with the pinned converter", async () => {
      const entries = [], node = structuredClone(fixture.response);
      function add(id, body) { entries.push({ id, operation: "convert", inputText: JSON.stringify({ request: fixture.request, body, retrievedAt: fixture.retrievedAt }) }); }
      const nodeId = fixture.request.input.nodeId, bits = Buffer.alloc(8); let state = 0x73519726;
      for (let index = 0; index < 1024; index++) {
        for (const offset of [0, 4]) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; bits.writeUInt32BE(state, offset); }
        const number = bits.readDoubleBE(); if (!Number.isFinite(number)) continue;
        node.nodes[nodeId].document.extra = number; add(`binary64-${index}`, JSON.stringify(node));
      }
      for (const size of [1022, 1023, 1024, 1025, 2048]) for (const key of ["x".repeat(size), "🧸".repeat(size)]) {
        node.nodes[nodeId].document.extra = { [key]: "owned" }; add(`key-${size}-${key.length}`, JSON.stringify(node));
      }
      const body = JSON.stringify(fixture.response);
      for (const source of [body.slice(0, -1) + ',"outside":1e400}',
        body.replace('"x":0.25', '"x":9007199254740991.1'),
        body.replace('"x":0.25', '"x":-0.00000001'),
        body.replace('"version":"1001"', '"version":[],' + '"version":"1001"')]) add(`syntax-${entries.length}`, source);
      const expected = [];
      for (const entry of entries) expected.push(await nodeFigmaCase(entry));
      const actual = JSON.parse(runPython(["test_figma_import.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
      assert.equal(actual.length, expected.length);
      for (let index = 0; index < entries.length; index++) assert.deepEqual(actual[index], expected[index], entries[index].id);
    });
    test("trusted error inheritance retains source diagnostics without invoking exception properties", async () => {
      let Original;
      try { validateFigmaImportRequest(null); } catch (error) { Original = error.constructor; }
      assert.equal(typeof Original, "function");
      class Derived extends Original {}
      const guarded = new Derived("SOURCE_UNAVAILABLE");
      const prototype = Object.create(Derived.prototype, { code: { get() { throw Error("GETTER_MUST_NOT_RUN"); } } });
      Object.setPrototypeOf(guarded, prototype);
      const method = new Derived("SOURCE_UNAVAILABLE"); method.get = () => { throw Error("METHOD_MUST_NOT_RUN"); };
      const getter = new Derived("SOURCE_UNAVAILABLE");
      Object.defineProperty(getter, "code", { get() { throw Error("OWN_GETTER_MUST_NOT_RUN"); } });
      const number = new Derived("SOURCE_UNAVAILABLE"); number.code = 7;
      const surrogate = new Derived("SOURCE_UNAVAILABLE"); surrogate.code = "\ud800";
      const expected = [];
      for (const error of [new Original("SOURCE_UNAVAILABLE"), new Derived("SOURCE_UNAVAILABLE"), guarded, method, getter, number, surrogate]) {
        const result = await importFigmaNode(fixture.request, { ...fixture.options, fetchImpl: () => { throw error; } });
        expected.push(result.failure.code);
      }
      assert.deepEqual(expected, ["FIGMA_IMPORT_SOURCE_UNAVAILABLE", "FIGMA_IMPORT_SOURCE_UNAVAILABLE", "FIGMA_IMPORT_SOURCE_UNAVAILABLE", "FIGMA_IMPORT_SOURCE_UNAVAILABLE",
        "FIGMA_IMPORT_FAILED", "FIGMA_IMPORT_FAILED", "FIGMA_IMPORT_FAILED"]);
      assert.deepEqual(JSON.parse(runPython(["test_figma_import.py", "--trusted-probes"]).stdout), expected);
    });
    test("declared response length keeps source capacity semantics despite long leading zeroes", async () => {
      const values = ["", "0".repeat(6000), "0".repeat(6000) + "1", "0".repeat(6000) + "2097152",
        "0".repeat(6000) + "2097153", "9".repeat(6000), "0".repeat(6000) + "x", "-1", "1\n"];
      const entries = values.map((contentLength, index) => ({ id: `declared-length-${index}`, operation: "acquire",
        inputText: JSON.stringify({ request: fixture.request, body: JSON.stringify(fixture.response), retrievedAt: fixture.retrievedAt,
          options: fixture.options, plan: { contentLength } }) }));
      const expected = [];
      for (const entry of entries) expected.push(await nodeFigmaCase(entry));
      const actual = JSON.parse(runPython(["test_figma_import.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
      assert.equal(actual.length, expected.length);
      for (let index = 0; index < entries.length; index++) assert.deepEqual(actual[index], expected[index], entries[index].id);
    });
  }
}
