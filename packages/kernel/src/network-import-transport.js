import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import { networkImportError } from "./network-import-input.js";

// Internal trusted-host transport. Each invocation owns its sockets; no shared fetch pool or retries.
// requestImpl is injected only by the local HTTP integration fixture, never by Plugin JSON.
export function createNetworkImportTransport(requestImpl = requestHttps) {
  const pending = new Map(); let closed = false;
  const fetchImpl = async (url, settings) => {
    if (closed || settings.signal?.aborted) throw networkImportError("CANCELLED");
    if (settings.method !== "GET" || settings.redirect !== "manual") throw networkImportError("OPERATION_DENIED");
    const headers = new Headers(settings.headers); headers.set("Connection", "close");
    return new Promise((resolve, reject) => {
      let operation;
      try {
        operation = requestImpl(url, { method: settings.method, headers: Object.fromEntries(headers),
          agent: false, signal: settings.signal }, incoming => {
          try {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
              else if (value !== undefined) responseHeaders.set(key, value);
            }
            const noBody = [204, 205, 304].includes(incoming.statusCode);
            const response = new Response(noBody ? null : Readable.toWeb(incoming),
              { status: incoming.statusCode, headers: responseHeaders });
            Object.defineProperty(response, "url", { value: url });
            if (noBody) incoming.resume();
            resolve(response);
          } catch (error) { incoming.destroy(); reject(error); }
        });
      } catch (error) { reject(error); return; }
      let finished;
      pending.set(operation, new Promise(resolveClose => { finished = resolveClose; }));
      operation.on("error", reject);
      operation.once("upgrade", (_response, socket) => { socket.destroy(); operation.destroy(); reject(networkImportError("RESPONSE_INVALID")); });
      operation.once("close", () => { pending.delete(operation); finished(); });
      operation.end();
    });
  };
  const close = async () => {
    closed = true;
    const completions = [...pending.values()];
    for (const operation of pending.keys()) operation.destroy();
    let timer;
    try {
      await Promise.race([Promise.all(completions), new Promise((_, reject) => {
        timer = setTimeout(() => reject(networkImportError("NETWORK_CLEANUP_FAILED")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return { fetchImpl, close };
}
