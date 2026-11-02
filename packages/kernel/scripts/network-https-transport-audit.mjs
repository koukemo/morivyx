import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "morivyx-https-audit-"));
const client = fileURLToPath(new URL("../test-support/network-https-client.mjs", import.meta.url));
const modes = ["normal", "untrusted", "wrong-host", "redirect", "abort-body", "close-body", "truncated-body"];
const results = [];
let httpRequests = 0;

async function certificate(name, subjectAltName) {
  const key = join(root, `${name}.key`), cert = join(root, `${name}.crt`), config = join(root, `${name}.cnf`);
  await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=Local test fixture\n[extensions]\nsubjectAltName=${subjectAltName}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n`);
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-config", config, "-keyout", key, "-out", cert], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return { key: await readFile(key), cert: await readFile(cert), path: cert };
}

async function exercise(mode, identity) {
  const sockets = new Set(), requests = [];
  const server = createServer({ key: identity.key, cert: identity.cert }, (request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
      connection: request.headers.connection });
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("x-fixture", "owned-https");
    if (mode === "redirect") {
      response.writeHead(302, { location: "/unexpected-redirect-target" }); response.end("redirect fixture");
    } else if (mode === "abort-body" || mode === "close-body") {
      response.writeHead(200); response.write('{"unfinished":');
    } else if (mode === "truncated-body") {
      response.writeHead(200, { "content-length": "1000" }); response.end('{"unfinished":');
    } else {
      response.write('{"value":'); response.end('"日本語の本文"}');
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // Expected certificate rejections are verified through the client result and zero HTTP requests.
  server.on("tlsClientError", () => {});
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `https://127.0.0.1:${server.address().port}/fixture`;
    const env = { PATH: process.env.PATH, LANG: "C" };
    if (mode !== "untrusted") env.NODE_EXTRA_CA_CERTS = identity.path;
    const child = await execute(process.execPath, [client, url, mode], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(child.stdout), { mode, passed: true });
    assert.equal(child.stderr, "");
    assert.equal(requests.length, ["untrusted", "wrong-host"].includes(mode) ? 0 : 1);
    for (const request of requests) assert.deepEqual(request, { method: "GET", path: "/fixture",
      authorization: "Bearer SYNTHETIC_HTTPS_FIXTURE", connection: "close" });
    // Let the server observe peer closure; do not forcibly close it before this assertion.
    const deadline = Date.now() + 2000;
    while (sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.size, 0, `${mode}: peer connection remained open`);
    httpRequests += requests.length;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  results.push(mode);
}

try {
  const matching = await certificate("matching", "IP:127.0.0.1");
  const wrong = await certificate("wrong", "DNS:wrong.example.test");
  for (const mode of modes) await exercise(mode, mode === "wrong-host" ? wrong : matching);
} finally {
  await rm(root, { recursive: true, force: true });
}
await assert.rejects(stat(root), { code: "ENOENT" });
console.log(JSON.stringify({ audit: "network-https-transport", passed: true, checks: results, httpRequests,
  defaultTransport: true, realServices: "not-tested", realCredentials: "not-used", temporaryFilesRemoved: true }));
