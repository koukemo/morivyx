import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { servePluginStdio, PLUGIN_STDIO_DEFAULT_BYTES } from "../src/plugin-stdio.js";
import { runPluginProcess, validatePluginRunResult } from "../src/plugin-communication.js";

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const request = await load("../test/fixtures/plugin-communication/request.json");
const result = await load("../test/fixtures/plugin-communication/result.json");
const invalid = await load("../test/fixtures/plugin-communication/stdio-invalid.json");
const contract = await load("../../../contracts/plugin-communication@0.1.schema.json");
const text = `${JSON.stringify(request)}\n`;
function sink() {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}
async function exchange(input = text, options = {}, streams = {}) {
  const stdout = sink(); const stderr = sink(); let calls = 0;
  const status = await servePluginStdio({ handleRequest: () => { calls++; return structuredClone(result); }, ...options }, {
    stdin: Readable.from([input]), stdout: stdout.stream, stderr: stderr.stream, ...streams,
  });
  return { status, stdout: stdout.text(), stderr: stderr.text(), calls };
}
function failure(value, code) {
  assert.deepEqual(value.status, { valid: false, exitCode: 2, code });
  assert.equal(value.stdout, ""); assert.equal(value.stderr, `${code}\n`);
  assert.equal(value.stderr.includes("INPUT_SENTINEL"), false);
}
let checks = 0;
async function check(name, operation) {
  try { await operation(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
await check("fixed logical contract and one JSON result", async () => {
  assert.equal(contract.$defs.RunRequest.properties.format.const, request.format);
  const value = await exchange(); assert.deepEqual(value.status, { valid: true, exitCode: 0 });
  assert.deepEqual(JSON.parse(value.stdout), result); assert.equal(value.stderr, ""); assert.equal(value.calls, 1);
  assert.equal(value.stdout.split("\n").length, 2);
  const lost = { ...result, status: "failure", failure: { code: "KNOWN_FAILURE", message: "bounded domain result" } };
  delete lost.output;
  const failed = await exchange(text, { handleRequest: () => lost });
  assert.deepEqual(JSON.parse(failed.stdout), lost); assert.equal(failed.status.valid, true);
});
await check("fixed invalid framing and logical input do not reach handler", async () => {
  for (const item of invalid) { const value = await exchange(item.input); failure(value, item.code); assert.equal(value.calls, 0); }
  failure(await exchange(Buffer.from([0xc3, 0x28])), "PLUGIN_STDIO_INPUT_INVALID");
  failure(await exchange(Buffer.from([0xe3, 0x81])), "PLUGIN_STDIO_INPUT_INVALID");
  failure(await exchange("{}\r{}"), "PLUGIN_STDIO_INPUT_INVALID");
});
await check("input byte bounds stop reading and close the stream", async () => {
  let read = 0; let closed = false;
  async function* chunks() { try { read++; yield Buffer.alloc(20); read++; yield Buffer.alloc(20); } finally { closed = true; } }
  const value = await exchange(text, { maxInputBytes: 10 }, { stdin: Readable.from(chunks(), { highWaterMark: 0 }) });
  failure(value, "PLUGIN_STDIO_INPUT_LIMIT"); assert.equal(value.calls, 0); assert.equal(read, 1); assert.equal(closed, true);
  const exact = await exchange(text, { maxInputBytes: Buffer.byteLength(text) }); assert.equal(exact.status.valid, true);
  failure(await exchange(text, { maxInputBytes: Buffer.byteLength(text) - 1 }), "PLUGIN_STDIO_INPUT_LIMIT");
  failure(await exchange("x".repeat(PLUGIN_STDIO_DEFAULT_BYTES + 1)), "PLUGIN_STDIO_INPUT_LIMIT");
  const unicode = { ...request, runId: "run:日本語" }; const output = { ...result, runId: unicode.runId };
  const bytes = Buffer.from(JSON.stringify(unicode));
  const split = await exchange(text, { handleRequest: () => output }, { stdin: Readable.from([...bytes].map(x => Buffer.from([x]))) });
  assert.deepEqual(JSON.parse(split.stdout), output);
});
await check("output byte bounds include newline and prevent partial protocol output", async () => {
  const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
  assert.equal((await exchange(text, { maxOutputBytes: bytes })).status.valid, true);
  failure(await exchange(text, { maxOutputBytes: bytes - 1 }), "PLUGIN_STDIO_OUTPUT_LIMIT");
  failure(await exchange(text, { handleRequest: () => ({ ...result, output: { text: "x".repeat(PLUGIN_STDIO_DEFAULT_BYTES) } }) }), "PLUGIN_STDIO_OUTPUT_LIMIT");
});
await check("validation callbacks cannot bypass generic contracts", async () => {
  failure(await exchange("{}", { validateRequest() {} }), "PLUGIN_STDIO_REQUEST_INVALID");
  failure(await exchange(text, { validateRequest() { return false; } }), "PLUGIN_STDIO_REQUEST_INVALID");
  failure(await exchange(text, { validateRequest() { throw Error("INPUT_SENTINEL"); } }), "PLUGIN_STDIO_REQUEST_INVALID");
  failure(await exchange(text, { handleRequest: () => ({}), validateResult() {} }), "PLUGIN_STDIO_RESULT_INVALID");
  failure(await exchange(text, { validateResult() { return false; } }), "PLUGIN_STDIO_RESULT_INVALID");
  failure(await exchange(text, { validateResult() { throw Error("INPUT_SENTINEL"); } }), "PLUGIN_STDIO_RESULT_INVALID");
});
await check("handler and validators cannot mutate the identity used for result matching", async () => {
  failure(await exchange(text, { handleRequest(value) {
    value.runId = "changed"; return { ...result, runId: value.runId };
  } }), "PLUGIN_STDIO_RESULT_INVALID");
  const value = await exchange(text, { validateRequest(value) { value.runId = "changed"; },
    handleRequest(value) { assert.equal(value.runId, request.runId); return result; },
    async validateResult(value, input) { value.runId = "changed"; input.runId = "changed"; await Promise.resolve(); } });
  assert.deepEqual(JSON.parse(value.stdout), result);
  const mutable = structuredClone(result);
  const snapshot = await exchange(text, { handleRequest: () => mutable, async validateResult() { mutable.runId = "changed"; } });
  assert.equal(JSON.parse(snapshot.stdout).runId, request.runId);
});
await check("handler exceptions and unsafe result objects do not disclose values", async () => {
  failure(await exchange(text, { handleRequest() { throw Error("INPUT_SENTINEL /private/path"); } }), "PLUGIN_STDIO_HANDLER_FAILED");
  const cyclic = structuredClone(result); cyclic.output.self = cyclic;
  failure(await exchange(text, { handleRequest: () => cyclic }), "PLUGIN_STDIO_RESULT_INVALID");
  let reads = 0; const getter = { ...result }; Object.defineProperty(getter, "output", { enumerable: true, get() { reads++; throw Error("INPUT_SENTINEL"); } });
  failure(await exchange(text, { handleRequest: () => getter }), "PLUGIN_STDIO_RESULT_INVALID"); assert.equal(reads, 0);
});
await check("read errors and unsupported chunks return fixed diagnostics", async () => {
  const broken = new Readable({ read() { this.destroy(Error("INPUT_SENTINEL")); } });
  failure(await exchange(text, {}, { stdin: broken }), "PLUGIN_STDIO_READ_FAILED");
  failure(await exchange(text, {}, { stdin: Readable.from([123]) }), "PLUGIN_STDIO_INPUT_INVALID");
  const bytes = new Uint8Array(Buffer.from(text));
  assert.equal((await exchange(text, {}, { stdin: Readable.from([bytes]) })).status.valid, true);
});
await check("write failures are awaited and diagnosed without raw details", async () => {
  for (const stream of [new Writable({ write(chunk, encoding, callback) { callback(Error("INPUT_SENTINEL")); } }),
    new Writable({ write() { throw Error("INPUT_SENTINEL"); } }),
    new Writable({ write() { this.destroy(); } })]) {
    failure(await exchange(text, {}, { stdout: stream }), "PLUGIN_STDIO_WRITE_FAILED");
  }
  const ended = sink(); ended.stream.end();
  failure(await exchange(text, {}, { stdout: ended.stream }), "PLUGIN_STDIO_WRITE_FAILED");
  const brokenDiagnostic = new Writable({ write(chunk, encoding, callback) { callback(Error("INPUT_SENTINEL")); } });
  const value = await exchange("bad", {}, { stderr: brokenDiagnostic });
  assert.equal(value.status.code, "PLUGIN_STDIO_INPUT_INVALID"); assert.equal(value.stdout, "");
});
await check("invalid options are rejected before input or processing", async () => {
  for (const key of ["maxInputBytes", "maxOutputBytes"]) {
    for (const value of [0, -1, 1.2, Infinity, "10", 16777217]) failure(await exchange(text, { [key]: value }), "PLUGIN_STDIO_CONFIG_INVALID");
  }
  for (const key of ["handleRequest", "validateRequest", "validateResult"]) failure(await exchange(text, { [key]: null }), "PLUGIN_STDIO_CONFIG_INVALID");
  failure(await exchange(text, {}, { stdin: {} }), "PLUGIN_STDIO_CONFIG_INVALID");
  assert.equal((await servePluginStdio(null, null)).code, "PLUGIN_STDIO_CONFIG_INVALID");
});
await check("real repository entrypoint preserves results and sanitizes malformed input", async () => {
  const script = fileURLToPath(new URL("../src/repository-importer-stdio.js", import.meta.url));
  const input = structuredClone(request); input.input.repositoryRoot = fileURLToPath(new URL("../test/fixtures/plugin-communication/repository", import.meta.url));
  const execute = input => spawnSync(process.execPath, [script], { input, encoding: "utf8", timeout: 5000, maxBuffer: 2 * PLUGIN_STDIO_DEFAULT_BYTES, env: {} });
  for (const missing of [false, true]) {
    if (missing) input.input.locator = "not-present.txt";
    const execution = execute(JSON.stringify(input)); assert.equal(execution.status, 0); assert.equal(execution.stderr, "");
    const value = JSON.parse(execution.stdout); validatePluginRunResult(value, input);
    assert.equal(value.status, missing ? "failure" : "success");
  }
  for (const [input, code] of [["{\"INPUT_SENTINEL\": bad}", "PLUGIN_STDIO_INPUT_INVALID"],
    ["x".repeat(PLUGIN_STDIO_DEFAULT_BYTES + 1), "PLUGIN_STDIO_INPUT_LIMIT"], [Buffer.from([0xff]), "PLUGIN_STDIO_INPUT_INVALID"]]) {
    const value = execute(input); assert.equal(value.status, 2); assert.equal(value.stdout, ""); assert.equal(value.stderr, `${code}\n`);
  }
});
await check("independent Python Plugin uses the same host contract", async () => {
  const found = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 5000 });
  assert.equal(found.status, 0, "Python 3 is required for cross-language contract verification");
  const manifest = await load("../test/fixtures/plugin-manifest/repository-importer.json");
  const policy = await load("../test/fixtures/plugin-manifest/host-policy.json");
  const output = runPluginProcess({ command: found.stdout.trim(), args: ["-B", fileURLToPath(new URL("../test/fixtures/plugin-communication/fixed-response.py", import.meta.url))],
    manifest, policy, request });
  assert.deepEqual(output, result);
});
assert.equal(checks, 12);
console.log(`Plugin stdio audit passed: ${checks} checks; bounded framing and independent Python contract verified.`);
