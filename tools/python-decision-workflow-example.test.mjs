import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { writeCreatedDecisionPackage } from "../packages/kernel/src/decision-creation.js";
import { writeRevisedDecisionPackage } from "../packages/kernel/src/decision-revision.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/portable-core"), script = join(root, "examples/python-decisions/workflow.py");
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3", limit = 8 * 1024 * 1024;
const vectors = JSON.parse(await readFile(join(core, "fixtures/decision-preparation-vectors.json"), "utf8"));
const base = JSON.parse(await readFile(join(core, "fixtures/portable-cli-vectors.json"), "utf8"));
const files = base.cases.find((entry) => entry.name === "package-read").input;
function run(args, input, options = {}) {
  const result = spawnSync(python, ["-B", ...args], { cwd: root, input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined); return result;
}
async function materialize(directory, mapping) {
  for (const [name, source] of Object.entries(mapping)) { const path = join(directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
}
async function snapshot(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) { const full = join(path, name), key = prefix + name, info = await lstat(full);
      if (info.isDirectory()) await visit(full, key + "/"); else if (info.isSymbolicLink()) result[key] = "SYMLINK"; else result[key] = await readFile(full);
    }
  }
  await visit(directory); return result;
}
async function fixture(callback, mapping = files) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "morivyx-python-workflow-")));
  try {
    const sourceProject = join(directory, "source"), source = join(sourceProject, ".morivyx"); await materialize(source, mapping);
    const before = await snapshot(source);
    await callback({ directory, source, sourceProject, before });
    assert.deepEqual(await snapshot(source), before, "workflow keeps the source bytes unchanged");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function rejected(result, stage) {
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, JSON.stringify({ error: { code: "EXAMPLE_DECISION_FAILED", stage } }) + "\n");
}
async function target(directory, name) { const parent = join(directory, name); await mkdir(parent); return join(parent, ".morivyx"); }

test("Python workflow creates and revises user packages with the same persisted graph as Node", async () => {
  await fixture(async ({ directory, source, sourceProject }) => {
    let pythonSource = source, nodeSource = sourceProject;
    for (const [index, value] of vectors.cases.entries()) {
      const destination = await target(directory, "python-" + index), nodeOutput = join(directory, "node-" + index);
      const result = run([script, value.operation, pythonSource, destination], JSON.stringify(value.request));
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); const receipt = JSON.parse(result.stdout);
      const writer = index === 0 ? writeCreatedDecisionPackage : writeRevisedDecisionPackage;
      const nodeReceipt = await writer({ basePath: nodeSource, outputPath: nodeOutput, request: value.request });
      const actual = await readGraphPackage(dirname(destination)), expected = await readGraphPackage(nodeOutput);
      for (const field of ["elements", "changeSets", "revision", "schemaLock"]) assert.equal(canonicalJson(actual[field]), canonicalJson(expected[field]), field);
      assert.equal(receipt.restored, true); assert.equal(receipt.decisionId, nodeReceipt.decisionId);
      assert.equal(receipt.decisionRevision, value.expected.candidateElement.revision);
      assert.equal(receipt.revision, actual.revision.id); assert.equal(receipt.rootDigest, actual.calculatedRootDigest);
      assert.equal(receipt.schemaLockDigest, actual.calculatedSchemaLockDigest);
      assert.equal(receipt.graphValidation.valid, true); assert.deepEqual(receipt.graphValidation.issues, []);
      const { validation, ...report } = receipt.graphValidation;
      assert.deepEqual(report, await validatePackage(dirname(destination)));
      assert.equal(validation.lifecycleTransitionsCompared, true); assert.equal(validation.approvalAuthorityValidated, false); assert.equal(validation.signaturesValidated, false);
      pythonSource = destination; nodeSource = nodeOutput;
    }
  });
});

test("creation and revision retain every unchanged source byte and report alias", async () => {
  const preserved = structuredClone(files);
  const reportDirectory = join(root, "packages/kernel/test/fixtures/package-v1-roundtrip/.morivyx/reports");
  const report = (await readdir(reportDirectory)).find(name => name.endsWith(".yaml"));
  const alias = "reports/保持する別名.yaml";
  preserved[alias] = (await readFile(join(reportDirectory, report), "utf8")).replace("\n", "\n\n");
  const originalElement = Object.keys(preserved).find(path => path.startsWith("graph/entities/"));
  for (const path of [originalElement, "schema.lock.yaml"]) preserved[path] = preserved[path].replace("\n", "\n\n");
  await fixture(async ({ directory, source, sourceProject }) => {
    let current = source, nodeSource = sourceProject;
    for (const [index, value] of vectors.cases.entries()) {
      const before = await snapshot(current), destination = await target(directory, "retained-" + index);
      const result = run([script, value.operation, current, destination], JSON.stringify(value.request));
      assert.equal(result.status, 0, result.stderr); const receipt = JSON.parse(result.stdout);
      const decisionPath = "graph/entities/" + receipt.decisionId.slice(9) + ".yaml";
      const ledgerPath = "ledger/" + receipt.changeSetId.slice(9) + ".yaml";
      const after = await snapshot(destination);
      for (const [path, body] of Object.entries(before)) {
        if (path !== "revision.yaml" && path !== decisionPath) assert.deepEqual(after[path], body, value.operation + ": retained " + path);
      }
      assert.deepEqual(Object.keys(after).filter(path => !Object.hasOwn(before, path)).sort(),
        (index === 0 ? [decisionPath, ledgerPath] : [ledgerPath]).sort());
      assert.deepEqual(after[alias], Buffer.from(preserved[alias]));
      assert.deepEqual(await snapshot(current), before);
      const writer = index === 0 ? writeCreatedDecisionPackage : writeRevisedDecisionPackage;
      const nodeOutput = join(directory, "node-retained-" + index);
      await writer({ basePath: nodeSource, outputPath: nodeOutput, request: value.request });
      const nodeFiles = await snapshot(join(nodeOutput, ".morivyx"));
      assert.deepEqual(Object.keys(after).sort(), Object.keys(nodeFiles).sort());
      // Node's existing writer reserializes unchanged Graph elements. The
      // Python example retains their spelling; every other file still agrees.
      const differing = Object.keys(after).filter(path => !after[path].equals(nodeFiles[path]));
      assert.deepEqual(differing, [originalElement]);
      const actual = await readGraphPackage(dirname(destination)), expected = await readGraphPackage(nodeOutput);
      for (const field of ["elements", "changeSets", "revision", "schemaLock", "approvals", "migrations"])
        assert.equal(canonicalJson(actual[field]), canonicalJson(expected[field]), field);
      assert.equal(canonicalJson(actual.reports.map(entry => entry.report)), canonicalJson(expected.reports.map(entry => entry.report)));
      const validation = run([join(core, "package_validation.py"), destination, "--previous", current], "");
      assert.equal(validation.status, 0, validation.stderr); assert.equal(JSON.parse(validation.stdout).valid, true);
      current = destination; nodeSource = nodeOutput;
    }
  }, preserved);
});

test("malformed or oversized requests and invalid attributes fail before creating output", async () => {
  await fixture(async ({ directory, source }) => {
    const malformed = ["{", Buffer.from([0xff]), '{"format":"a","format":"b"}', " ".repeat(limit + 1)];
    const absent = structuredClone(vectors.cases[0].request); delete absent.actor;
    const invalidAttributes = { ...vectors.cases[0].request, attributes: {} };
    const cases = [...malformed.map((input) => ({ input, stage: "input" })), { input: JSON.stringify(absent), stage: "prepare" }, { input: JSON.stringify(invalidAttributes), stage: "validation" }];
    for (const [index, value] of cases.entries()) {
      const destination = await target(directory, "invalid-" + index);
      rejected(run([script, "create", source, destination], value.input), value.stage);
      assert.deepEqual(await readdir(dirname(destination)), []);
    }
  });
});

test("source structures, stored digests and Graph constraints are checked before output", async () => {
  await fixture(async ({ directory }) => {
    const code = `import json,sys
sys.path.insert(0,sys.argv[1])
from canonical import digest
from package_records import read_package_files,write_package_files
contents=read_package_files(json.load(sys.stdin));contents['elements'][0]['attributes']={}
contents['elements'][0]['revision']=digest('revision',contents['elements'][0])['digest']
contents['revision']['rootDigest']=digest('root',contents['elements'])['digest']
print(json.dumps(write_package_files(contents)))`;
    const generated = run(["-c", code, core], JSON.stringify(files)); assert.equal(generated.status, 0, generated.stderr);
    const badSource = [ { ...files, "revision.yaml": "{}\n" }, JSON.parse(generated.stdout) ];
    const wrongDigest = structuredClone(files); wrongDigest["revision.yaml"] = wrongDigest["revision.yaml"].replace(/sha256:[0-9a-f]{64}/, "sha256:" + "0".repeat(64)); badSource.push(wrongDigest);
    for (const [index, mapping] of badSource.entries()) {
      const source = join(directory, "bad-source-" + index); await materialize(source, mapping); const before = await snapshot(source);
      const destination = await target(directory, "source-refused-" + index);
      rejected(run([script, "create", source, destination], JSON.stringify(vectors.cases[0].request)), "source");
      assert.deepEqual(await snapshot(source), before); assert.deepEqual(await readdir(dirname(destination)), []);
    }
  });
});

test("existing destinations, links and unavailable parents are refused without replacement", async () => {
  await fixture(async ({ directory, source }) => {
    const existing = join(directory, "existing"); await mkdir(existing); await writeFile(join(existing, "keep"), "unchanged");
    const regular = join(directory, "regular"); await writeFile(regular, "unchanged");
    const linked = join(directory, "linked"), dangling = join(directory, "dangling"); await symlink(existing, linked); await symlink(join(directory, "absent"), dangling);
    const before = await snapshot(existing);
    const destinations = [source, join(source, "nested"), join(source, "missing/nested"), existing, regular, linked, dangling, join(directory, "missing/new"), join(linked, "new")];
    let caseAliasChecked = false;
    try {
      const alias = source.toUpperCase(), originalInfo = await lstat(source), aliasInfo = await lstat(alias);
      if (aliasInfo.dev === originalInfo.dev && aliasInfo.ino === originalInfo.ino) { destinations.push(join(alias, "nested-case-alias")); caseAliasChecked = true; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const destination of destinations) {
      rejected(run([script, "create", source, destination], JSON.stringify(vectors.cases[0].request)), "restore");
    }
    console.info(`Protected destination variants: ${destinations.length}; case alias checked: ${caseAliasChecked}`);
    assert.deepEqual(await snapshot(existing), before); assert.equal(await readFile(regular, "utf8"), "unchanged");
  });
});

test("success output is bounded before any destination is created", async () => {
  await fixture(async ({ directory, source }) => {
    const request = { ...vectors.cases[0].request, resultingRevision: "graph:" + "a".repeat(4_300_000) };
    const destination = await target(directory, "oversized-output");
    rejected(run([script, "create", source, destination], JSON.stringify(request)), "output");
    assert.deepEqual(await readdir(dirname(destination)), []);
  });
});

test("interrupted restore leaves an unreadable marked output and no success response", async () => {
  await fixture(async ({ directory, source }) => {
    const destination = await target(directory, "interrupted");
    const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('workflow',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
import package_restore
original=package_restore._write_file;count=0
def interrupted(*args):
 global count
 count+=1
 if count==2:raise OSError('NEVER_ECHO_INTERNAL_FAILURE')
 return original(*args)
package_restore._write_file=interrupted
sys.argv=[sys.argv[1],'create',sys.argv[2],sys.argv[3]]
sys.exit(module.main())`;
    rejected(run(["-c", code, script, source, destination], JSON.stringify(vectors.cases[0].request)), "restore");
    assert.equal((await lstat(join(destination, ".morivyx-restore-incomplete"))).isSymbolicLink(), true);
    await assert.rejects(readGraphPackage(dirname(destination)));
    const checked = run([join(core, "package_records.py"), destination], ""); assert.equal(checked.status, 1); assert.equal(checked.stdout, "");
    const before = await snapshot(destination);
    rejected(run([script, "create", source, destination], JSON.stringify(vectors.cases[0].request)), "restore");
    assert.deepEqual(await snapshot(destination), before);
  });
});

test("copied example and public Core create and revise without Node, Git or a checkout", async () => {
  await fixture(async ({ directory, source }) => {
    const runtime = join(directory, "runtime"), copiedCore = join(runtime, "packages/portable-core"), copiedScript = join(runtime, "examples/python-decisions/workflow.py"), empty = join(directory, "empty-bin");
    await mkdir(copiedCore, { recursive: true }); await mkdir(dirname(copiedScript), { recursive: true }); await mkdir(empty);
    for (const name of await readdir(core)) if (name.endsWith(".py") && !name.startsWith("test_") && !["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"].includes(name)) await copyFile(join(core, name), join(copiedCore, name));
    await copyFile(script, copiedScript);
    const executable = run(["-c", "import sys;print(sys.executable)"], "").stdout.trim();
    const env = { ...process.env, PATH: empty, PYTHONPATH: "", PYTHONNOUSERSITE: "1" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env }).error?.code, "ENOENT");
    let current = source;
    for (const [index, value] of vectors.cases.entries()) {
      const destination = await target(directory, "isolated-" + index);
      const result = spawnSync(executable, ["-B", copiedScript, value.operation, current, destination], { cwd: runtime, env, input: JSON.stringify(value.request), encoding: "utf8", timeout: 60_000, maxBuffer: limit });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.restored, true); assert.equal(receipt.decisionRevision, value.expected.candidateElement.revision);
      assert.equal(receipt.rootDigest, (await readGraphPackage(dirname(destination))).calculatedRootDigest); current = destination;
    }
  });
});
