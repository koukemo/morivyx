import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../packages/kernel/node_modules/yaml/dist/index.js";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { readReport } from "../packages/kernel/src/report.js";
import { validatePackage } from "../packages/kernel/src/validator.js";
import { yamlKeyStyleCases } from "../packages/kernel/test-support/yaml-key-style-cases.mjs";

const portable = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
function python(code, input) {
  const result = spawnSync(process.env.MORIVYX_REFERENCE_PYTHON ?? "python3", ["-B", "-c", code], {
    cwd: portable, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test("both readers reject block scalar keys and preserve valid quoted keys", async () => {
  const cases = yamlKeyStyleCases();
  const actual = python(`import json,sys
from yaml_records import read_yaml
from canonical import canonical_json
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try:out.append(dict(accepted=True,canonical=canonical_json(read_yaml(row['source']))))
 except ValueError:out.append(dict(accepted=False))
print(json.dumps(out))`, cases);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-style-cross-"));
  try {
    for (let index = 0; index < cases.length; index++) {
      const row = cases[index], path = join(temporary, "record.yaml");
      await writeFile(path, row.source);
      assert.equal(actual[index].accepted, row.accepted, row.name);
      if (row.accepted) {
        assert.equal(canonicalJson(await readYamlRecord(path)), canonicalJson(row.expected));
        assert.equal(actual[index].canonical, canonicalJson(row.expected));
      } else await assert.rejects(readYamlRecord(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" });
      assert.equal(await readFile(path, "utf8"), row.source);
    }
    console.info(`key-style cases: ${cases.length}; forbidden: ${cases.filter(row => !row.accepted).length}; differences: 0`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

function blockFormat(source, style) { return source.replace(/^format:/, `? ${style}\n  format\n:`); }
test("packages and reports cannot bypass the authoring profile with equivalent block keys", async () => {
  const fixture = python(`import json
from test_package_export import cases
from test_report_records import reports
from report_records import serialize_report_yaml
print(json.dumps(dict(files=next(row['files'] for row in cases() if row['name']=='valid-core'),reports=[serialize_report_yaml(row) for row in reports()])))`);
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-key-style-package-"));
  const requests = [];
  try {
    for (const style of ["|-", ">-"]) {
      const files = { ...fixture.files }, entity = Object.keys(files).find(path => path.startsWith("graph/entities/"));
      files[entity] = blockFormat(files[entity], style);
      assert.deepEqual(parseDocument(files[entity]).toJS(), parseDocument(fixture.files[entity]).toJS());
      const root = join(temporary, style[0] === "|" ? "literal" : "folded", ".morivyx");
      for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), source);
      }
      await assert.rejects(validatePackage(root), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" });
      requests.push({ files });
      for (const [path, source] of Object.entries(files)) assert.equal(await readFile(join(root, path), "utf8"), source);
      for (let index = 0; index < fixture.reports.length; index++) {
        const source = blockFormat(fixture.reports[index], style), path = join(root, `report-${index}.yaml`);
        assert.deepEqual(parseDocument(source).toJS(), parseDocument(fixture.reports[index]).toJS());
        await writeFile(path, source);
        await assert.rejects(readReport(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" });
        requests.push({ report: source });
        assert.equal(await readFile(path, "utf8"), source);
      }
    }
    const actual = python(`import json,sys
from package_records import read_package_files
from report_records import read_report_source
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try:
  read_package_files(row['files']) if 'files' in row else read_report_source(row['report'])
  out.append(True)
 except ValueError:out.append(False)
print(json.dumps(out))`, requests);
    assert.deepEqual(actual, requests.map(() => false));
    console.info(`key-style packages: 2; reports: ${fixture.reports.length * 2}; equivalent logical values still refused`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
