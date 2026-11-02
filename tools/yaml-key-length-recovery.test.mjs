import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { readReport } from "../packages/kernel/src/report.js";
import { validatePackage } from "../packages/kernel/src/validator.js";

const portable = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
const executable = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
function python(code, input) {
  const result = spawnSync(executable, ["-B", "-c", code], { cwd: portable, encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function materialize(root, files) {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source, { flag: "wx" });
  }
}
// The documentation describes this edit. Only synthetic fixture sources are
// edited here; this is not a converter that reads or rewrites user files.
function explicitCopy(source, keySpelling) {
  const lines = source.split("\n");
  const index = lines.findIndex(line => line.trimStart().startsWith(keySpelling + ":"));
  assert(index >= 0);
  const line = lines[index], indent = line.slice(0, line.length - line.trimStart().length);
  const value = line.slice(indent.length + keySpelling.length + 1);
  lines.splice(index, 1, indent + "? " + keySpelling, indent + ":" + value);
  return lines.join("\n");
}

test("explicit copies recover over-limit package and report spellings without changing stored digests or originals", async () => {
  const fixture = python(`import json
from test_yaml_key_length import package_cases,report_cases
from package_validation import validate_package_files
from report_records import read_report_source
p=next(row for row in package_cases() if row['name']=='astral-1025')
r=next(row for row in report_cases() if row['name']=='report-0-1025')
p['expected']=validate_package_files(p['baselineFiles'])
r['expected']=read_report_source(r['baseline'])
print(json.dumps(dict(package=p,report=r),ensure_ascii=False))`);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-length-recovery-"));
  const original = join(temporary, "original/.morivyx"), recovered = join(temporary, "recovered/.morivyx");
  const originalReport = join(temporary, "original-report.yaml"), recoveredReport = join(temporary, "recovered-report.yaml");
  try {
    const files = fixture.package.files;
    await materialize(original, files);
    await writeFile(originalReport, fixture.report.source, { flag: "wx" });
    await assert.rejects(validatePackage(original), { code: "PACKAGE_YAML_INVALID" });
    await assert.rejects(readReport(originalReport), { code: "PACKAGE_YAML_INVALID" });
    const entityPath = Object.keys(files).find(path => path.startsWith("graph/entities/"));
    const recoveredFiles = { ...files, [entityPath]: explicitCopy(files[entityPath], "😀".repeat(1025)) };
    const reportSource = explicitCopy(fixture.report.source, "format" + " ".repeat(1019));
    await materialize(recovered, recoveredFiles);
    await writeFile(recoveredReport, reportSource, { flag: "wx" });
    const actual = await validatePackage(recovered), { validation, ...expected } = fixture.package.expected;
    assert.deepEqual(actual, expected);
    assert.equal(actual.valid, true);
    assert.equal(validation.packageValidated, false);
    const report = await readReport(recoveredReport);
    assert.equal(canonicalJson(report.report), canonicalJson(fixture.report.expected.report));
    assert.equal(report.digest, fixture.report.expected.digest);
    const independent = python(`import json,sys
from stdin_transport import read_bounded_stdin
from package_validation import validate_package_files
from report_records import read_report_source
v=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'))
print(json.dumps(dict(package=validate_package_files(v['files']),report=read_report_source(v['report']))))`,
    { files: recoveredFiles, report: reportSource });
    assert.deepEqual(independent.package, fixture.package.expected);
    assert.deepEqual(independent.report, fixture.report.expected);
    assert.equal(recoveredFiles["revision.yaml"], files["revision.yaml"]);
    assert.equal(recoveredFiles["schema.lock.yaml"], files["schema.lock.yaml"]);
    for (const [path, source] of Object.entries(files)) assert.equal(await readFile(join(original, path), "utf8"), source);
    assert.equal(await readFile(originalReport, "utf8"), fixture.report.source);
    await assert.rejects(validatePackage(original), { code: "PACKAGE_YAML_INVALID" });
    await assert.rejects(readReport(originalReport), { code: "PACKAGE_YAML_INVALID" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
