import { readFile, writeFile, access } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "linger") {
  spawn(process.execPath, [import.meta.filename, "descendant"], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "output") {
  spawn(process.execPath, [import.meta.filename, "descendant"], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 1500));
  while (process.stdout.write("x".repeat(4096))) {}
  process.stdout.on("drain", () => { while (process.stdout.write("x".repeat(4096))) {} });
} else {
  let text = "";
  for await (const bytes of process.stdin) { text += bytes.toString(); if (text.length > 1048576) process.exit(2); }
  const request = JSON.parse(text);
  const denied = async operation => { try { await operation(); return false; } catch { return true; } };
  const networkDenied = await new Promise(resolve => {
    const socket = connect({ host: request.input.hostAddress, port: request.input.hostPort });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  });
  const output = {
    inputReadable: (await readFile("/input/network-input.json", "utf8")).length > 0,
    inputWriteDenied: await denied(() => writeFile("/input/network-input.json", "changed")),
    rootWriteDenied: await denied(() => writeFile("/root-write-test", "changed")),
    hostFileHidden: await denied(() => readFile(request.input.hostPath)),
    hostSocketHidden: await denied(() => access("/var/run/docker.sock")),
    credentialHidden: process.env.MORIVYX_NETWORK_AUDIT_CREDENTIAL === undefined,
    networkDenied, interfaces: Object.keys(networkInterfaces()).sort(), uid: process.getuid(), gid: process.getgid(),
  };
  console.log(JSON.stringify({ format: "morivyx.plugin-run-result/0.1", runId: request.runId,
    plugin: request.plugin, capabilityId: request.capability.id, status: "success", output }));
}
