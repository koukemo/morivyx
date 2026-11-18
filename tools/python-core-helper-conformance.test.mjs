import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { root, sha, fixturePaths, loadVectors, observe, captureNode } from './python-core-helper-vectors.mjs';

export const inputSha256 = '48ae01436414cf5e7c82ebceefdb4c2f550dac78d683be8cf5297ec188ecb5d7';
export const observationSha256 = '97f29ed562f22ed40384fbbd21c1d8e1bdd67678d9aaeb4f3ea36e69e6a8660b';
export const commonFields = Object.freeze(['id', 'function', 'awaitable', 'outcome', 'argumentsBefore', 'argumentsAfter', 'filesystemBefore', 'filesystemAfter']);
export const pythonBindings = Object.freeze({ PackageError: ['schema_validation', 'PackageError'], compareUnicode: ['canonical', 'compare_unicode'],
  schemaKey: ['schema_registry', 'schema_key'], compareSemanticDiffEntries: ['semantic_diff', 'compare_semantic_diff_entries'], compareIssues: ['graph_validation', 'compare_issues'] });

export function compareObservations(expected, actual) {
  assert.equal(actual.length, expected.length, 'observation count differs');
  const differences = [];
  for (let index = 0; index < expected.length; index++) {
    const fields = commonFields.filter(field => !Object.hasOwn(expected[index], field) || !Object.hasOwn(actual[index], field) || !isDeepStrictEqual(expected[index][field], actual[index][field]));
    if (fields.length) differences.push({ id: expected[index].id, fields });
  }
  assert.equal(differences.length, 0, 'observation differences: ' + JSON.stringify(differences.slice(0, 20)));
}

export function pythonExecutable(requested) {
  const probe = spawnSync(requested, ['-B', '-c', 'import sys,json;print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3])}))'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(probe.error, undefined); assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.ok(isAbsolute(result.executable)); assert.equal(result.version[0], 3); assert.ok([14,15].includes(result.version[1]), 'Python 3.14 or 3.15 required');
  return result;
}

export function capturePython(python, location = root) {
  const env = { PATH: '', HOME: '', LANG: 'C.UTF-8', PYTHONPATH: '', PYTHONHOME: '' };
  for (const command of ['node', 'git']) assert.equal(spawnSync(command, ['--version'], { env }).error?.code, 'ENOENT');
  const result = spawnSync(python, ['-B', join(location, 'tools/python-core-helper-driver.py'), '--capture'],
    { cwd: location, env, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.format, 'morivyx.function-direct-observations/1'); assert.equal(observed.runtime, 'python');
  assert.equal(observed.count, 1945); assert.equal(observed.observations.length, observed.count);
  return observed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 3 && args[0] === '--python' && args[2] === '--check'), 'use --python ABSOLUTE_PATH --check');
  if (args.length) assert.ok(isAbsolute(args[1]));
  const python = pythonExecutable(args[1] ?? process.env.MORIVYX_REFERENCE_PYTHON ?? 'python3.14');
  const inputBytes = await readFile(join(root, fixturePaths.input)), expectedBytes = await readFile(join(root, fixturePaths.observations));
  const expected = JSON.parse(expectedBytes), vectors = await loadVectors();
  let actual;
  test('helper input and original outcome bytes retain independent frozen identities', () => {
    assert.equal(sha(inputBytes), inputSha256); assert.equal(sha(expectedBytes), observationSha256);
    assert.equal(expected.count, 1945); assert.equal(expected.observations.length, 1945);
    assert.equal(expected.observations.filter(row => row.outcome.ok).length, 1731);
    assert.equal(expected.observations.filter(row => !row.outcome.ok).length, 214);
    for (let index = 0; index < vectors.count; index++) {
      assert.equal(expected.observations[index].id, vectors.cases[index].id);
      assert.equal(expected.observations[index].function, vectors.cases[index].function);
    }
  });
  test('tagged observations preserve undefined, null, numeric edges and shared cycles', () => {
    const cycle = {}; cycle.self = cycle;
    const result = observe([undefined, null, -0, NaN, Infinity, -Infinity, cycle, cycle], '/owned');
    assert.deepEqual(result.nodes[0].entries, [['undefined'], ['null'], ['number','-0'], ['number','NaN'], ['number','+Infinity'], ['number','-Infinity'], ['ref',1], ['ref',1]]);
    assert.deepEqual(result.nodes[1].entries, [['self',['ref',1]]]);
  });
  test('original helper functions reproduce every frozen common observation field', async () => {
    const node = await captureNode(); compareObservations(expected.observations, node.observations);
  });
  test('real Python helper calls reproduce all 1945 cases without Node or Git', () => {
    actual = capturePython(python.executable);
    assert.equal(actual.version, python.version.join('.'));
    compareObservations(expected.observations, actual.observations);
  });
  test('every Python observation names the actual new module and callable', () => {
    actual ??= capturePython(python.executable);
    for (const row of actual.observations) assert.deepEqual(row.pythonCall,
      { module: pythonBindings[row.function][0], symbol: pythonBindings[row.function][1] }, row.id);
  });
  test('comparison refuses deleted diagnostics, arguments, layouts and changed results', () => {
    const selected = [expected.observations.find(row => !row.outcome.ok), expected.observations.find(row => row.outcome.ok)];
    for (const field of commonFields) {
      const changed = structuredClone(selected); delete changed[0][field];
      assert.throws(() => compareObservations(selected, changed), /observation differences/);
    }
    const changed = structuredClone(selected); changed[1].outcome.value.root = ['string', 'altered'];
    assert.throws(() => compareObservations(selected, changed), /observation differences/);
    assert.throws(() => compareObservations(selected, selected.slice(1)), /observation count differs/);
  });
  test('47 public modules reproduce helpers with only input fixtures in a separate repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morivyx-core-helper-hermetic-'));
    try {
      const excluded = new Set(['evidence_archive.py','evidence_restore.py','proposal_acceptance.py','proposal_review.py']);
      const core = join(root, 'packages/portable-core');
      const modules = (await readdir(core)).filter(name => name.endsWith('.py') && !name.startsWith('test_') && !excluded.has(name));
      assert.equal(modules.length, 47);
      await mkdir(join(directory, 'packages/portable-core/fixtures'), { recursive: true }); await mkdir(join(directory, 'tools'));
      for (const name of modules) await writeFile(join(directory, 'packages/portable-core', name), await readFile(join(core, name)));
      await writeFile(join(directory, fixturePaths.input), inputBytes);
      await writeFile(join(directory, 'tools/python-core-helper-driver.py'), await readFile(join(root, 'tools/python-core-helper-driver.py')));
      const observed = capturePython(python.executable, directory); compareObservations(expected.observations, observed.observations);
      assert.equal((await readdir(join(directory, 'packages/portable-core/fixtures'))).includes('core-helper-observations.json'), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
