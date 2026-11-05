import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setMaxListeners } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { githubImportRequest, validateGitHubImportRequest, validateGitHubImportResult,
  convertGitHubImportResponses, importGitHubFile } from "../packages/kernel/src/github-importer.js";
import { compareGitHubImportSnapshots, assessGitHubReimport } from "../packages/kernel/src/github-reimport.js";
import { servePluginStdio } from "../packages/kernel/src/plugin-stdio.js";

export const sha = value => createHash("sha256").update(value).digest("hex");
export function bodyBytes(spec) {
  if (Object.hasOwn(spec, "bodyValue")) return spec.bodyValue;
  if (Object.hasOwn(spec, "bodyHex")) return Buffer.from(spec.bodyHex, "hex");
  if (spec.expansion) {
    const part = spec.expansion, text = part.prefix + part.unit.repeat(part.count) + part.suffix;
    assert.equal(sha(text), part.sha256); return Buffer.from(text);
  }
  return Buffer.from(spec.body ?? "", "utf8");
}
export function capturedResponses(spec) {
  return Array.isArray(spec) ? spec.map(row => Object.hasOwn(row, "raw") ? row.raw : { path: row.path, bytes: bodyBytes(row) }) : spec;
}

export function scriptedAcquisition(spec) {
  const events = { calls: [], reads: 0, aborts: 0, bodyCancels: 0, readerCancels: 0, releases: 0, clocks: 0 };
  const late = [], blocked = [];
  const fetchImpl = async (url, options) => {
    const index = events.calls.length, row = spec.responses?.[index] ?? { body: "{}" };
    if (index === 0) setMaxListeners(0, options.signal);
    const plan = { ...((spec.plan?.at === undefined || spec.plan.at === index) ? spec.plan : {}), ...row.plan };
    events.calls.push({ url, method: options.method, redirect: options.redirect, cache: options.cache,
      headers: { ...options.headers }, signalAborted: options.signal.aborted });
    options.signal.addEventListener("abort", () => { events.aborts++; }, { once: true });
    const bytes = bodyBytes(row); let offset = 0;
    const storage = plan.reuseChunk ? Buffer.alloc(plan.chunkSize ?? 7) : null;
    const reader = {
      async read() {
        events.reads++;
        if (plan.readMode === "throw") throw Error("OWNED_READ_FAILURE");
        if (plan.readMode === "never") return new Promise(resolve => { blocked.push(resolve); });
        if (offset >= bytes.length) return { done: true, value: undefined };
        const end = Math.min(offset + (plan.chunkSize ?? bytes.length), bytes.length);
        let value = bytes.subarray(offset, end);
        if (storage) { storage.fill(0); value.copy(storage); value = storage.subarray(0, value.length); }
        if (plan.readMode === "invalid") value = [];
        offset = end; return { done: false, value };
      },
      async cancel() { events.readerCancels++; for (const resolve of blocked.splice(0)) resolve({ done: true, value: undefined }); },
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
    if (plan.fetchMode === "throw") throw Error("OWNED_FETCH_FAILURE");
    if (plan.fetchMode === "trusted") {
      let Original; try { validateGitHubImportRequest(null); } catch (error) { Original = error.constructor; }
      class Derived extends Original {}
      throw new Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE");
    }
    if (plan.fetchMode === "never") return new Promise(() => {});
    if (plan.fetchMode === "late") return new Promise(resolve => { late.push(() => resolve(response)); });
    return plan.responseMode === "null" ? null : response;
  };
  const now = () => {
    events.clocks++;
    if (spec.plan?.clockMode === "throw") throw Error("OWNED_CLOCK_FAILURE");
    return spec.retrievedAt;
  };
  const options = spec.options === null ? null : { ...spec.options,
    fetchImpl: spec.plan?.adapterMode === "invalid" ? false : fetchImpl,
    now: spec.plan?.clockMode === "invalid" ? false : now };
  return { options, events, async settle() {
    for (const resolve of late) resolve();
    await new Promise(resolve => setImmediate(resolve));
  } };
}

export async function nodeGitHubCase(entry) {
  const spec = JSON.parse(entry.inputText), before = JSON.stringify(spec);
  let original, result, acquisition;
  try {
    if (entry.operation === "make-request") result = githubImportRequest(spec);
    else if (entry.operation === "validate-request") { original = spec; result = validateGitHubImportRequest(spec); }
    else if (entry.operation === "validate-result") { original = spec.result; result = validateGitHubImportResult(spec.result, spec.request ?? null); }
    else if (entry.operation === "convert") result = await convertGitHubImportResponses(spec.request, capturedResponses(spec.responses), spec.retrievedAt, spec.limits);
    else if (entry.operation === "compare") result = compareGitHubImportSnapshots(spec);
    else if (entry.operation === "assess") result = assessGitHubReimport(spec);
    else if (entry.operation === "acquire") {
      acquisition = scriptedAcquisition(spec); result = await importGitHubFile(spec.request, acquisition.options); await acquisition.settle();
    } else throw Error("UNSUPPORTED_FIXTURE_OPERATION");
    assert.equal(JSON.stringify(spec), before);
    const outputText = JSON.stringify(result);
    return { accepted: true, outputText, outputSha256: sha(outputText), canonicalSha256: sha(canonicalJson(result)),
      sameInput: original === undefined ? null : original === result, events: acquisition?.events ?? null };
  } catch (error) {
    assert.equal(JSON.stringify(spec), before);
    return { accepted: false, code: error.code ?? error.name, path: error.path ?? null, events: acquisition?.events ?? null };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--stdio-worker") {
    const spec = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
    const { options } = scriptedAcquisition(spec);
    const result = await servePluginStdio({ handleRequest: request => importGitHubFile(request, options),
      validateRequest: validateGitHubImportRequest, validateResult: validateGitHubImportResult });
    process.exitCode = result.exitCode;
  } else {
    const bytes = await readFile(new URL("../packages/portable-core/fixtures/github-import-vectors.json", import.meta.url));
    const fixture = JSON.parse(bytes);
    test("pinned GitHub source functions reproduce every frozen conversion and acquisition outcome", async () => {
      assert.equal(sha(bytes), "e643181fd8018d306ee234a3262855edec3ee4727d67df113db83f9c403f684e");
      for (const [path, expected] of Object.entries(fixture.sources)) assert.equal(sha(await readFile(new URL("../" + path, import.meta.url))), expected, path);
      for (const entry of fixture.cases) assert.deepEqual(await nodeGitHubCase(entry), entry.expected, entry.id);
    });
    if (!process.argv.includes("--node-only")) {
      const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
      const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
      function runPython(args, { input, cwd = core, env = process.env, executable = python } = {}) {
        const child = spawnSync(executable, ["-B", ...args], { input, cwd, env, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
        assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
      }
      function verifyReplay(text) {
        const rows = JSON.parse(text); assert.equal(rows.length, 934);
        for (let index = 0; index < rows.length; index++) {
          assert.equal(rows[index].id, fixture.cases[index].id);
          assert.deepEqual(rows[index].outcome, fixture.cases[index].expected, rows[index].id);
        }
      }
      test("Python reproduces all frozen raw outputs and acquisition cleanup events", () => {
        assert.match(runPython(["-m", "unittest", "test_github_import"]).stderr, /Ran 6 tests/);
        verifyReplay(runPython(["test_github_import.py", "--replay"]).stdout);
      });
      test("only 44 public production modules and driver replay every case without Node or Git", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morivyx-github-isolated-"));
        try {
          const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
          const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
          assert.equal(modules.length, 44);
          for (const name of [...modules, "test_github_import.py"]) await cp(join(core, name), join(directory, name));
          await mkdir(join(directory, "fixtures"));
          await cp(join(core, "fixtures/github-import-vectors.json"), join(directory, "fixtures/github-import-vectors.json"));
          const executable = runPython(["-c", "import sys; print(sys.executable)"]).stdout.trim();
          verifyReplay(runPython(["test_github_import.py", "--replay", "--isolated"], { executable, cwd: directory,
            env: { PATH: "", PYTHONIOENCODING: "utf-8" } }).stdout);
        } finally { await rm(directory, { recursive: true, force: true }); }
      });
      test("actual Node and Python response children agree on framing, exit values and redaction", () => {
        const base = { request: fixture.request, responses: fixture.responses, retrievedAt: fixture.retrievedAt, options: fixture.options };
        const cases = [
          { spec: base, input: JSON.stringify(fixture.request) + "\n" },
          { spec: { ...base, options: {} }, input: JSON.stringify(fixture.request) },
          { spec: { ...base, plan: { fetchMode: "throw" } }, input: JSON.stringify(fixture.request) },
          { spec: { ...base, plan: { fetchMode: "never", at: 3 }, options: { ...base.options, limits: { timeoutMs: 2 } } }, input: JSON.stringify(fixture.request) },
          ...["{}", "{}\n{}", "{broken", JSON.stringify({ ...fixture.request, input: {} })].map(input => ({ spec: base, input })),
        ];
        for (const { spec, input } of cases) {
          const encoded = Buffer.from(JSON.stringify(spec)).toString("base64");
          const source = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--stdio-worker", encoded], { input, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
          const portable = spawnSync(python, ["-B", join(core, "test_github_import.py"), "--stdio-worker", encoded], { input, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
          assert.equal(source.error, undefined); assert.equal(portable.error, undefined);
          assert.ok([0, 2].includes(source.status));
          assert.deepEqual({ exit: portable.status, stdout: portable.stdout, stderr: portable.stderr },
            { exit: source.status, stdout: source.stdout, stderr: source.stderr }, input);
          assert.doesNotMatch(portable.stdout + portable.stderr, /PRIVATE_|owned-synthetic-test-token|OWNED_.*FAILURE/u);
        }
      });
      test("captured path byte boundaries preserve validation and capacity diagnostic precedence", async () => {
        const paths = ["/" + '"'.repeat(2046), "/" + '"'.repeat(2047), "/" + "x".repeat(4093), "/" + "x".repeat(4094),
          "/" + "e\u0301".repeat(1400), "/" + "é".repeat(1400), "/a b", "//double", "/a\\b", "/a\u0000b"];
        const entries = paths.map((path, index) => {
          const responses = structuredClone(fixture.responses); responses[0].path = path;
          return { id: `path-boundary-${index}`, operation: "convert", inputText: JSON.stringify({ request: fixture.request, responses, retrievedAt: fixture.retrievedAt }) };
        });
        const expected = [];
        for (const entry of entries) expected.push(await nodeGitHubCase(entry));
        const actual = JSON.parse(runPython(["test_github_import.py", "--probes"], { input: JSON.stringify(entries) }).stdout);
        assert.equal(actual.length, entries.length);
        for (let index = 0; index < entries.length; index++) assert.deepEqual(actual[index].outcome, expected[index], entries[index].id);
      });
      test("trusted inherited error data agrees without invoking diagnostic getters", async () => {
        let Original; try { validateGitHubImportRequest(null); } catch (error) { Original = error.constructor; }
        class Derived extends Original {}
        const guarded = new Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE");
        Object.setPrototypeOf(guarded, Object.create(Derived.prototype, { code: { get() { throw Error("GETTER_MUST_NOT_RUN"); } } }));
        const number = new Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"); number.code = 7;
        const surrogate = new Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"); surrogate.code = "\ud800";
        const expected = [];
        for (const error of [new Original("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), new Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), guarded, number, surrogate, Error("OWNED_PRIVATE_FAILURE")]) {
          const result = await importGitHubFile(fixture.request, { ...fixture.options, fetchImpl: () => { throw error; } });
          expected.push(result.failure.code);
        }
        assert.deepEqual(JSON.parse(runPython(["test_github_import.py", "--trusted-probes"]).stdout), expected);
      });
      test("null transport and clock select defaults while other null options remain invalid", async () => {
        const previous = globalThis.fetch, expected = [];
        try {
          for (const field of ["fetchImpl", "now"]) {
            const acquisition = scriptedAcquisition(fixture);
            globalThis.fetch = acquisition.options.fetchImpl;
            const result = await importGitHubFile(fixture.request, { ...acquisition.options, [field]: null });
            await acquisition.settle();
            assert.equal(result.status, "success");
            const timestampValid = validateGitHubImportResult(result, fixture.request) === result;
            if (field === "now") result.output.retrievedAt = "<runtime-clock>";
            expected.push({ field, timestampValid, result, events: acquisition.events });
          }
        } finally { globalThis.fetch = previous; }
        assert.deepEqual(JSON.parse(runPython(["test_github_import.py", "--default-probes"]).stdout), expected);
        for (const field of ["token", "limits", "permission"]) {
          const acquisition = scriptedAcquisition(fixture);
          const result = await importGitHubFile(fixture.request, { ...acquisition.options, [field]: null });
          assert.equal(result.status, "failure");
          assert.equal(result.failure.code, { token: "GITHUB_IMPORT_OPTIONS_INVALID", limits: "GITHUB_IMPORT_LIMITS_INVALID", permission: "GITHUB_IMPORT_PERMISSION_DENIED" }[field]);
        }
      });
    }
  }
}
