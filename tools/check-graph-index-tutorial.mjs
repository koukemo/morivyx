import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphIndex, graphIndexSnapshot, verifyGraphIndex } from "../packages/kernel/src/graph-index.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.argv[2] ?? "python3";
const temporary = await realpath(await mkdtemp(join(tmpdir(), "morivyx-index-tutorial-")));
const sample = join(temporary, "sample with spaces");
const cli = "packages/kernel/src/cli.js";
const identity = suffix => `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
const node = (...args) => execute(process.execPath, args);
async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(child) : (await readFile(child)).toString("base64");
  }
  return files;
}
try {
  node("examples/getting-started/prepare.mjs", sample);
  const base = join(sample, "base"), after = join(sample, "after"), linked = join(sample, "linked");
  node(cli, "create-decision", base, join(sample, "decision.yaml"), after);
  assert.equal(node("examples/getting-started/link.mjs", after, linked).elementCount, 7);
  const before = await snapshot(sample);
  const contents = await readGraphPackage(linked);
  const source = { graphRevision: contents.revision.id, elements: contents.elements };
  const sourceBefore = structuredClone(source);
  const expected = graphIndexSnapshot(buildGraphIndex(source));
  assert.equal(expected.rootDigest, contents.revision.rootDigest);
  const cliIndex = node(cli, "reindex", linked);
  assert.equal(cliIndex.valid, true);
  assert.deepEqual(cliIndex.index, expected);
  const queries = [["core.decision", identity(1)], ["core.observation", identity(2)], ["example.absent", identity(99)]];
  const results = [];
  for (const [type, focus] of queries) {
    const result = node("examples/graph-index/read.mjs", linked, type, focus);
    assert.equal(result.valid, true);
    assert.deepEqual(result.index, expected);
    const portable = execute(python, ["-I", "-B", "examples/graph-index/read.py", join(linked, ".morivyx"), type, focus]);
    assert.deepEqual(portable, result);
    results.push(result);
  }
  assert.deepEqual(results[0].query.elementIds, [identity(2)]);
  assert.deepEqual(results[0].query.incomingRelationIds, [identity(21)]);
  assert.deepEqual(results[0].query.outgoingRelationIds, []);
  assert.deepEqual(results[1].query.elementIds, [identity(11), identity(12)]);
  assert.deepEqual(results[1].query.outgoingRelationIds, [identity(21), identity(22), identity(23)]);
  assert.equal(results[2].query.focusExists, false);
  assert.deepEqual(results[2].query.elementIds, []);
  assert.deepEqual(results[2].query.incomingRelationIds, []);
  assert.deepEqual(results[2].query.outgoingRelationIds, []);
  const damaged = buildGraphIndex(source);
  damaged.byType.set("core.decision", []);
  assert.equal(verifyGraphIndex(damaged, source).valid, false);
  const bodyOnly = buildGraphIndex(source), originalUri = bodyOnly.byId.get(identity(1)).attributes.uri;
  bodyOnly.byId.get(identity(1)).attributes.uri = "urn:morivyx:example:cached-body-changed";
  assert.equal(verifyGraphIndex(bodyOnly, source).valid, true, "element body is outside the verified projection");
  assert.equal(buildGraphIndex(source).byId.get(identity(1)).attributes.uri, originalUri);
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(await snapshot(sample), before);

  // Carry only production Python files and this example into a separate layout.
  const bundle = join(temporary, "independent bundle"), modules = join(bundle, "packages/portable-core");
  const entry = join(bundle, "examples/graph-index/read.py"), packageRoot = join(bundle, "input/.morivyx");
  const emptyPath = join(bundle, "empty path");
  await mkdir(modules, { recursive: true });
  await mkdir(join(bundle, "examples/graph-index"), { recursive: true });
  await mkdir(emptyPath);
  const production = (await readdir(join(repository, "packages/portable-core")))
    .filter(name => name.endsWith(".py") && !name.startsWith("test_"));
  for (const name of production) await cp(join(repository, "packages/portable-core", name), join(modules, name));
  await cp(join(repository, "examples/graph-index/read.py"), entry);
  await cp(join(linked, ".morivyx"), packageRoot, { recursive: true });
  await rm(sample, { recursive: true });
  const bundleBefore = await snapshot(bundle);
  const environment = { ...process.env, PATH: emptyPath };
  // Resolve the interpreter before clearing PATH; never ask a shell to locate it.
  const executable = execute(python, ["-I", "-B", "-c", "import json,sys;print(json.dumps(sys.executable))"]);
  for (let index = 0; index < queries.length; index++) {
    const [type, focus] = queries[index];
    assert.deepEqual(execute(executable, ["-I", "-B", entry, packageRoot, type, focus], { cwd: bundle, env: environment }), results[index]);
  }
  const probe = `import json,sys
sys.path.insert(0,sys.argv[1])
from graph_index import build_graph_index,verify_graph_index
from package_records import read_package
p=read_package(sys.argv[2]);s=dict(graphRevision=p['revision']['id'],elements=p['elements'])
i=build_graph_index(s);i['byType']['core.decision']=[]
damaged=not verify_graph_index(i,s)['valid']
i=build_graph_index(s);key=sys.argv[3];uri=i['byId'][key]['attributes']['uri']
i['byId'][key]['attributes']['uri']='urn:morivyx:example:cached-body-changed'
print(json.dumps(dict(damagedRejected=damaged,bodyOutsideProjection=verify_graph_index(i,s)['valid'],freshBodyRestored=build_graph_index(s)['byId'][key]['attributes']['uri']==uri)))`;
  assert.deepEqual(execute(executable, ["-I", "-B", "-c", probe, modules, packageRoot, identity(1)], { cwd: bundle, env: environment }),
    { damagedRejected: true, bodyOutsideProjection: true, freshBodyRestored: true });
  assert.deepEqual(await snapshot(bundle), bundleBefore);
  console.log(JSON.stringify({ valid: true, elements: 7, queries: queries.length, pythonModules: production.length,
    cliAndBothReadersMatch: true, sourceUnchangedBeforeRemoval: true, storedRootDigestMatches: true,
    damagedProjectionRefused: true, cachedBodyOutsideProjection: true, rebuiltBodyMatchesSource: true,
    originalSampleRemovedBeforeIndependentRead: true, independentFilesUnchanged: true,
    nodeAndGitAbsentFromChildPath: true, node: process.version, python: executable }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
