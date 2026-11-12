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
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { compareUnicode } from "../packages/kernel/src/canonical.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function yamlFileSource(entry, templates = {}) {
  if (entry.contentHex !== undefined) return Buffer.from(entry.contentHex, "hex");
  if (entry.recipe?.kind === "mapping-depth") {
    const { depth, format } = entry.recipe, lines = [];
    if (format) lines.push(`format: ${JSON.stringify(format)}`);
    for (let index = 0; index < depth; index++) lines.push("  ".repeat(index) + "probe:");
    lines.push("  ".repeat(depth) + 'leaf: "value"');
    return Buffer.from(lines.join("\n") + "\n");
  }
  if (entry.recipe?.kind === "repeat") {
    const { prefix, text, repeat, suffix } = entry.recipe;
    return Buffer.from(prefix + text.repeat(repeat) + suffix);
  }
  if (entry.source !== undefined) return Buffer.from(entry.source, "utf8");
  const value = structuredClone(entry.record ?? templates[entry.template]);
  if (entry.expand) {
    let parent = value;
    for (const key of entry.expand.path.slice(0, -1)) parent = parent[key];
    parent[entry.expand.path.at(-1)] = entry.expand.text.repeat(entry.expand.repeat);
  }
  return Buffer.from(serializeYamlRecord(value), "utf8");
}

// Flatten maps in Unicode key order and preserve sequence order. This records
// every node without imposing JSON's recursive encoder depth on the file API.
export function logicalNodes(value) {
  const seen = new Map(), pending = [], nodes = [];
  function token(item) {
    if (item === null) return ["null"];
    if (typeof item === "string") {
      const bytes = Buffer.from(item, "utf8");
      return ["string", bytes.length > 65536 ? { largeUtf8Bytes: bytes.length, sha256: sha(bytes) } : item];
    }
    if (typeof item === "number" || typeof item === "boolean") return [typeof item, item];
    assert.ok(item && typeof item === "object", "unexpected logical value");
    if (!seen.has(item)) { seen.set(item, pending.length); pending.push(item); }
    return ["ref", seen.get(item)];
  }
  const first = token(value);
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    nodes.push(Array.isArray(item) ? { kind: "sequence", entries: item.map(token) } :
      { kind: "mapping", entries: Object.keys(item).sort(compareUnicode).map(key => [key, token(item[key])]) });
  }
  return { root: first, nodes };
}

let queue = Promise.resolve();
export function nodeYamlFileCase(spec, templates = {}) {
  const pending = queue.then(() => ownedCase(spec, templates));
  queue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function ownedCase(spec, templates) {
  const original = Object.fromEntries(Object.keys(fs.promises).map(key => [key, fs.promises[key]]));
  const previousCwd = process.cwd(), previousMask = process.umask();
  const directory = await original.realpath(await original.mkdtemp(join(tmpdir(), "morivyx-yaml-file-case-")));
  const counts = (spec.faults ?? []).map(() => 0), fired = counts.slice(), readAttempts = [];
  let escaped = false;
  const safe = path => {
    const target = resolve(directory, path);
    assert.ok(target === directory || target.startsWith(directory + sep), "case escapes owned root");
    return target;
  };
  const normalize = path => typeof path === "string" ? path.replaceAll(directory, "$ROOT") : path ?? null;
  const restore = () => { fs.promises.readFile = original.readFile; syncBuiltinESMExports(); };
  async function layout() {
    const rows = [];
    async function visit(path, relative) {
      const information = await original.lstat(path), mode = information.mode & 0o7777;
      if (information.isSymbolicLink()) rows.push({ path: relative, kind: "symlink", target: normalize(await original.readlink(path)), mode });
      else if (information.isDirectory()) {
        if (relative) rows.push({ path: relative, kind: "directory", mode });
        for (const child of (await original.readdir(path)).sort(compareUnicode)) await visit(join(path, child), relative ? relative + "/" + child : child);
      } else {
        assert.ok(information.isFile(), "unexpected special file in owned case");
        const bytes = await original.readFile(path);
        rows.push({ path: relative, kind: "file", mode, nlink: information.nlink,
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
      } else if (entry.kind === "hardlink") await original.link(safe(entry.target), path);
      else { await original.writeFile(path, yamlFileSource(entry, templates)); await original.chmod(path, entry.mode ?? 0o644); }
    }
    process.chdir(directory); process.umask(spec.umask ?? 0o022);
    const before = await layout(), supplied = Object.hasOwn(spec, "path") ? spec.path : "input.yaml";
    assert.notEqual(typeof supplied, "number", "file-descriptor reads are outside this fixture vocabulary");
    const destination = spec.relative || typeof supplied !== "string" ? supplied : safe(supplied);
    fs.promises.readFile = (...args) => {
      if (typeof args[0] === "string" && !args[0].includes("\0")) {
        const path = resolve(args[0]);
        if (path !== directory && !path.startsWith(directory + sep)) { escaped = true; throw new Error("read escapes owned root"); }
        readAttempts.push(normalize(args[0]));
        for (const [index, rule] of (spec.faults ?? []).entries()) {
          assert.equal(rule.operation, "readFile");
          assert.ok(rule.target === undefined || ["input", "any"].includes(rule.target));
          counts[index]++;
          if (rule.nth !== undefined && counts[index] !== rule.nth) continue;
          fired[index]++;
          const error = new Error("controlled read failure"); error.code = rule.code; error.path = args[0]; throw error;
        }
      }
      return original.readFile(...args);
    };
    syncBuiltinESMExports();
    let result;
    try {
      const value = await readYamlRecord(destination, spec.required);
      result = value === undefined ? { ok: true, missing: true } : { ok: true, logical: logicalNodes(value) };
    } catch (error) { result = { ok: false, code: error.code ?? null, path: normalize(error.path) }; }
    assert.equal(escaped, false, "case attempted a read outside its owned root");
    restore();
    return { result, before, after: await layout(), readAttempts, faultCalls: counts, faultFired: fired };
  } finally {
    restore(); process.chdir(previousCwd); process.umask(previousMask);
    await original.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const bytes = await readFile(join(root, "packages/portable-core/fixtures/yaml-file-api-vectors.json")), frozen = JSON.parse(bytes);
  const core = join(root, "packages/portable-core"), executable = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
  const resolved = spawnSync(executable, ["-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const python = resolved.stdout.trim(), env = { PATH: "", LANG: "C.UTF-8", PYTHONPATH: "", PYTHONHOME: "" };
  function run(args, cwd = core) {
    const result = spawnSync(python, ["-B", ...args], { cwd, env, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result;
  }
  test("original YAML file reads reproduce frozen logical values, diagnostics and untouched layouts", async () => {
    assert.equal(frozen.count, frozen.cases.length);
    assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), frozen.reference.normalizationHarnessSha256);
    for (const [path, expected] of Object.entries(frozen.reference.sources)) assert.equal(sha(await readFile(join(root, path))), expected, path);
    for (const entry of frozen.cases) assert.deepEqual(await nodeYamlFileCase(entry.input, frozen.templates), entry.expected, entry.id);
  });
  test("independent Python reproduces every frozen generic YAML file outcome", () => {
    assert.match(run(["-m", "unittest", "test_yaml_file_api"]).stderr, /OK/);
    assert.deepEqual(JSON.parse(run(["test_yaml_file_api.py", "--replay"]).stdout), frozen.cases.map(entry => entry.expected));
  });
  test("47 public modules reproduce YAML file reads with Node and Git unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-file-hermetic-"));
    try {
      const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
      const modules = (await readdir(core)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
      assert.equal(modules.length, 47);
      for (const name of [...modules, "test_yaml_file_api.py"]) await writeFile(join(directory, name), await readFile(join(core, name)));
      await mkdir(join(directory, "fixtures")); await writeFile(join(directory, "fixtures/yaml-file-api-vectors.json"), bytes);
      for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
      const before = (await readdir(directory)).sort();
      assert.deepEqual(JSON.parse(run(["test_yaml_file_api.py", "--replay"], directory).stdout), frozen.cases.map(entry => entry.expected));
      assert.deepEqual((await readdir(directory)).sort(), before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
