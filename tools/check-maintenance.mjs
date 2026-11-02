import { spawnSync } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeVersion } from "../packages/kernel/src/node-runtime.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: node tools/check-maintenance.mjs [--python <executable>]\n";

export class MaintenanceError extends Error {
  constructor(stage, message, exitCode = 1) {
    super(`${stage}: ${message}`);
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

export async function runMaintenance({ root = repository, python = "python3", execute = spawnSync,
  write = text => process.stdout.write(text), env = process.env } = {}) {
  assertSupportedNodeVersion();
  if (typeof python !== "string" || !python.trim()) throw new MaintenanceError("arguments", "Python executable is required", 2);
  async function testFiles(stage, directory, accepts) {
    let entries;
    try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
    catch { throw new MaintenanceError(stage, "Cannot enumerate test files"); }
    const files = entries.filter(entry => entry.isFile() && accepts(entry.name)).map(entry => entry.name).sort();
    if (files.length === 0) throw new MaintenanceError(stage, "No test files found");
    return files;
  }
  await testFiles("Core tests", "packages/kernel/test", name => name.endsWith(".test.js"));
  const tests = await testFiles("Tools tests", "tools", name => name.endsWith(".test.mjs"));
  await testFiles("Python tests", "packages/portable-core", name => name.startsWith("test_") && name.endsWith(".py"));
  const childEnv = { ...env, MORIVYX_REFERENCE_PYTHON: python,
    PATH: [dirname(process.execPath), env.PATH ?? ""].join(delimiter) };
  const stages = [
    ["Python runtime", python, ["--version"]],
    ["Core tests and audits", process.platform === "win32" ? "npm.cmd" : "npm", ["test", "--prefix", "packages/kernel"]],
    ["Tools tests", process.execPath, ["--test", ...tests.map(name => join(root, "tools", name))]],
    ["Python tests", python, ["-B", "-m", "unittest", "discover", "-s", "packages/portable-core", "-p", "test_*.py"]],
    ["Portable fixed vectors", python, ["-B", "tools/check-portable-vectors.py"]],
    ["Documentation", process.execPath, ["tools/check-documentation.mjs"]],
  ];
  for (let index = 0; index < stages.length; index++) {
    const [name, command, args] = stages[index];
    write(`[${index + 1}/${stages.length}] ${name}\n`);
    let result;
    try { result = await execute(command, args, { cwd: root, env: childEnv, stdio: "inherit", shell: false }); }
    catch { throw new MaintenanceError(name, "Could not start command"); }
    if (result?.error) throw new MaintenanceError(name, "Could not start command");
    if (result?.signal) throw new MaintenanceError(name, `Command stopped by ${result.signal}`);
    if (result?.status !== 0) {
      const code = Number.isInteger(result?.status) && result.status > 0 && result.status <= 255 ? result.status : 1;
      throw new MaintenanceError(name, `Command failed with exit ${code}`, code);
    }
  }
  write(`Maintenance checks passed: ${stages.length} stages.\n`);
  return { valid: true, stages: stages.length, python };
}

export async function main(args) {
  assertSupportedNodeVersion();
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(usage); return; }
  const python = args.length === 0 ? process.env.MORIVYX_REFERENCE_PYTHON ?? "python3"
    : args.length === 2 && args[0] === "--python" && !args[1].startsWith("--") ? args[1] : null;
  if (python === null) throw new MaintenanceError("arguments", usage.trim(), 2);
  await runMaintenance({ python });
}

// Resolve the entry path so invoking an explicit symlink cannot silently skip checks.
const entry = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
