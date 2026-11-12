import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { readReport, writeReport } from "../packages/kernel/src/report.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { compareUnicode } from "../packages/kernel/src/canonical.js";
import { fingerprint } from "./python-yaml-serialization-conformance.test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export function reportInput(spec, templates) {
  const value = structuredClone(Object.hasOwn(spec, "value") ? spec.value : templates[spec.template]);
  expandText(value, spec.expand);
  editReport(value, spec.edits ?? []);
  return value;
}
function expandText(value, expansion) {
  if (!expansion) return;
  editReport(value, [{ path: expansion.path, value: expansion.text.repeat(expansion.repeat) }]);
}
function editReport(value, edits) {
  for (const edit of edits) {
    let parent = value;
    for (const key of edit.path.slice(0, -1)) parent = parent[key];
    const key = edit.path.at(-1);
    if (edit.remove) delete parent[key];
    else Object.defineProperty(parent, key, { value: structuredClone(edit.value), enumerable: true, writable: true, configurable: true });
  }
}

// Each owned case is isolated from other cases, including process cwd, umask
// and temporary builtin instrumentation. The product modules stay unchanged.
let queue = Promise.resolve();
export function nodeReportCase(spec, templates) {
  const operation = queue.then(() => runCase(spec, templates));
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}
async function runCase(spec, templates) {
  const original = Object.fromEntries(Object.keys(fs.promises).map(key => [key, fs.promises[key]]));
  const previousCwd = process.cwd(), previousMask = process.umask();
  const directory = await original.realpath(await original.mkdtemp(join(tmpdir(), "morivyx-report-case-")));
  const temporary = [], opened = [], counts = (spec.faults ?? []).map(() => 0), fired = counts.slice();
  let escaped = false;
  const operations = ["lstat", "mkdir", "readdir", "readFile", "unlink", "link", "open"];
  const restore = () => { for (const name of operations) fs.promises[name] = original[name]; syncBuiltinESMExports(); };
  const safe = path => {
    const target = resolve(directory, path);
    assert.ok(target === directory || target.startsWith(directory + sep), "case escapes owned directory");
    return target;
  };
  const inputPath = safe(typeof spec.path === "string" && spec.path ? spec.path : "input.yaml");
  function location(path) {
    if (typeof path !== "string") return null;
    const absolute = resolve(path);
    if (absolute !== directory && !absolute.startsWith(directory + sep)) return null;
    const name = basename(absolute);
    if (/^\.report-[0-9]+-[0-9a-f-]+\.tmp$/.test(name)) return "temporary";
    if (/^\.record-id-.*\.lock$/.test(name)) return "lock";
    if (name === ".morivyx") return "metadata";
    if (name === "reports") return "reports";
    if (absolute === inputPath) return "input";
    if (name.endsWith(".yaml")) return "record";
    return "other";
  }
  function synthetic(rule, operation, path) {
    const error = new Error("controlled filesystem failure");
    error.code = rule.code ?? "EIO"; error.path = path; error.syscall = operation;
    return error;
  }
  function fault(operation, path) {
    const kind = location(path);
    if (kind === null) return null;
    for (const [index, rule] of (spec.faults ?? []).entries()) {
      if (rule.operation !== operation || (rule.target !== "any" && rule.target !== kind)) continue;
      counts[index]++;
      if (rule.nth !== undefined && rule.nth !== counts[index]) continue;
      fired[index]++;
      return rule;
    }
    return null;
  }
  function normalize(text) {
    if (typeof text !== "string") return text ?? null;
    let result = text.replaceAll(directory, "$ROOT");
    for (const [index, path] of temporary.entries()) result = result.replaceAll(path.slice(directory.length), dirname(path).slice(directory.length) + "/@temporary-" + index);
    return result;
  }
  function normalizeResult(value) {
    if (typeof value === "string") {
      const text = normalize(value), bytes = Buffer.from(text, "utf8");
      return bytes.length > 65536 ? { largeUtf8Bytes: bytes.length, sha256: sha(bytes) } : text;
    }
    if (Array.isArray(value)) return value.map(normalizeResult);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeResult(v)]));
    return value;
  }
  async function layout() {
    const rows = [];
    async function visit(path, relative) {
      const information = await original.lstat(path), mode = information.mode & 0o7777;
      const name = normalize(path).replace(/^\$ROOT\/?/, "");
      if (information.isSymbolicLink()) rows.push({ path: name, kind: "symlink", target: normalize(await original.readlink(path)), mode });
      else if (information.isDirectory()) {
        if (relative) rows.push({ path: name, kind: "directory", mode });
        for (const child of (await original.readdir(path)).sort(compareUnicode)) await visit(join(path, child), relative ? relative + "/" + child : child);
      } else {
        assert.ok(information.isFile(), "unexpected special file in owned layout");
        const bytes = await original.readFile(path);
        rows.push({ path: name, kind: "file", mode, nlink: information.nlink,
          ...(bytes.length > 65536 ? { byteLength: bytes.length, sha256: sha(bytes) } : { contentHex: bytes.toString("hex") }) });
      }
    }
    await visit(directory, "");
    return rows.sort((a, b) => compareUnicode(a.path, b.path));
  }
  try {
    process.umask(0o022);
    for (const entry of spec.entries ?? []) {
      const path = safe(entry.path);
      await original.mkdir(dirname(path), { recursive: true });
      if (entry.kind === "directory") { await original.mkdir(path, { recursive: true }); await original.chmod(path, entry.mode ?? 0o755); }
      else if (entry.kind === "symlink") {
        safe(resolve(dirname(path), entry.target));
        await original.symlink(entry.absolute ? safe(entry.target) : entry.target, path);
      }
      else if (entry.kind === "hardlink") await original.link(safe(entry.target), path);
      else {
        const record = structuredClone(entry.record ?? templates[entry.template]);
        expandText(record, entry.expand);
        const bytes = entry.contentHex !== undefined ? Buffer.from(entry.contentHex, "hex") :
          Buffer.from(entry.source !== undefined ? entry.source : serializeYamlRecord(record), "utf8");
        await original.writeFile(path, bytes); await original.chmod(path, entry.mode ?? 0o644);
      }
    }
    process.chdir(directory); process.umask(spec.umask ?? 0o022);
    const before = await layout(), value = reportInput(spec, templates);
    for (const operation of operations) {
      fs.promises[operation] = (...args) => {
        const path = typeof args[0] === "string" ? resolve(args[0]) : args[0];
        if ((typeof path === "string" && location(path) === null) ||
            (operation === "link" && typeof args[1] === "string" && location(resolve(args[1])) === null)) {
          escaped = true; throw new Error("case operation escapes owned root");
        }
        if (operation === "open" && location(path) === "temporary" && !temporary.includes(path)) temporary.push(path);
        const rule = fault(operation, path);
        if (rule?.action === "race-target") return original.writeFile(args[1], "foreign-race", { flag: "wx", mode: 0o644 }).then(() => original.link(...args));
        if (rule) throw synthetic(rule, operation, args[0]);
        const result = original[operation](...args);
        if (operation !== "open" || !(spec.faults ?? []).some(r => ["writeFile", "sync", "close"].includes(r.operation))) return result;
        return result.then(handle => {
          const close = handle.close.bind(handle); opened.push({ close });
          for (const method of ["writeFile", "sync", "close"]) {
            const call = handle[method].bind(handle);
            handle[method] = async (...values) => {
              const failure = fault(method, path);
              if (failure) { if (method === "close") await call(...values); throw synthetic(failure, method, path); }
              return call(...values);
            };
          }
          return handle;
        });
      };
    }
    syncBuiltinESMExports();
    const destination = spec.relative ? spec.path ?? "." : typeof spec.path === "string" ? safe(spec.path) : Object.hasOwn(spec, "path") ? spec.path : directory;
    let unchangedBeforeAwait, results;
    const capture = promise => Promise.resolve(promise).then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code ?? null, path: normalize(error.path) }));
    if (spec.operation === "read") {
      assert.notEqual(typeof destination, "number", "file-descriptor reads are outside this fixture vocabulary");
      unchangedBeforeAwait = fingerprint(value);
      results = await capture(readReport(destination));
    } else {
      const pending = Array.from({ length: spec.parallel ?? 1 }, () => capture(writeReport(destination, value)));
      editReport(value, spec.afterCallEdits ?? []);
      unchangedBeforeAwait = fingerprint(value);
      const completed = await Promise.all(pending);
      results = spec.parallel ? completed.map(normalizeResult).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) : completed[0];
    }
    assert.equal(escaped, false, "case attempted an operation outside its owned root");
    restore();
    return { result: normalizeResult(results), inputUnchanged: fingerprint(value) === unchangedBeforeAwait,
      before, after: await layout(), temporaryAttempts: temporary.length, faultCalls: counts, faultFired: fired };
  } finally {
    restore(); process.chdir(previousCwd); process.umask(previousMask);
    for (const handle of opened) await handle.close().catch(() => undefined);
    await original.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bytes = await readFile(join(root, "packages/portable-core/fixtures/report-file-api-vectors.json"));
  const frozen = JSON.parse(bytes), core = join(root, "packages/portable-core");
  const resolvePython = spawnSync(process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14", ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolvePython.status, 0, resolvePython.stderr);
  const python = resolvePython.stdout.trim(), env = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  function run(args, cwd = core) {
    const out = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 120000, maxBuffer: 24 * 1024 * 1024 });
    assert.equal(out.error, undefined); assert.equal(out.status, 0, out.stderr); return out;
  }
  test("the original file APIs reproduce the frozen results and owned file layouts", async () => {
    assert.equal(frozen.count, frozen.cases.length);
    for (const [path, expected] of Object.entries(frozen.reference.sources)) assert.equal(sha(await readFile(join(root, path))), expected, path);
    for (const entry of frozen.cases) assert.deepEqual(await nodeReportCase(entry.input, frozen.templates), entry.expected, entry.id);
  });
  test("independent Python replays report input, output, faults and call-time changes", () => {
    assert.match(run(["-m", "unittest", "test_report_file_api"]).stderr, /OK/);
    assert.deepEqual(JSON.parse(run(["test_report_file_api.py", "--replay"]).stdout), frozen.cases.map(entry => entry.expected));
  });
  test("47 public modules replay with Node and Git unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-report-hermetic-"));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_report_file_api.py"]) await writeFile(join(directory, name), await readFile(join(core, name)));
      await mkdir(join(directory, "fixtures")); await writeFile(join(directory, "fixtures/report-file-api-vectors.json"), bytes);
      for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
      const before = (await readdir(directory)).sort();
      assert.deepEqual(JSON.parse(run(["test_report_file_api.py", "--replay"], directory).stdout), frozen.cases.map(entry => entry.expected));
      assert.deepEqual((await readdir(directory)).sort(), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
