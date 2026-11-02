import assert from "node:assert/strict";
import { createServer, request as requestHttp } from "node:http";
import { once } from "node:events";
import { createNetworkImportTransport } from "../src/network-import-transport.js";
import { FIXTURE_TOKEN } from "./network-import-fixtures.mjs";

// Each synthetic HTTP request owns its connection. Do not reuse a pooled socket after a prior abort.
export async function createNetworkFixtureServer({ host = "127.0.0.1" } = {}) {
  assert.ok(["127.0.0.1", "0.0.0.0"].includes(host));
  const state = { fixture: null, stall: false, status: 200, onRequest: null, requests: 0, rejected: 0 };
  const sockets = new Set();
  const server = createServer((request, response) => {
    state.requests++; state.onRequest?.();
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}` || !state.fixture?.documents.has(request.url)) {
      state.rejected++; response.writeHead(403, { connection: "close" }); response.end(); return;
    }
    if (state.stall) return;
    const headers = { "content-type": "application/json", connection: "close" };
    if (state.status !== 200) {
      response.writeHead(state.status, { ...headers, location: "http://127.0.0.1/forbidden" });
      response.end(JSON.stringify({ message: "PRIVATE_PROVIDER_RESPONSE" })); return;
    }
    response.writeHead(200, headers); response.end(JSON.stringify(state.fixture.documents.get(request.url)));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, host); await once(server, "listening");
  const port = server.address().port;
  const transport = createNetworkImportTransport(requestHttp);
  const fetchImpl = async (url, settings) => {
    const origin = `https://api.${state.fixture.provider}.com`;
    assert.ok(url.startsWith(`${origin}/`));
    const response = await transport.fetchImpl(`http://127.0.0.1:${port}${url.slice(origin.length)}`, settings);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  const waitForIdle = async () => {
    const end = Date.now() + 2000;
    while (sockets.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.size, 0, "synthetic acquisition still owns an open HTTP connection");
  };
  const close = async () => {
    await transport.close();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); for (const socket of sockets) socket.destroy(); await closed;
    assert.equal(server.listening, false);
  };
  return { state, server, port, fetchImpl, waitForIdle, close };
}
