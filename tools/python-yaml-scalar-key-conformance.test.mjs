import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, graphRootDigest, revisionId, schemaDefinitionDigest, schemaLockDigest } from "../packages/kernel/src/canonical.js";
import { readGraphPackage, readYamlRecord } from "../packages/kernel/src/package-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { validatePackage } from "../packages/kernel/src/validator.js";
import { yamlScalarKeyCases } from "../packages/kernel/test-support/yaml-scalar-key-cases.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
function execute(args, input) {
  const result = spawnSync(process.env.MORIVYX_REFERENCE_PYTHON ?? "python3", ["-B", ...args], {
    cwd: join(repository, "packages/portable-core"), input, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("both readers use exact scalar key resolution and preserve value restrictions", async () => {
  const rows = yamlScalarKeyCases();
  assert.equal(new Set(rows.map(row => row.source)).size, rows.length);
  const actual = execute(["-c", `import json,sys
from yaml_records import read_yaml
from canonical import canonical_json
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode()):
 try:out.append(dict(accepted=True,canonical=canonical_json(read_yaml(row['source']))))
 except ValueError:out.append(dict(accepted=False))
print(json.dumps(out))`], JSON.stringify(rows));
  assert.equal(actual.length, rows.length);
  const root = await mkdtemp(join(tmpdir(), "morivyx-scalar-key-cross-"));
  try {
    const path = join(root, "record.yaml");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; await writeFile(path, row.source);
      assert.equal(actual[i].accepted, row.accepted, row.name);
      if (row.accepted) {
        assert.equal(actual[i].canonical, canonicalJson(row.expected), row.name);
        assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      } else await assert.rejects(readYamlRecord(path), error => error.code?.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source);
    }
    console.info(`scalar key cases: ${rows.length}; accepted: ${rows.filter(row => row.accepted).length}; differences: 0`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const stringKeys = new Set([".nAn", ".Nan", ".nAN", ".iNF", "+.iNf", "-.iNf", "+0o7", "-0o7", "+0xAf", "-0xAf", "+.nan", "-.NaN"]);
function renderKeys(source, style) {
  return source.split("\n").map(line => {
    const match = /^( *)(?:"([^"]+)"|([^:]+)): ("value")$/.exec(line);
    if (!match) return line;
    const [, spaces, quoted, plain, value] = match, key = quoted ?? plain;
    if (!stringKeys.has(key)) return line;
    if (style === "double") return `${spaces}${JSON.stringify(key)}: ${value}`;
    if (style === "single") return `${spaces}'${key}': ${value}`;
    if (style === "explicit") return `${spaces}? ${key}\n${spaces}: ${value}`;
    return `${spaces}${key}: ${value}`;
  }).join("\n");
}

test("physical packages preserve mixed-case and signed-base string keys with unchanged digests", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-scalar-key-package-")));
  try {
    const base = join(root, "base"), metadata = join(base, ".morivyx");
    await mkdir(join(metadata, "graph/entities"), { recursive: true }); await mkdir(join(metadata, "schemas"));
    const schema = await readYamlRecord(join(repository, "docs/schema/morivyx.core@0.1.yaml"));
    const keys = Object.fromEntries([...stringKeys, ".nan", ".inf", "0o7", "0xAf"].map(key => [key, "value"]));
    const element = { format: "morivyx.git-graph/0.1", kind: "entity", id: "urn:uuid:00000000-0000-4000-8000-000000000001",
      type: "core.artifact", typeVersion: "0.1", lifecycle: "draft", reviewState: "unreviewed",
      attributes: { artifactKind: "document", uri: "urn:example:scalar-keys" },
      provenance: { method: "asserted", actor: "urn:uuid:00000000-0000-4000-8000-000000000009", recordedAt: "2026-11-02T00:00:00Z" },
      extensions: { "example.test/scalar-keys": { keys, rows: [keys] } } };
    element.revision = revisionId(element);
    const lock = { format: "morivyx.schema-lock/0.1", stableIdScheme: "urn-uuid-v4", digestAlgorithm: "sha256",
      schemas: [{ schemaId: schema.schemaId, version: schema.version, digest: schemaDefinitionDigest(schema) }] };
    const revision = { format: "morivyx.graph-revision/0.1", id: "graph:scalar-keys", parentRevision: null,
      rootDigest: graphRootDigest([element]), schemaLockDigest: schemaLockDigest(lock) };
    const entityPath = "graph/entities/00000000-0000-4000-8000-000000000001.yaml";
    for (const [name, value] of [[entityPath, element], ["revision.yaml", revision], ["schema.lock.yaml", lock], ["schemas/morivyx.core@0.1.yaml", schema]]) {
      await writeFile(join(metadata, name), renderKeys(serializeYamlRecord(value), "double"));
    }
    const original = await readFile(join(metadata, entityPath), "utf8");
    const expected = await readGraphPackage(base);
    assert.equal((await validatePackage(base)).valid, true);
    assert.equal(execute(["package_validation.py", metadata]).valid, true);
    for (const style of ["plain", "explicit", "single"]) {
      const target = join(root, style); await cp(base, target, { recursive: true });
      const directory = join(target, ".morivyx"), path = join(directory, entityPath), source = renderKeys(original, style);
      assert.notEqual(source, original);
      await writeFile(path, source);
      const node = await readGraphPackage(target), independent = execute(["package_records.py", directory, "--export"]);
      for (const field of ["schemaLock", "revision", "elements"]) {
        assert.deepEqual(node[field], expected[field]); assert.deepEqual(independent[field], expected[field]);
      }
      assert.equal(node.calculatedRootDigest, expected.calculatedRootDigest);
      assert.equal(independent.calculatedRootDigest, expected.calculatedRootDigest);
      assert.equal(independent.calculatedSchemaLockDigest, expected.calculatedSchemaLockDigest);
      assert.equal((await validatePackage(target)).valid, true);
      assert.equal(execute(["package_validation.py", directory]).valid, true);
      assert.equal(await readFile(path, "utf8"), source);
    }
    assert.equal(await readFile(join(metadata, entityPath), "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
