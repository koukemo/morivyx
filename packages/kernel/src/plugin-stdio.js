import { Readable, Writable } from "node:stream";
import { validatePluginRunRequest, validatePluginRunResult } from "./plugin-communication.js";

export const PLUGIN_STDIO_DEFAULT_BYTES = 1048576;
const MAX_BYTES = 16 * PLUGIN_STDIO_DEFAULT_BYTES;
const noop = () => {};

function write(stream, text) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) { reject(new Error()); return; }
    let settled = false;
    const closed = () => finish(new Error());
    const finish = error => {
      if (settled) return;
      settled = true;
      // Node may emit error after invoking the write callback with that error.
      setImmediate(() => {
        stream.off("error", finish); stream.off("close", closed);
        if (error) reject(error); else resolve();
      });
    };
    stream.once("error", finish); stream.once("close", closed);
    try { stream.write(text, finish); } catch (error) { finish(error); }
  });
}

// Framing and validation only: the host remains responsible for permissions and isolation.
export async function servePluginStdio(options, streams = {}) {
  let code = "PLUGIN_STDIO_CONFIG_INVALID";
  let stderr;
  try {
    const { stdin = process.stdin, stdout = process.stdout, stderr: diagnostic = process.stderr } = streams;
    stderr = diagnostic;
    const { handleRequest, validateRequest = noop, validateResult = noop,
      maxInputBytes = PLUGIN_STDIO_DEFAULT_BYTES, maxOutputBytes = PLUGIN_STDIO_DEFAULT_BYTES } = options;
    if (typeof handleRequest !== "function" || typeof validateRequest !== "function" || typeof validateResult !== "function" ||
      ![maxInputBytes, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_BYTES) ||
      !(stdin instanceof Readable) || !(stdout instanceof Writable) || !(stderr instanceof Writable)) throw new Error();
    code = "PLUGIN_STDIO_READ_FAILED";
    const chunks = []; let bytes = 0;
    for await (const chunk of stdin) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        code = "PLUGIN_STDIO_INPUT_INVALID"; throw new Error();
      }
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (bytes > maxInputBytes) { code = "PLUGIN_STDIO_INPUT_LIMIT"; throw new Error(); }
      chunks.push(Buffer.from(chunk));
    }
    code = "PLUGIN_STDIO_INPUT_INVALID";
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
    if (text.length === 0 || /[\r\n]/u.test(text)) throw new Error();
    const request = JSON.parse(text);
    code = "PLUGIN_STDIO_REQUEST_INVALID";
    validatePluginRunRequest(request);
    if (await validateRequest(structuredClone(request)) === false) throw new Error();
    code = "PLUGIN_STDIO_HANDLER_FAILED";
    const result = await handleRequest(structuredClone(request));
    code = "PLUGIN_STDIO_RESULT_INVALID";
    validatePluginRunResult(result, request);
    const snapshot = structuredClone(result);
    if (await validateResult(structuredClone(snapshot), structuredClone(request)) === false) throw new Error();
    const output = `${JSON.stringify(snapshot)}\n`;
    code = "PLUGIN_STDIO_OUTPUT_LIMIT";
    if (Buffer.byteLength(output) > maxOutputBytes) throw new Error();
    code = "PLUGIN_STDIO_WRITE_FAILED";
    await write(stdout, output);
    return { valid: true, exitCode: 0 };
  } catch {
    try { if (stderr instanceof Writable) await write(stderr, `${code}\n`); } catch { /* No raw diagnostic fallback. */ }
    return { valid: false, exitCode: 2, code };
  }
}
