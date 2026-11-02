import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../packages/kernel/src/canonical.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { yamlFoldingCases } from "../packages/kernel/test-support/yaml-folding-cases.mjs";

test("both readers match explicit folding expectations and preserve every source", async () => {
  const cases = yamlFoldingCases();
  const child = spawnSync(process.env.MORIVYX_REFERENCE_PYTHON ?? "python3", ["-B", "-c", `import json,sys
from yaml_records import read_yaml
from canonical import canonical_json
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode('utf-8')):
 try:out.append(dict(accepted=True,canonical=canonical_json(read_yaml(row['source']))))
 except ValueError:out.append(dict(accepted=False))
print(json.dumps(out))`], {
    cwd: fileURLToPath(new URL("../packages/portable-core/", import.meta.url)),
    input: JSON.stringify(cases), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.equal(results.length, cases.length);
  const directory = await mkdtemp(join(tmpdir(), "morivyx-folding-cross-"));
  try {
    for (let i = 0; i < cases.length; i++) {
      const row = cases[i], path = join(directory, "record.yaml");
      await writeFile(path, row.source);
      assert.equal(results[i].accepted, row.accepted, row.name);
      if (row.accepted) {
        const expected = canonicalJson(row.expected);
        assert.equal(results[i].canonical, expected, row.name);
        assert.equal(canonicalJson(await readYamlRecord(path)), expected, row.name);
      } else if (/surrogate|unit-escape/.test(row.name) && !row.name.includes("-implicit-key-")) await assert.rejects(readYamlRecord(path), { code: "PACKAGE_AUTHORING_PROFILE_INVALID" }, row.name);
      else await assert.rejects(readYamlRecord(path), error => typeof error.code === "string" && error.code.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source, row.name);
    }
    console.info(`folding cases: ${cases.length}; accepted: ${cases.filter(row => row.accepted).length}; differences: 0`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
