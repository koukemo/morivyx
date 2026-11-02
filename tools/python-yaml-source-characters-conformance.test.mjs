import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { yamlSourceCharacterCases } from "../packages/kernel/test-support/yaml-source-character-cases.mjs";

const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
const portable = fileURLToPath(new URL("../packages/portable-core/", import.meta.url));
function run(args, input) {
  const result = spawnSync(python, ["-B", ...args], { cwd: portable, encoding: "utf8", timeout: 30000, input, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("YAML source character acceptance and normalization agree for all 567 boundary cases", async () => {
  const own = run(["-m", "unittest", "-v", "test_yaml_source_characters"]);
  assert.match(own.stderr, /Ran 3 tests/);
  const cases = yamlSourceCharacterCases();
  assert.equal(cases.length, 567);
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-source-"));
  try {
    const path = join(directory, "record.yaml"), expected = [];
    for (const { source } of cases) {
      await writeFile(path, source);
      try { expected.push({ valid: true, canonical: canonicalJson(await readYamlRecord(path)) }); }
      catch { expected.push({ valid: false }); }
    }
    const result = run(["-c", `import json,sys
from canonical import canonical_json
from yaml_records import read_yaml
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try:out.append(dict(valid=True,canonical=canonical_json(read_yaml(row['source']))))
 except ValueError:out.append(dict(valid=False))
print(json.dumps(out))`], JSON.stringify(cases));
    assert.deepEqual(JSON.parse(result.stdout), expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both YAML writers preserve all escaped control values under both readers", async () => {
  const sample = JSON.parse(readFileSync(new URL("../packages/kernel/test/fixtures/graph-package-roundtrip-vector.json", import.meta.url))).inputLogicalValue.elements[0];
  const points = [...Array.from({ length: 32 }, (_, index) => index), ...Array.from({ length: 33 }, (_, index) => index + 0x7f), 0xfffe, 0xffff];
  const records = points.map((point) => { const c = String.fromCodePoint(point); return { ...sample, attributes: { [`a${c}b`]: `\\a${c}b\\` } }; });
  const sources = records.map(serializeYamlRecord);
  const result = run(["-c", `import json,sys
from canonical import canonical_json
from yaml_records import read_yaml,write_yaml
from stdin_transport import read_bounded_stdin
records,sources=json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8'))
print(json.dumps(dict(canonical=[canonical_json(read_yaml(s)) for s in sources],sources=[write_yaml(v) for v in records])))`], JSON.stringify([records, sources]));
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.canonical, records.map(canonicalJson));
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-output-"));
  try {
    for (let index = 0; index < records.length; index += 1) {
      assert.doesNotMatch(actual.sources[index], /[\x00-\x09\x0b-\x1f\x7f-\x9f\ufffe\uffff]/u);
      const path = join(directory, "record.yaml");
      await writeFile(path, actual.sources[index]);
      assert.equal(canonicalJson(await readYamlRecord(path)), canonicalJson(records[index]));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
