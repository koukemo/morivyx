import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function denyNetworkAccess() {
  const error = new Error("Network access is disabled by the test guard.");
  error.code = "MORIVYX_TEST_NETWORK_DENIED";
  throw error;
}

for (const [module, methods] of [
  [
    childProcess,
    [
      "exec",
      "execFile",
      "execFileSync",
      "execSync",
      "fork",
      "spawn",
      "spawnSync",
    ],
  ],
  [dgram, ["createSocket"]],
  [http, ["get", "request"]],
  [http2, ["connect"]],
  [https, ["get", "request"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
]) {
  for (const method of methods) {
    module[method] = denyNetworkAccess;
  }
}

net.Socket.prototype.connect = denyNetworkAccess;
for (const method of Object.keys(dns)) {
  if (/^(?:lookup|resolve|reverse)/.test(method)) {
    dns[method] = denyNetworkAccess;
  }
}
for (const method of Object.keys(dns.promises)) {
  if (/^(?:lookup|resolve|reverse)/.test(method)) {
    dns.promises[method] = denyNetworkAccess;
  }
}

globalThis.fetch = denyNetworkAccess;
if ("EventSource" in globalThis) {
  globalThis.EventSource = denyNetworkAccess;
}
if ("WebSocket" in globalThis) {
  globalThis.WebSocket = denyNetworkAccess;
}
syncBuiltinESMExports();
