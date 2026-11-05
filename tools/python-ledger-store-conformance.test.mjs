import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { canonicalJson, compareUnicode } from "../packages/kernel/src/canonical.js";
import { writeApproval, writeChangeSet, writeMigration } from "../packages/kernel/src/ledger-store.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const core = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));

function inside(root, path) {
  assert.ok(path === root || path.startsWith(root + sep));
  return path;
}
function fixturePath(root, parent, name) {
  assert.equal(typeof name, "string"); assert.equal(isAbsolute(name), false);
  assert.equal(name.split(/[\\/]/u).includes(".."), false);
  return inside(root, resolve(parent, name));
}
async function parents(root, path) {
  const parts = relative(root, dirname(path)).split(sep).filter(Boolean); let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    assert.equal((await lstat(current)).isDirectory(), true);
    assert.equal((await lstat(current)).isSymbolicLink(), false);
  }
}
function normalize(value, root) {
  if (typeof value === "string") return (value.startsWith(root) ? "ROOT" + value.slice(root.length) : value)
    .replace(/\/\.record-[0-9]+-[0-9a-f-]{36}\.tmp/gu, "/.record-TEMP.tmp");
  if (Array.isArray(value)) return value.map(item => normalize(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, root)]));
  return value;
}
export function expandedRecord(spec) {
  const record = Object.hasOwn(spec, "recordText") ? JSON.parse(spec.recordText) : structuredClone(spec.record);
  if (spec.expand?.kind === "operation") record.operation = "x".repeat(spec.expand.length);
  if (spec.expand?.kind === "nested") {
    let value = "leaf";
    for (let index = 0; index < spec.expand.depth; index++) value = [value];
    record.provenance.extra = value;
  }
  return record;
}
export async function treeSnapshot(root) {
  const output = {};
  async function walk(path, prefix) {
    for (const name of (await readdir(path)).sort(compareUnicode)) {
      const child = join(path, name), key = prefix + name, info = await lstat(child);
      if (info.isSymbolicLink()) output[key] = { kind: "link", target: await readlink(child) };
      else if (info.isDirectory()) { output[key] = { kind: "directory", mode: info.mode & 0o777 }; await walk(child, key + "/"); }
      else if (info.isFile()) output[key] = { kind: "file", bytes: info.size, sha256: digest(await readFile(child)), mode: info.mode & 0o777, links: info.nlink };
      else output[key] = { kind: info.isFIFO() ? "fifo" : "special", mode: info.mode & 0o777 };
    }
  }
  await walk(root, ""); return output;
}
export async function nodeLedgerCase(spec, baseFiles) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-ledger-case-"))), previous = process.cwd(), mask = process.umask(0o022);
  const base = ["nested", "ancestor-link"].includes(spec.layout) ? join(root, "package") : root;
  const metadata = join(base, ".morivyx"); let argument = base;
  try {
    for (const [name, source] of Object.entries(baseFiles)) {
      const path = fixturePath(root, metadata, name); await parents(root, path); await writeFile(path, source, "utf8");
    }
    if (spec.layout === "missing") await rm(metadata, { recursive: true });
    if (spec.layout === "metadata-file") { await rm(metadata, { recursive: true }); await writeFile(metadata, "owned"); }
    if (spec.layout === "metadata-link") { await rename(metadata, join(root, "owned-metadata")); await symlink("owned-metadata", metadata); }
    if (spec.layout === "ancestor-link") { await symlink("package", join(root, "alias")); argument = join(root, "alias"); }
    for (const mutation of spec.mutations ?? []) {
      const path = fixturePath(root, metadata, mutation.path);
      if (mutation.kind === "remove") await rm(path, { recursive: true, force: true });
      else {
        await parents(root, path);
        if (mutation.kind === "write") await writeFile(path, mutation.source, "utf8");
        else if (mutation.kind === "bytes") await writeFile(path, Buffer.from(mutation.hex, "hex"));
        else if (mutation.kind === "directory") await mkdir(path, { recursive: true });
        else if (mutation.kind === "symlink") {
          inside(root, resolve(dirname(path), mutation.target)); await symlink(mutation.target, path);
        } else if (mutation.kind === "hardlink") await link(fixturePath(root, metadata, mutation.target), path);
        else if (mutation.kind === "fifo") {
          const result = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
        } else throw new Error("fixture mutation invalid");
      }
    }
    const record = expandedRecord(spec), beforeRecord = JSON.stringify(record);
    if (spec.busy) await writeFile(join(metadata, `.record-id-${record.id.slice(9)}.lock`), "owned-busy", { mode: 0o600 });
    process.chdir(root);
    if (spec.pathMode === "metadata") argument = metadata;
    if (spec.pathMode === "relative") argument = relative(root, base) || ".";
    if (spec.pathMode === "parent") argument = "unused/../";
    if (spec.pathMode === "value") { assert.ok(typeof spec.pathValue !== "string" || spec.pathValue === ""); argument = spec.pathValue; }
    process.umask(spec.umask ?? 0o022);
    let outcome, reread = null;
    try {
      const functions = { approval: writeApproval, change: writeChangeSet, migration: writeMigration, read: readGraphPackage };
      assert.ok(Object.hasOwn(functions, spec.operation));
      const result = await functions[spec.operation](argument, record);
      outcome = { ok: true, result: normalize(result, root) };
      if (spec.operation !== "read") {
        const packageContents = await readGraphPackage(argument);
        const { directory, ...projection } = packageContents;
        reread = { valid: true, sha256: digest(canonicalJson(projection)), counts: Object.fromEntries(
          ["elements", "approvals", "changeSets", "migrations", "reports"].map(key => [key, packageContents[key].length])) };
      }
    } catch (error) {
      outcome = { ok: false, code: error.code ?? null, path: normalize(error.path ?? null, root) };
    }
    assert.equal(JSON.stringify(record), beforeRecord);
    return { outcome, reread, tree: await treeSnapshot(root) };
  } finally { process.chdir(previous); process.umask(mask); await rm(root, { recursive: true, force: true }); }
}

// The generator imports the replay functions without registering tests or reading
// a fixture that it has not generated yet. The actual Node test child is direct.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bytes = await readFile(join(core, "fixtures/ledger-store-vectors.json"));
  const fixture = JSON.parse(bytes);
  test("the pinned Node ledger operations reproduce every frozen filesystem result", async () => {
    assert.equal(digest(bytes), "0e7374160de9d9b90f2f9497f9c87b469cd89b56b61cd75b81a4cca4e77f5637");
    for (const [path, expected] of Object.entries(fixture.sources)) assert.equal(digest(await readFile(new URL("../" + path, import.meta.url))), expected);
    for (const entry of fixture.cases) assert.deepEqual(await nodeLedgerCase(entry.input, fixture.baseFiles), entry.expected, entry.id);
  });
  const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  function pythonRun(args, cwd = core, env = process.env) {
    const child = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); return child;
  }
  function verifyReplay(output) {
    const results = JSON.parse(output); assert.equal(results.length, fixture.count);
    for (let index = 0; index < fixture.count; index++) {
      const { id, ...actual } = results[index]; assert.equal(id, fixture.cases[index].id);
      assert.deepEqual(actual, fixture.cases[index].expected, id);
    }
  }
  test("independent Python matches every persisted byte, rejection path and separate readback", () => {
    assert.match(pythonRun(["-m", "unittest", "test_ledger_store"]).stderr, /Ran 5 tests/);
    verifyReplay(pythonRun(["test_ledger_store.py", "--replay"]).stdout);
  });
  test("the public production modules run all filesystem cases without Node or Git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-ledger-isolated-"));
    try {
      const privateFiles = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !privateFiles.has(name));
      assert.equal(modules.length, 39);
      for (const name of [...modules, "test_ledger_store.py"]) await cp(join(core, name), join(directory, name));
      await mkdir(join(directory, "fixtures")); await cp(join(core, "fixtures/ledger-store-vectors.json"), join(directory, "fixtures/ledger-store-vectors.json"));
      const executable = pythonRun(["-c", "import sys; print(sys.executable)"]).stdout.trim();
      const child = spawnSync(executable, ["-B", "test_ledger_store.py", "--replay", "--isolated"], { cwd: directory,
        env: { PATH: "", PYTHONIOENCODING: "utf-8" }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); verifyReplay(child.stdout);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  function readyChild(command, args) {
    const child = spawn(command, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const done = new Promise((resolve, reject) => {
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.startsWith("READY\n")) readyResolve(); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", error => { readyReject(error); reject(error); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) { const error = new Error(`writer exit ${code}: ${stderr}`); readyReject(error); reject(error); }
        else { try { resolve(JSON.parse(stdout.slice("READY\n".length))); } catch (error) { reject(error); } }
      });
    });
    // Attach rejection handlers immediately while waiting for both ready signals.
    done.catch(() => {}); ready.catch(() => {});
    return { child, ready, done };
  }
  test("actual Node and Python children publish one shared ID across same and different record types", async () => {
    const nodeProgram = `import {writeApproval,writeChangeSet,writeMigration} from ${JSON.stringify(new URL("../packages/kernel/src/ledger-store.js", import.meta.url).href)};
      console.log("READY"); let source=""; for await(const chunk of process.stdin) source+=chunk;
      try {const result=await ({approval:writeApproval,change:writeChangeSet,migration:writeMigration})[process.argv[1]](process.argv[2],JSON.parse(source)); console.log(JSON.stringify({ok:true,result}));}
      catch(error){console.log(JSON.stringify({ok:false,code:error.code??null,path:error.path??null}));}`;
    for (const other of ["approval", "change", "migration"]) for (let round = 0; round < 4; round++) {
      const root = await mkdtemp(join(tmpdir(), "morivyx-ledger-race-")); let children = [];
      try {
        for (const [name, source] of Object.entries(fixture.baseFiles)) {
          const path = fixturePath(root, join(root, ".morivyx"), name); await parents(root, path); await writeFile(path, source);
        }
        const first = structuredClone(fixture.templates.approval), second = structuredClone(fixture.templates[other]); second.id = first.id;
        // Reverse languages on alternating rounds; both wait for the input gate.
        const nodeKind = round % 2 ? other : "approval", pythonKind = round % 2 ? "approval" : other;
        children = [readyChild(process.execPath, ["--input-type=module", "-e", nodeProgram, nodeKind, root]),
          readyChild(python, ["-B", join(core, "test_ledger_store.py"), "--write-ready", pythonKind, root])];
        await Promise.all(children.map(child => child.ready));
        children[0].child.stdin.end(JSON.stringify(round % 2 ? second : first));
        children[1].child.stdin.end(JSON.stringify(round % 2 ? first : second));
        const results = await Promise.all(children.map(child => child.done));
        assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
        assert.equal(results.find(result => !result.ok).code, other === "approval" ? "APPROVAL_ALREADY_EXISTS" : "ID_DUPLICATE");
        const reread = await readGraphPackage(root);
        assert.equal([reread.approvals, reread.changeSets, reread.migrations].flat().filter(record => record.id === first.id).length, 1);
        assert.equal(Object.keys(await treeSnapshot(root)).some(path => path.includes(".record-")), false);
      } finally { for (const child of children) if (child.child.exitCode === null) child.child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
    }
  });
  test("readback merge-key refusals and scalar edge cases match the live source without normalizing record data", async () => {
    for (const extra of [{ "<<": "x" }, { "a\u0000b": "x" }, { a: "x\u2028y" }, { a: "x\u0085y" }, { a: -0 }, { a: 9007199254740992 },
      { a: null }, { a: [null] }, { a: "\ud800" }, { "e\u0301": 1, "é": 2 },
      ...Array.from({ length: 32 }, (_, index) => ({ a: String.fromCodePoint(index) })),
      { a: "x\u2029y" }, { a: "\\u0000" }, { a: "\\\u0000" }, { a: "\\u2028" }]) {
      const record = structuredClone(fixture.templates.change); record.provenance.extra = extra;
      let recordText = JSON.stringify(record);
      if (Object.is(extra.a, -0)) recordText = recordText.replace('"a":0', '"a":-0');
      const spec = { operation: "change", recordText };
      const expected = await nodeLedgerCase(spec, fixture.baseFiles);
      const child = spawnSync(python, ["-B", join(core, "test_ledger_store.py"), "--one"], {
        input: JSON.stringify(spec), encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), expected, recordText);
    }
  });
}
