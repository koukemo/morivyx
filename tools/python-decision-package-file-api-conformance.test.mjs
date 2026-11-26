import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { writeCreatedDecisionPackage } from "../packages/kernel/src/decision-creation.js";
import { writeRevisedDecisionPackage } from "../packages/kernel/src/decision-revision.js";
import { logicalNodes, packageSource, sha } from "./python-package-file-api-conformance.test.mjs";
import { verifyDecisionPackageReplaySources } from "./reference-source-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let casesQueue = Promise.resolve();

export function decisionPackageArguments(spec, safe) {
  const args = structuredClone(spec.args ?? []);
  const value = args[0];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["basePath", "outputPath"])
      if (value[key] && typeof value[key] === "object" && Object.hasOwn(value[key], "$root")) value[key] = safe(value[key].$root);
    for (const recipe of spec.argumentRecipes ?? []) {
      let target = value;
      for (const key of recipe.path.slice(0, -1)) target = target[key];
      let result;
      if (recipe.repeat) result = recipe.repeat.prefix + recipe.repeat.text.repeat(recipe.repeat.count) + recipe.repeat.suffix;
      else if (recipe.depth) {
        assert.ok(Number.isInteger(recipe.depth.count) && recipe.depth.count >= 0 && recipe.depth.count <= 4096);
        result = recipe.depth.leaf;
        for (let i = 0; i < recipe.depth.count; i++) result = { [recipe.depth.key]: result };
      } else throw new Error("unknown argument recipe");
      target[recipe.path.at(-1)] = result;
    }
  }
  return args;
}

export function nodeDecisionPackageCase(spec, templates, observation) {
  const promise = casesQueue.then(() => ownedCase(spec, templates, observation));
  casesQueue = promise.then(() => undefined, () => undefined);
  return promise;
}

async function ownedCase(spec, templates, observation) {
  assert.ok(spec.schedule === "natural" || spec.schedule === "serial-io");
  const original = Object.fromEntries(Object.keys(fs.promises).map(key => [key, fs.promises[key]]));
  const originalUuid = crypto.randomUUID, context = new AsyncLocalStorage();
  const directory = await original.realpath(await original.mkdtemp(join(tmpdir(), "morivyx-decision-package-case-")));
  const cwd = process.cwd(), mask = process.umask(), trace = [], pending = new Set(), handles = [], nonces = [];
  const rules = spec.faults ?? [], faultCalls = rules.map(() => 0), faultFired = rules.map(() => 0);
  let serial = Promise.resolve(), escaped = false, phase = "setup";
  const safe = path => {
    const target = resolve(directory, path);
    assert.ok(target === directory || target.startsWith(directory + sep), "setup escapes owned root");
    return target;
  };
  function normalizePath(value) {
    if (typeof value !== "string") return value ?? null;
    let text = value;
    if (text === directory || text.startsWith(directory + sep)) text = "$ROOT" + text.slice(directory.length);
    for (const [index, nonce] of nonces.entries()) {
      const suffix = `-${process.pid}-${nonce}.tmp`;
      text = text.split(sep).map(part => part.startsWith(".") && (part.endsWith(suffix) || part.includes(suffix + "#")) ?
        part.replace(suffix, `-$PID-$UUID${index}.tmp`) : part).join(sep);
    }
    return text;
  }
  function normalizeBytes(value) {
    const result = [];
    let start = 0;
    for (let end = 0; end <= value.length; end++) if (end === value.length || value[end] === 47) {
      let part = value.subarray(start, end);
      if (part[0] === 46) for (const [index, nonce] of nonces.entries()) {
        const from = Buffer.from(`-${process.pid}-${nonce}.tmp`);
        if (part.length >= from.length && part.subarray(part.length - from.length).equals(from))
          part = Buffer.concat([part.subarray(0, part.length - from.length), Buffer.from(`-$PID-$UUID${index}.tmp`)]);
      }
      if (result.length) result.push(Buffer.from("/"));
      result.push(part); start = end + 1;
    }
    return Buffer.concat(result);
  }
  function normalizeArgs(args) {
    return args.map((item, index) => index === 0 && item && typeof item === "object" && !Array.isArray(item) ?
      { ...item, ...Object.fromEntries(["basePath", "outputPath"].filter(key => Object.hasOwn(item, key)).map(key => [key, normalizePath(item[key])])) } : item);
  }
  async function layout() {
    const rows = [], rootBytes = Buffer.from(directory);
    async function visit(path, relative) {
      const information = await original.lstat(path), normalized = normalizeBytes(relative);
      const common = { path: normalized.toString("utf8"), pathHex: normalized.toString("hex"), mode: information.mode & 0o7777 };
      if (information.isSymbolicLink()) {
        let target = await original.readlink(path, { encoding: "buffer" });
        if (target.subarray(0, rootBytes.length).equals(rootBytes) && (target.length === rootBytes.length || target[rootBytes.length] === 47))
          target = Buffer.concat([Buffer.from("$ROOT"), target.subarray(rootBytes.length)]);
        rows.push({ ...common, kind: "symlink", targetHex: normalizeBytes(target).toString("hex") });
      } else if (information.isDirectory()) {
        rows.push({ ...common, kind: "directory" });
        for (const name of (await original.readdir(path, { encoding: "buffer" })).sort(Buffer.compare))
          await visit(Buffer.concat([path, Buffer.from("/"), name]), relative.length ? Buffer.concat([relative, Buffer.from("/"), name]) : name);
      } else {
        assert.ok(information.isFile(), "special file in fixture");
        const bytes = await original.readFile(path);
        rows.push({ ...common, kind: "file", nlink: information.nlink, byteLength: bytes.length, sha256: sha(bytes) });
      }
    }
    await visit(rootBytes, Buffer.alloc(0));
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.pathHex, "hex"), Buffer.from(b.pathHex, "hex")));
    if (observation) observation({ phase, layout: rows });
    if (rows.length <= 256) return rows;
    const bytes = Buffer.from(JSON.stringify(rows));
    return { entries: rows.length, byteLength: bytes.length, sha256: sha(bytes) };
  }
  const twoPaths = new Set(["cp", "rename", "link"]);
  const pathCount = operation => twoPaths.has(operation) ? 2 : 1;
  function validPath(path) { return typeof path === "string" && !path.includes("\0"); }
  function checkPath(path) {
    if (!validPath(path)) return;
    const absolute = resolve(path);
    if (absolute !== directory && !absolute.startsWith(directory + sep)) escaped = true;
    if (escaped) {
      const error = new Error("operation escapes owned root");
      error.code = "REFERENCE_PATH_ESCAPE"; error.referenceHarnessFailure = true; throw error;
    }
  }
  async function effect(item, paths, args) {
    if (!item) return;
    const path = safe(item.path === "$OPERATION" ? paths[0] : item.path === "$DESTINATION" ? paths[1] : item.path);
    if (item.kind === "write") {
      await original.mkdir(dirname(path), { recursive: true }); await original.writeFile(path, packageSource(item.source));
    } else if (item.kind === "remove") await original.rm(path, { recursive: true, force: true });
    else if (item.kind === "directory") await original.mkdir(path, { recursive: true });
    else if (item.kind === "write-prefix") await original.writeFile(path, Buffer.from(args[1]).subarray(0, item.bytes));
    else throw new Error("unknown fault effect");
  }
  function observed(operation, args, perform) {
    const count = pathCount(operation), paths = args.slice(0, count), valid = paths.every(validPath);
    for (const path of paths) checkPath(path);
    const normalized = paths.map(normalizePath);
    if (valid) {
      const detail = operation === "handle.writeFile" ? [{ byteLength: Buffer.byteLength(args[1]), sha256: sha(Buffer.from(args[1])) }, ...args.slice(2)] : args.slice(count);
      trace.push([operation, ...normalized, ...structuredClone(detail)]);
    }
    const task = async () => {
      for (const [index, rule] of rules.entries()) {
        if (!valid || rule.operation !== operation) continue;
        if (rule.path !== undefined && normalized[0] !== (rule.path === "" ? "$ROOT" : "$ROOT/" + rule.path)) continue;
        if (rule.suffix !== undefined && !normalized[0].endsWith(rule.suffix)) continue;
        if (rule.destination !== undefined && normalized[1] !== (rule.destination === "" ? "$ROOT" : "$ROOT/" + rule.destination)) continue;
        faultCalls[index]++;
        if (rule.nth !== undefined && rule.nth !== faultCalls[index]) continue;
        faultFired[index]++;
        await effect(rule.effect, paths, args);
        if (rule.code !== undefined) {
          const error = new Error("controlled filesystem failure"); error.code = rule.code; error.path = paths[0]; throw error;
        }
      }
      return context.run(true, perform);
    };
    const work = spec.schedule === "serial-io" ? serial.then(task) : task();
    if (spec.schedule === "serial-io") serial = work.catch(() => undefined);
    let tracked;
    tracked = work.then(value => { pending.delete(tracked); return value; }, error => { pending.delete(tracked); throw error; });
    pending.add(tracked); return tracked;
  }
  function wrapHandle(handle, path) {
    const methods = {};
    for (const name of ["writeFile", "sync", "close"]) {
      methods[name] = handle[name];
      handle[name] = (...args) => context.getStore() ? methods[name].apply(handle, args) :
        observed("handle." + name, [path, ...args], () => methods[name].apply(handle, args));
    }
    handles.push({ handle, methods }); return handle;
  }
  function restore() {
    for (const [name, value] of Object.entries(original)) fs.promises[name] = value;
    crypto.randomUUID = originalUuid;
    for (const { handle, methods } of handles) Object.assign(handle, methods);
    syncBuiltinESMExports();
  }
  try {
    process.umask(0o022);
    // Node's lazy cp implementation captures promise methods on first use.
    // Initialize it with unpatched methods before any case installs observers;
    // otherwise a later case can invoke a previous case's guard closure.
    phase = "warmup";
    const warmSource = safe(".observer-copy-source"), warmTarget = safe(".observer-copy-target");
    await original.mkdir(join(warmSource, "nested"), { recursive: true });
    await original.writeFile(join(warmSource, "nested/ordinary"), "owned observer initialization\n");
    await original.cp(warmSource, warmTarget, { recursive: true, dereference: true });
    await original.rm(warmSource, { recursive: true, force: true });
    await original.rm(warmTarget, { recursive: true, force: true });
    phase = "setup";
    const setup = spec.setup ?? {};
    for (const rule of rules) {
      assert.ok(["lstat", "stat", "readdir", "readFile", "realpath", "mkdir", "cp", "rm", "rename", "open", "link", "unlink", "handle.writeFile", "handle.sync", "handle.close"].includes(rule.operation));
      assert.ok(rule.nth === undefined || Number.isInteger(rule.nth) && rule.nth > 0);
      assert.ok(rule.code === undefined || typeof rule.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(rule.code));
      for (const key of ["path", "suffix", "destination"]) assert.ok(rule[key] === undefined || typeof rule[key] === "string");
      if (rule.effect) {
        assert.ok(["write", "remove", "directory", "write-prefix"].includes(rule.effect.kind));
        assert.equal(typeof rule.effect.path, "string");
        if (rule.effect.path === "$DESTINATION") assert.ok(twoPaths.has(rule.operation));
        if (rule.effect.kind === "write-prefix") {
          assert.equal(rule.operation, "handle.writeFile"); assert.ok(Number.isInteger(rule.effect.bytes) && rule.effect.bytes >= 0);
        }
      }
    }
    for (const [name, template] of Object.entries(setup.packages ?? {})) {
      assert.ok(Object.hasOwn(templates, template)); await original.mkdir(safe(name), { recursive: true });
      for (const [path, source] of Object.entries(templates[template])) {
        const target = safe(join(name, path)); await original.mkdir(dirname(target), { recursive: true }); await original.writeFile(target, packageSource(source));
      }
    }
    for (const name of setup.remove ?? []) await original.rm(safe(name), { recursive: true, force: true });
    for (const item of setup.move ?? []) { await original.mkdir(dirname(safe(item.to)), { recursive: true }); await original.rename(safe(item.from), safe(item.to)); }
    for (const item of setup.directories ?? []) {
      const path = safe(typeof item === "string" ? item : item.path); await original.mkdir(path, { recursive: true }); await original.chmod(path, item.mode ?? 0o755);
    }
    for (const item of setup.put ?? []) {
      const path = safe(item.path); await original.mkdir(dirname(path), { recursive: true }); await original.writeFile(path, packageSource(item.source)); await original.chmod(path, item.mode ?? 0o644);
    }
    for (const group of setup.many ?? []) {
      await original.mkdir(safe(group.directory), { recursive: true });
      for (let index = 0; index < group.count; index++) await original.writeFile(safe(join(group.directory, group.prefix + index + group.suffix)), packageSource(group.source));
    }
    for (const item of setup.links ?? []) {
      const path = safe(item.path); await original.mkdir(dirname(path), { recursive: true });
      if (item.kind === "hardlink") await original.link(safe(item.target), path);
      else { safe(item.absolute ? item.target : resolve(dirname(path), item.target)); await original.symlink(item.absolute ? safe(item.target) : item.target, path); }
    }
    process.chdir(directory); process.umask(spec.umask ?? 0o022);
    phase = "layout-before"; const before = await layout();
    const args = decisionPackageArguments(spec, safe), argsBefore = logicalNodes(normalizeArgs(args));
    phase = "api";
    for (const operation of ["lstat", "stat", "readdir", "readFile", "realpath", "mkdir", "cp", "rm", "rename", "open", "link", "unlink"]) {
      fs.promises[operation] = (...args) => {
        if (context.getStore()) return original[operation](...args);
        return observed(operation, args, async () => {
          const result = await original[operation](...args);
          return operation === "open" ? wrapHandle(result, args[0]) : result;
        });
      };
    }
    crypto.randomUUID = (...args) => {
      const value = originalUuid(...args);
      if (!context.getStore()) { trace.push(["randomUUID", "$UUID" + nonces.length]); nonces.push(value); }
      return value;
    };
    syncBuiltinESMExports();
    const method = { create: writeCreatedDecisionPackage, revise: writeRevisedDecisionPackage }[spec.method];
    assert.equal(typeof method, "function");
    let result;
    try {
      const value = await method(...args);
      result = { ok: true, logical: logicalNodes({ ...value, outputPath: normalizePath(value.outputPath), metadataPath: normalizePath(value.metadataPath) }) };
    } catch (error) {
      if (error.referenceHarnessFailure) throw error;
      if (observation) observation({ phase, event: "api-error", error: {
        code: error.code ?? error.name, message: error.message, stack: error.stack, path: error.path ?? null } });
      result = { ok: false, code: error.code ?? error.name, path: normalizePath(error.path) };
    }
    phase = "drain";
    let quiet = 0;
    for (let index = 0; index < 100 && quiet < 3; index++) {
      if (pending.size) { quiet = 0; await Promise.allSettled([...pending]); }
      await nextTurn(); quiet = pending.size ? 0 : quiet + 1;
    }
    assert.equal(pending.size, 0, "fixture did not drain"); assert.equal(escaped, false);
    restore(); phase = "layout-after";
    return { result, before, after: await layout(), trace, faultCalls, faultFired, argsBefore, argsAfter: logicalNodes(normalizeArgs(args)) };
  } catch (error) {
    error.referencePhase = phase; error.referenceDirectory = directory; throw error;
  } finally {
    restore(); process.chdir(cwd); process.umask(mask);
    for (const { handle, methods } of handles) { try { await methods.close.call(handle); } catch {} }
    await original.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixturePath = join(root, "packages/portable-core/fixtures/decision-package-file-api-vectors.json");
  const bytes = await fs.promises.readFile(fixturePath), frozen = JSON.parse(bytes), core = join(root, "packages/portable-core");
  const executable = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  const resolved = spawnSync(executable, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const python = resolved.stdout.trim(), env = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  function run(args, cwd = core) {
    const result = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result;
  }
  test("original decision package writers replay frozen outcomes and complete layouts", async () => {
    assert.equal(frozen.reference.stage, "frozen-original");
    assert.equal(frozen.count, frozen.cases.length); assert.ok(frozen.count >= 2);
    await verifyDecisionPackageReplaySources(root, bytes, await fs.promises.readFile(fileURLToPath(import.meta.url), "utf8"));
    for (const entry of frozen.cases) assert.deepEqual(await nodeDecisionPackageCase(entry.input, frozen.templates), entry.expected, entry.id);
  });
  test("Python reproduces every frozen decision package writer outcome", () => {
    assert.match(run(["-m", "unittest", "test_decision_package_file_api"]).stderr, /OK/);
    assert.deepEqual(JSON.parse(run(["test_decision_package_file_api.py", "--replay"]).stdout), frozen.cases.map(entry => entry.expected));
  });
  test("47 public modules replay decision package writers without Node or Git", async () => {
    const directory = await fs.promises.mkdtemp(join(tmpdir(), "morivyx-decision-package-hermetic-"));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await fs.promises.readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_decision_package_file_api.py"]) await fs.promises.writeFile(join(directory, name), await fs.promises.readFile(join(core, name)));
      await fs.promises.mkdir(join(directory, "fixtures")); await fs.promises.writeFile(join(directory, "fixtures/decision-package-file-api-vectors.json"), bytes);
      for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
      const before = (await fs.promises.readdir(directory)).sort();
      assert.deepEqual(JSON.parse(run(["test_decision_package_file_api.py", "--replay"], directory).stdout), frozen.cases.map(entry => entry.expected));
      assert.deepEqual((await fs.promises.readdir(directory)).sort(), before);
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
  });
}
