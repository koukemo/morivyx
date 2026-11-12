import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { inspectPackage } from "../packages/kernel/src/package-reader.js";
import { rebuildPackageIndex } from "../packages/kernel/src/graph-index.js";
import { diffPackages } from "../packages/kernel/src/semantic-diff.js";
import { compareUnicode } from "../packages/kernel/src/canonical.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export function packageSource(source) {
  if (typeof source === "string") return Buffer.from(source);
  if (source.hex !== undefined) return Buffer.from(source.hex, "hex");
  if (source.extensionDepth) {
    const { prefix, depth } = source.extensionDepth;
    assert.ok(Number.isInteger(depth) && depth >= 0 && depth <= 4096);
    let text = prefix + "extensions:\n  example.test/deep:\n";
    for (let i = 0; i < depth; i++) text += " ".repeat(4 + i * 2) + "probe:\n";
    return Buffer.from(text + " ".repeat(4 + depth * 2) + 'leaf: "value"\n');
  }
  if (source.repeat) {
    const r = source.repeat;
    return Buffer.from(r.prefix + r.text.repeat(r.count) + r.suffix);
  }
  throw new Error("unknown source recipe");
}

// JSON-visible data retains timestamp spelling and sequence order. It does not
// claim JavaScript descriptor or alias-identity equivalence.
export function logicalNodes(value) {
  const pending = [JSON.parse(JSON.stringify(value))], nodes = [];
  function token(item) {
    if (item === null) return ["null"];
    if (typeof item === "string") {
      const b = Buffer.from(item);
      return ["string", b.length > 65536 ? { byteLength: b.length, sha256: sha(b) } : item];
    }
    if (typeof item === "number" || typeof item === "boolean") return [typeof item, item];
    assert.ok(item && typeof item === "object");
    const index = pending.length; pending.push(item); return ["ref", index];
  }
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    if (item === null || typeof item !== "object") {
      assert.equal(index, 0); nodes.push({ kind: "scalar", value: token(item) }); continue;
    }
    nodes.push(Array.isArray(item) ? { kind: "sequence", entries: item.map(token) } :
      { kind: "mapping", entries: Object.keys(item).sort(compareUnicode).map(key => [key, token(item[key])]) });
  }
  return { root: ["ref", 0], nodes };
}

let casesQueue = Promise.resolve();
export function nodePackageCase(spec, templates) {
  const promise = casesQueue.then(() => ownedCase(spec, templates));
  casesQueue = promise.then(() => undefined, () => undefined); return promise;
}
async function ownedCase(spec, templates) {
  assert.ok(spec.schedule === undefined || spec.schedule === "serial-io", "unknown fixture schedule");
  const original = Object.fromEntries(Object.keys(fs.promises).map(key => [key, fs.promises[key]]));
  const cwd = process.cwd(), mask = process.umask();
  const directory = await original.realpath(await original.mkdtemp(join(tmpdir(), "morivyx-package-file-case-")));
  const operations = ["lstat", "readdir", "readFile"], trace = [], pending = new Set();
  const faultCalls = (spec.faults ?? []).map(() => 0), faultFired = faultCalls.slice();
  let escaped = false, serial = Promise.resolve(), phase = "setup";
  const safe = path => {
    const target = resolve(directory, path);
    assert.ok(target === directory || target.startsWith(directory + sep), "setup escapes owned root");
    return target;
  };
  const normalize = value => typeof value === "string" &&
    (value === directory || value.startsWith(directory + sep)) ? "$ROOT" + value.slice(directory.length) : value ?? null;
  const restore = () => { for (const op of operations) fs.promises[op] = original[op]; syncBuiltinESMExports(); };
  async function layout() {
    const rows = [], rootBytes = Buffer.from(directory);
    async function visit(path, relative) {
      const stat = await original.lstat(path), common = { path: relative.toString("utf8"), pathHex: relative.toString("hex"), mode: stat.mode & 0o7777 };
      if (stat.isSymbolicLink()) {
        let target = await original.readlink(path, { encoding: "buffer" });
        if (target.subarray(0, rootBytes.length).equals(rootBytes) &&
            (target.length === rootBytes.length || target[rootBytes.length] === 47))
          target = Buffer.concat([Buffer.from("$ROOT"), target.subarray(rootBytes.length)]);
        rows.push({ ...common, kind: "symlink", targetHex: target.toString("hex") });
      } else if (stat.isDirectory()) {
        rows.push({ ...common, kind: "directory" });
        const entries = await original.readdir(path, { encoding: "buffer", withFileTypes: true });
        entries.sort((a, b) => Buffer.compare(a.name, b.name));
        for (const entry of entries) {
          const rel = relative.length ? Buffer.concat([relative, Buffer.from("/"), entry.name]) : entry.name;
          await visit(Buffer.concat([path, Buffer.from("/"), entry.name]), rel);
        }
      } else {
        assert.ok(stat.isFile(), "unexpected special file in owned fixture");
        const bytes = await original.readFile(path);
        rows.push({ ...common, kind: "file", nlink: stat.nlink, byteLength: bytes.length, sha256: sha(bytes) });
      }
    }
    await visit(rootBytes, Buffer.alloc(0));
    if (rows.length <= 256) return rows;
    const encoded = Buffer.from(JSON.stringify(rows));
    return { entries: rows.length, byteLength: encoded.length, sha256: sha(encoded) };
  }
  try {
    process.umask(0o022);
    for (const [directoryName, name] of Object.entries(spec.setup?.packages ?? {})) {
      assert.ok(Object.hasOwn(templates, name));
      await original.mkdir(safe(directoryName), { recursive: true });
      for (const [path, source] of Object.entries(templates[name])) {
        const target = safe(join(directoryName, path));
        await original.mkdir(dirname(target), { recursive: true }); await original.writeFile(target, packageSource(source));
      }
    }
    for (const path of spec.setup?.remove ?? []) await original.rm(safe(path), { recursive: true, force: true });
    for (const move of spec.setup?.move ?? []) {
      await original.mkdir(dirname(safe(move.to)), { recursive: true }); await original.rename(safe(move.from), safe(move.to));
    }
    for (const item of spec.setup?.directories ?? []) {
      const path = safe(typeof item === "string" ? item : item.path);
      await original.mkdir(path, { recursive: true }); await original.chmod(path, item.mode ?? 0o755);
    }
    for (const entry of spec.setup?.put ?? []) {
      const path = safe(entry.path); await original.mkdir(dirname(path), { recursive: true });
      await original.writeFile(path, packageSource(entry.source)); await original.chmod(path, entry.mode ?? 0o644);
    }
    for (const group of spec.setup?.many ?? []) {
      await original.mkdir(safe(group.directory), { recursive: true });
      for (let i = 0; i < group.count; i++) await original.writeFile(safe(join(group.directory, group.prefix + i + group.suffix)), packageSource(group.source));
    }
    for (const entry of spec.setup?.rawFiles ?? []) {
      const name = Buffer.from(entry.nameHex, "hex");
      assert.ok(name.length && !name.includes(0) && !name.includes(47) && ![".", ".."].includes(name.toString()));
      await original.mkdir(safe(entry.parent), { recursive: true });
      await original.writeFile(Buffer.concat([Buffer.from(safe(entry.parent) + "/"), name]), packageSource(entry.source));
    }
    for (const link of spec.setup?.links ?? []) {
      const path = safe(link.path); await original.mkdir(dirname(path), { recursive: true });
      if (link.kind === "hardlink") await original.link(safe(link.target), path);
      else {
        safe(link.absolute ? link.target : resolve(dirname(path), link.target));
        await original.symlink(link.absolute ? safe(link.target) : link.target, path);
      }
    }
    process.chdir(directory); process.umask(spec.umask ?? 0o022);
    phase = "layout-before";
    const before = await layout();
    phase = "api";
    for (const operation of operations) fs.promises[operation] = (...args) => {
      if (typeof args[0] === "string" && !args[0].includes("\0")) {
        const path = resolve(args[0]);
        if (path !== directory && !path.startsWith(directory + sep)) escaped = true;
        trace.push([operation, normalize(args[0])]);
      }
      const task = async () => {
        assert.equal(escaped, false, "operation escapes owned root");
        for (const [i, rule] of (spec.faults ?? []).entries()) {
          if (typeof args[0] !== "string" || args[0].includes("\0")) continue;
          if (rule.operation !== operation || (rule.path !== undefined && normalize(args[0]) !== "$ROOT/" + rule.path)) continue;
          faultCalls[i]++;
          if (rule.nth !== undefined && rule.nth !== faultCalls[i]) continue;
          faultFired[i]++;
          const error = new Error("controlled filesystem failure"); error.code = rule.code; error.path = args[0]; throw error;
        }
        return original[operation](...args);
      };
      const work = spec.schedule === "serial-io" ? serial.then(task) : task();
      if (spec.schedule === "serial-io") serial = work.catch(() => undefined);
      let tracked;
      tracked = work.then(value => { pending.delete(tracked); return value; }, error => { pending.delete(tracked); throw error; });
      pending.add(tracked); return tracked;
    };
    syncBuiltinESMExports();
    const pathCount = spec.method === "diff" ? 2 : 1;
    const args = (spec.args ?? []).map((value, i) => i < pathCount && value && typeof value === "object" && Object.hasOwn(value, "$root") ? safe(value.$root) : structuredClone(value));
    const snapshotArgs = () => logicalNodes(args.map((value, i) => i < pathCount && typeof value === "string" ? normalize(value) : value));
    const argsBefore = snapshotArgs();
    const methods = { inspect: inspectPackage, index: rebuildPackageIndex, diff: diffPackages };
    assert.ok(Object.hasOwn(methods, spec.method));
    let result, value, completed = false;
    try {
      value = await methods[spec.method](...args); completed = true;
    } catch (error) { result = { ok: false, code: error.code ?? error.name, path: normalize(error.path) }; }
    if (completed) result = { ok: true, logical: logicalNodes(value) };
    // Promise.all may reject while sibling read-only branches are still running.
    phase = "drain";
    let quiet = 0;
    for (let i = 0; i < 100 && quiet < 3; i++) {
      if (pending.size) { quiet = 0; await Promise.allSettled([...pending]); }
      await nextTurn(); quiet = pending.size ? 0 : quiet + 1;
    }
    assert.equal(pending.size, 0, "fixture did not drain"); assert.equal(escaped, false);
    restore(); phase = "layout-after";
    return { result, before, after: await layout(), trace, faultCalls, faultFired, argsBefore, argsAfter: snapshotArgs() };
  } catch (error) {
    error.referencePhase = phase; error.referenceDirectory = directory; throw error;
  } finally {
    restore(); process.chdir(cwd); process.umask(mask);
    await original.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixturePath = join(root, "packages/portable-core/fixtures/package-file-api-vectors.json");
  const bytes = await readFile(fixturePath), frozen = JSON.parse(bytes), core = join(root, "packages/portable-core");
  const executable = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  const resolved = spawnSync(executable, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const python = resolved.stdout.trim(), env = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  function run(args, cwd = core) {
    const p = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(p.error, undefined); assert.equal(p.status, 0, p.stderr); return p;
  }
  test("original package file APIs replay the frozen results and unchanged layouts", async () => {
    assert.equal(frozen.reference.stage, "frozen-original");
    assert.equal(frozen.reference.ioSchedule, "serial-io");
    assert.equal(frozen.requestedCount, 1069);
    assert.equal(frozen.count, 1063);
    assert.equal(frozen.unavailableFixtures.length, 6);
    assert.equal(frozen.count, frozen.cases.length);
    assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), frozen.reference.normalizationHarnessSha256);
    for (const [path, expected] of Object.entries(frozen.reference.sources)) assert.equal(sha(await readFile(join(root, path))), expected, path);
    for (const entry of frozen.cases) assert.deepEqual(await nodePackageCase(entry.input, frozen.templates), entry.expected, entry.id);
  });
  test("Python reproduces every frozen package file API outcome", () => {
    assert.match(run(["-m", "unittest", "test_package_file_api"]).stderr, /OK/);
    assert.deepEqual(JSON.parse(run(["test_package_file_api.py", "--replay"]).stdout), frozen.cases.map(x => x.expected));
  });
  test("47 public modules replay package file APIs without Node or Git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-package-file-hermetic-"));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(n => n.endsWith(".py") && !n.startsWith("test_") && !excluded.has(n));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_package_file_api.py"]) await writeFile(join(directory, name), await readFile(join(core, name)));
      await mkdir(join(directory, "fixtures")); await writeFile(join(directory, "fixtures/package-file-api-vectors.json"), bytes);
      for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
      const before = (await readdir(directory)).sort();
      assert.deepEqual(JSON.parse(run(["test_package_file_api.py", "--replay"], directory).stdout), frozen.cases.map(x => x.expected));
      assert.deepEqual((await readdir(directory)).sort(), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
