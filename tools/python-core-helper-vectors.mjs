import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, readlink, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PackageError } from '../packages/kernel/src/errors.js';
import { compareUnicode } from '../packages/kernel/src/canonical.js';
import { schemaKey } from '../packages/kernel/src/schema-registry.js';
import { compareSemanticDiffEntries } from '../packages/kernel/src/semantic-diff.js';
import { compareIssues } from '../packages/kernel/src/validator.js';
import { assertSupportedNodeVersion } from '../packages/kernel/src/node-runtime.js';

assertSupportedNodeVersion();

export const root = fileURLToPath(new URL('../', import.meta.url));
export const sha = value => createHash('sha256').update(value).digest('hex');
export const methods = Object.freeze({ PackageError, compareUnicode, schemaKey, compareSemanticDiffEntries, compareIssues });
export const fixturePaths = Object.freeze({ input: 'packages/portable-core/fixtures/core-helper-vectors.json',
  observations: 'packages/portable-core/fixtures/core-helper-observations.json' });

export async function loadVectors() {
  const bytes = await readFile(join(root, fixturePaths.input)), vectors = JSON.parse(bytes);
  assert.equal(vectors.format, 'morivyx.core-helper-vectors/1');
  assert.equal(vectors.count, 1945); assert.equal(vectors.cases.length, vectors.count);
  assert.equal(new Set(vectors.cases.map(row => row.id)).size, vectors.count);
  assert.deepEqual([...new Set(vectors.cases.map(row => row.function))].sort(), Object.keys(methods).sort());
  for (const row of vectors.cases) {
    assert.deepEqual(Object.keys(row), ['id', 'function', 'args']); assert.ok(Array.isArray(row.args));
  }
  return vectors;
}

export function materialize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(materialize);
  if (Object.hasOwn(value, '$fixture')) {
    switch (value.$fixture) {
      case 'undefined': return undefined;
      case 'negative-zero': return -0;
      case 'nan': return NaN;
      case 'infinity': return Infinity;
      case 'bytes': assert.match(value.hex, /^(?:[0-9a-f]{2})*$/); assert.ok(value.hex.length <= 131072); return Buffer.from(value.hex, 'hex');
      case 'cycle': { const result = {}; result.probe = result; return result; }
      case 'depth': {
        assert.ok(Number.isInteger(value.count) && value.count >= 0 && value.count <= 2048);
        let result = value.leaf; for (let index = 0; index < value.count; index++) result = { probe: result }; return result;
      }
      default: throw new Error('unknown input recipe');
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
}

export function observe(value, ownedRoot) {
  const queue = [], seen = new Map(), nodes = [];
  const normalize = text => text.replaceAll(ownedRoot, '$ROOT');
  function token(item) {
    if (item === undefined) return ['undefined'];
    if (item === null) return ['null'];
    if (typeof item === 'string') return ['string', normalize(item)];
    if (typeof item === 'boolean') return ['boolean', item];
    if (typeof item === 'number') return ['number', Number.isNaN(item) ? 'NaN' : item === Infinity ? '+Infinity' : item === -Infinity ? '-Infinity' : Object.is(item, -0) ? '-0' : item];
    assert.equal(typeof item, 'object', 'unsupported observation value');
    if (!seen.has(item)) { seen.set(item, queue.length); queue.push(item); }
    return ['ref', seen.get(item)];
  }
  const first = token(value);
  for (let index = 0; index < queue.length; index++) {
    assert.ok(queue.length <= 20000);
    const item = queue[index];
    if (item instanceof Uint8Array) nodes.push({ kind: 'bytes', hex: Buffer.from(item).toString('hex') });
    else if (Array.isArray(item)) nodes.push({ kind: 'sequence', entries: Array.from(item, token) });
    else {
      assert.ok(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
      nodes.push({ kind: 'mapping', entries: Object.keys(item).map(key => [normalize(key), token(item[key])]) });
    }
  }
  return { root: first, nodes };
}

async function layout(directory) {
  const rows = [], pending = [[Buffer.from(directory), Buffer.alloc(0)]];
  while (pending.length) {
    const [path, relative] = pending.pop(), state = await lstat(path), common = { pathHex: relative.toString('hex'), mode: state.mode & 0o7777 };
    if (state.isSymbolicLink()) rows.push({ ...common, kind: 'symlink', targetHex: (await readlink(path, { encoding: 'buffer' })).toString('hex') });
    else if (state.isDirectory()) {
      rows.push({ ...common, kind: 'directory' });
      for (const name of await readdir(path, { encoding: 'buffer' })) pending.push([Buffer.concat([path, Buffer.from('/'), name]), relative.length ? Buffer.concat([relative, Buffer.from('/'), name]) : name]);
    } else {
      assert.ok(state.isFile()); const bytes = await readFile(path);
      rows.push({ ...common, kind: 'file', nlink: state.nlink, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return rows.sort((a, b) => Buffer.compare(Buffer.from(a.pathHex, 'hex'), Buffer.from(b.pathHex, 'hex')));
}

export async function runNodeCase(spec) {
  assert.ok(Object.hasOwn(methods, spec.function));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'morivyx-core-helper-'))), cwd = process.cwd(), mask = process.umask(0o022);
  try {
    process.chdir(directory);
    const args = materialize(spec.args), before = observe(args, directory), filesBefore = await layout(directory);
    let outcome, awaitable = false;
    try {
      const api = methods[spec.function], pending = spec.function === 'PackageError' ? new api(...args) : api(...args);
      awaitable = Boolean(pending && typeof pending.then === 'function'); const result = await pending;
      const value = spec.function === 'PackageError' ? { name: result.name, message: result.message, code: result.code, path: result.path, issue: result.toIssue(), inheritsError: result instanceof Error } : result;
      outcome = { ok: true, value: observe(value, directory), returnAliases: spec.function !== 'PackageError' && result !== null && typeof result === 'object' ? args.flatMap((arg, index) => result === arg ? [index] : []) : [] };
    } catch (error) {
      outcome = { ok: false, name: error.name, message: observe(error.message, directory), code: observe(error.code, directory), path: observe(error.path, directory) };
    }
    return { id: spec.id, function: spec.function, awaitable, outcome, argumentsBefore: before, argumentsAfter: observe(args, directory), filesystemBefore: filesBefore, filesystemAfter: await layout(directory) };
  } finally { process.chdir(cwd); process.umask(mask); await rm(directory, { recursive: true, force: true }); }
}

export async function captureNode() {
  const vectors = await loadVectors(), observations = [];
  for (const row of vectors.cases) observations.push(await runNodeCase(row));
  return { format: 'morivyx.function-direct-observations/1', runtime: 'node', version: process.versions.node, count: observations.length, observations };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.deepEqual(process.argv.slice(2), ['--capture']);
  process.stdout.write(JSON.stringify(await captureNode()) + '\n');
}
