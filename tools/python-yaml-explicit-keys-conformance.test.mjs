import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, revisionId } from "../packages/kernel/src/canonical.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { readReport } from "../packages/kernel/src/report.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const portable = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
const executable = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
function python(args, input) {
  const result = spawnSync(executable, ["-B", ...args], { cwd: portable, encoding: "utf8", timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024, ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
const cases = JSON.parse(python(["-c", "import json; from test_yaml_explicit_keys import cases; print(json.dumps(cases()))"]).stdout);
const code = `import json,sys
from yaml_authoring import read_authoring_yaml
from stdin_transport import read_bounded_stdin
out=[]
for value in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try: out.append(dict(accepted=True,record=read_authoring_yaml(value['source'])))
 except ValueError as error:
  out.append(dict(accepted=False,code=getattr(error,'code',None),path=getattr(error,'path',None)))
print(json.dumps(out))`;
async function materialize(root, files) {
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
}

test("independent explicit string keys preserve folding, source data and existing guards", () => {
  assert.match(python(["-m", "unittest", "-v", "test_yaml_explicit_keys"]).stderr, /Ran 6 tests/);
});

test("explicit string keys match product values and unchanged authoring diagnostics", async () => {
  const actual = JSON.parse(python(["-c", code], cases).stdout);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-explicit-key-conformance-"));
  let diagnostics = 0;
  try {
    for (let index = 0; index < cases.length; index++) {
      const value = cases[index], path = join(temporary, "record.yaml");
      await writeFile(path, value.source);
      let expected;
      try {
        const record = await readYamlRecord(path);
        canonicalJson(record);
        expected = { accepted: true, record };
      } catch (error) {
        expected = { accepted: false, code: error.code ?? null,
          path: typeof error.path === "string" ? error.path.slice(path.length + 1) : null };
      }
      assert.equal(expected.accepted, value.accepted, value.name);
      assert.equal(actual[index].accepted, expected.accepted, value.name);
      if (value.policyCase) {
        assert.deepEqual(actual[index], expected, value.name);
        if (!value.accepted) diagnostics++;
      } else if (value.accepted) {
        assert.deepEqual(actual[index].record, expected.record, value.name);
        assert.deepEqual(actual[index].record, value.expected, value.name);
      }
      assert.equal(await readFile(path, "utf8"), value.source);
    }
    console.info(`explicit-key cases: ${cases.length}; accepted: ${actual.filter(value => value.accepted).length}; policy diagnostics: ${diagnostics}; differences: 0`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production Python modules read explicit keys with Node and Git absent from PATH", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-explicit-key-isolated-"));
  const implementation = join(temporary, "implementation"), path = join(temporary, "empty-bin");
  try {
    await mkdir(implementation);
    await mkdir(path);
    for (const name of await readdir(portable)) {
      if (name.endsWith(".py") && !name.startsWith("test_")) await copyFile(join(portable, name), join(implementation, name));
    }
    const absolutePython = python(["-c", "import sys; print(sys.executable)"]).stdout.trim();
    const env = { ...process.env, PATH: path, PYTHONPATH: "", PYTHONHOME: "" };
    for (const command of ["node", "git"]) {
      assert.equal(spawnSync(command, ["--version"], { env, timeout: 5000 }).error?.code, "ENOENT");
    }
    const selected = ["compact-bare-indent-0", "surrogates-indent-0", "blank-plain-indent-0", "invalid-7"]
      .map(name => cases.find(value => value.name === name));
    assert(selected.every(Boolean));
    const result = spawnSync(absolutePython, ["-B", "-c", `import sys; sys.path.insert(0,sys.argv[1])\n${code}`, implementation], {
      cwd: temporary, env, input: JSON.stringify(selected), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(python(["-c", code], selected).stdout));
    assert((await readdir(implementation)).every(name => name.endsWith(".py") && !name.startsWith("test_")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("explicit keys keep package, Schema and report values, hashes and source bytes", async () => {
  const packages = JSON.parse(python(["-c", `import json
from test_yaml_explicit_keys import package_cases
from package_validation import validate_package_files
out=[]
for value in package_cases():
 value['result']=validate_package_files(value['files'])
 out.append(value)
print(json.dumps(out))`]).stdout);
  const reports = JSON.parse(python(["-c", `import json
from test_report_records import reports
from test_yaml_explicit_keys import explicit
from report_records import serialize_report_yaml,read_report_source
out=[]
for report in reports():
 baseline=serialize_report_yaml(report)
 for mode in range(4): out.append(dict(source=explicit(baseline,mode),expected=read_report_source(baseline)))
print(json.dumps(out))`]).stdout);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-explicit-key-package-"));
  try {
    for (let index = 0; index < packages.length; index++) {
      const value = packages[index], before = join(temporary, String(index), "before/.morivyx"),
        after = join(temporary, String(index), "after/.morivyx");
      await materialize(before, value.baselineFiles);
      await materialize(after, value.files);
      const { validation, ...expected } = value.result;
      assert.deepEqual(await validatePackage(after), await validatePackage(before), value.name);
      assert.deepEqual(await validatePackage(after), expected, value.name);
      assert.equal(validation.packageValidated, false);
      for (const [root, files] of [[before, value.baselineFiles], [after, value.files]]) {
        for (const [path, source] of Object.entries(files)) assert.equal(await readFile(join(root, path), "utf8"), source);
      }
    }
    for (let index = 0; index < reports.length; index++) {
      const value = reports[index], path = join(temporary, `report-${index}.yaml`);
      await writeFile(path, value.source);
      const actual = await readReport(path);
      assert.equal(canonicalJson(actual.report), canonicalJson(value.expected.report));
      assert.equal(actual.digest, value.expected.digest);
      assert.equal(await readFile(path, "utf8"), value.source);
    }
    console.info(`explicit-key packages: ${packages.length}; reports: ${reports.length}; source files unchanged`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("long plain, quoted, escaped and non-BMP keys survive both writers with the same revision digest", async () => {
  const keys = JSON.parse(python(["-c", "import json; from test_yaml_explicit_keys import long_keys; print(json.dumps(long_keys()))"]).stdout);
  const fixture = JSON.parse(await readFile(new URL("../packages/kernel/test/fixtures/graph-package-roundtrip-vector.json", import.meta.url)));
  const original = fixture.inputLogicalValue.elements[0];
  const records = keys.flatMap(key => ["value", { nested: "value" }, ["one", "two"], [{ [key]: "nested" }]].map(value => {
    const record = { ...original, extensions: { "example.test/key": { [key]: value } } };
    record.revision = revisionId(record);
    return record;
  }));
  const sources = records.map(serializeYamlRecord);
  const actual = JSON.parse(python(["-c", `import json,sys
from canonical import canonical_json,digest
from yaml_records import read_yaml,write_yaml
from stdin_transport import read_bounded_stdin
records,sources=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'))
print(json.dumps(dict(canonical=[canonical_json(read_yaml(s)) for s in sources],
 sources=[write_yaml(v) for v in records],digests=[digest('revision',read_yaml(s))['digest'] for s in sources])))`], [records, sources]).stdout);
  assert.deepEqual(actual.canonical, records.map(canonicalJson));
  assert.deepEqual(actual.digests, records.map(record => record.revision));
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-long-key-writers-"));
  try {
    for (let index = 0; index < records.length; index++) {
      const path = join(temporary, "record.yaml");
      await writeFile(path, actual.sources[index]);
      const record = await readYamlRecord(path);
      assert.equal(canonicalJson(record), canonicalJson(records[index]));
      assert.equal(revisionId(record), records[index].revision);
      assert.equal(await readFile(path, "utf8"), actual.sources[index]);
    }
    console.info(`long-key writer records: ${records.length}; cross-read values and revision digests agree`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
