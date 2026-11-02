import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
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
const cases = JSON.parse(python(["-c", "import json; from test_yaml_key_length import cases; print(json.dumps(cases(),ensure_ascii=False))"]).stdout);
const code = `import json,sys
from canonical import canonical_json
from yaml_authoring import read_authoring_yaml
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try:out.append(dict(accepted=True,canonical=canonical_json(read_authoring_yaml(row['source']))))
 except ValueError:out.append(dict(accepted=False))
print(json.dumps(out,ensure_ascii=False))`;
async function materialize(root, files) {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

test("independent key-length boundaries retain explicit keys, packages and report digests", () => {
  assert.match(python(["-m", "unittest", "-v", "test_yaml_key_length"]).stderr, /Ran 4 tests/);
});

test("source Unicode key-length boundaries agree under both readers in all containers", async () => {
  const actual = [];
  for (let index = 0; index < cases.length; index += 128) {
    actual.push(...JSON.parse(python(["-c", code], cases.slice(index, index + 128)).stdout));
  }
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-length-conformance-"));
  try {
    for (let index = 0; index < cases.length; index++) {
      const row = cases[index], path = join(temporary, "record.yaml");
      await writeFile(path, row.source);
      let expected;
      try { expected = { accepted: true, canonical: canonicalJson(await readYamlRecord(path)) }; }
      catch { expected = { accepted: false }; }
      assert.equal(expected.accepted, row.accepted, row.name);
      assert.deepEqual(actual[index], expected, row.name);
      if (row.accepted) assert.equal(expected.canonical, canonicalJson(row.expected), row.name);
      assert.equal(await readFile(path, "utf8"), row.source);
    }
    console.info(`key-length inputs: ${cases.length}; accepted: ${actual.filter(row => row.accepted).length}; differences: 0`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("package and report source lengths preserve valid logical values and reject over-limit spellings", async () => {
  const packages = JSON.parse(python(["-c", `import json
from test_yaml_key_length import package_cases
from package_validation import validate_package_files
out=[]
for row in package_cases():
 if row['accepted']:row['result']=validate_package_files(row['files'])
 out.append(row)
print(json.dumps(out,ensure_ascii=False))`]).stdout);
  const reports = JSON.parse(python(["-c", `import json
from test_yaml_key_length import report_cases
from report_records import read_report_source
out=[]
for row in report_cases():
 row['result']=read_report_source(row['baseline'])
 out.append(row)
print(json.dumps(out,ensure_ascii=False))`]).stdout);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-length-integration-"));
  try {
    for (let index = 0; index < packages.length; index++) {
      const row = packages[index], before = join(temporary, String(index), "before/.morivyx"),
        after = join(temporary, String(index), "after/.morivyx");
      await materialize(before, row.baselineFiles);
      await materialize(after, row.files);
      if (row.accepted) {
        const actual = await validatePackage(after), { validation, ...expected } = row.result;
        assert.deepEqual(actual, await validatePackage(before), row.name);
        assert.deepEqual(actual, expected, row.name);
        assert.equal(actual.valid, true);
        assert.equal(validation.packageValidated, false);
      } else {
        await assert.rejects(validatePackage(after), { code: "PACKAGE_YAML_INVALID" });
      }
      for (const [root, files] of [[before, row.baselineFiles], [after, row.files]]) {
        for (const [path, source] of Object.entries(files)) assert.equal(await readFile(join(root, path), "utf8"), source);
      }
    }
    for (let index = 0; index < reports.length; index++) {
      const row = reports[index], path = join(temporary, `report-${index}.yaml`);
      await writeFile(path, row.source);
      if (row.accepted) {
        const actual = await readReport(path);
        assert.equal(canonicalJson(actual.report), canonicalJson(row.result.report));
        assert.equal(actual.digest, row.result.digest);
      } else {
        await assert.rejects(readReport(path), { code: "PACKAGE_YAML_INVALID" });
      }
      assert.equal(await readFile(path, "utf8"), row.source);
    }
    console.info(`key-length packages: ${packages.length}; reports: ${reports.length}; input bytes unchanged`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production Python modules enforce source lengths without Node or Git on PATH", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-length-isolated-"));
  const implementation = join(temporary, "implementation"), path = join(temporary, "empty-bin");
  try {
    await mkdir(implementation);
    await mkdir(path);
    for (const name of await readdir(portable)) {
      if (name.endsWith(".py") && !name.startsWith("test_")) await copyFile(join(portable, name), join(implementation, name));
    }
    const absolutePython = python(["-c", "import sys; print(sys.executable)"]).stdout.trim();
    const env = { ...process.env, PATH: path, PYTHONPATH: "", PYTHONHOME: "" };
    for (const command of ["node", "git"]) assert.equal(spawnSync(command, ["--version"], { env, timeout: 5000 }).error?.code, "ENOENT");
    const selected = ["astral-1024-False-root-0", "ascii-1025-False-root-0", "ascii-1025-True-root-0", "nfc-boundary-1023-False-root-0"]
      .map(name => cases.find(row => row.name === name));
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
