import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, graphRootDigest, revisionId, schemaDefinitionDigest, schemaLockDigest } from "../packages/kernel/src/canonical.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { readYamlRecord } from "../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";
import { validatePackage } from "../packages/kernel/src/validator.js";
import { yamlSequenceSpacingCases } from "../packages/kernel/test-support/yaml-sequence-spacing-cases.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.MORIVYX_REFERENCE_PYTHON ?? "python3";
function execute(args, input) {
  const result = spawnSync(python, ["-B", ...args], { cwd: join(repository, "packages/portable-core"),
    input, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("both readers preserve sequence spacing values, rejection boundaries and source bytes", async () => {
  const rows = yamlSequenceSpacingCases();
  const values = execute(["-c", `import json,sys
from yaml_records import read_yaml
from canonical import canonical_json
from stdin_transport import read_bounded_stdin
out=[]
for row in json.loads(read_bounded_stdin(sys.stdin.buffer,8*1024*1024).decode()):
 try:out.append(dict(accepted=True,canonical=canonical_json(read_yaml(row['source']))))
 except ValueError:out.append(dict(accepted=False))
print(json.dumps(out))`], JSON.stringify(rows));
  assert.equal(values.length, rows.length);
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-sequence-cross-")));
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], path = join(root, "record.yaml"); await writeFile(path, row.source);
      assert.equal(values[i].accepted, row.accepted, row.name);
      if (row.accepted) {
        assert.equal(values[i].canonical, canonicalJson(row.expected), row.name);
        assert.deepEqual(await readYamlRecord(path), row.expected, row.name);
      } else await assert.rejects(readYamlRecord(path), error => error.code?.startsWith("PACKAGE_"), row.name);
      assert.equal(await readFile(path, "utf8"), row.source, row.name);
    }
    console.info(`sequence spacing: ${rows.length} cases; ${rows.filter(row => row.accepted).length} accepted; differences 0`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sequence spacing in physical packages preserves both digests and semantic validation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "morivyx-sequence-package-")));
  try {
    const fixture = join(root, "base"), metadata = join(fixture, ".morivyx");
    await mkdir(join(metadata, "graph/entities"), { recursive: true });
    await mkdir(join(metadata, "schemas"));
    const definition = await readYamlRecord(join(repository, "docs/schema/morivyx.core@0.1.yaml"));
    const element = { format: "morivyx.git-graph/0.1", kind: "entity",
      id: "urn:uuid:00000000-0000-4000-8000-000000000001", type: "core.artifact", typeVersion: "0.1",
      lifecycle: "draft", reviewState: "unreviewed", attributes: { artifactKind: "document", uri: "urn:example:spacing" },
      provenance: { method: "asserted", actor: "urn:uuid:00000000-0000-4000-8000-000000000009", recordedAt: "2026-11-02T00:00:00Z" },
      extensions: { "example.test/spacing": { ordered: ["  A  ", "B"] } } };
    element.revision = revisionId(element);
    const lock = { format: "morivyx.schema-lock/0.1", stableIdScheme: "urn-uuid-v4", digestAlgorithm: "sha256",
      schemas: [{ schemaId: definition.schemaId, version: definition.version, digest: schemaDefinitionDigest(definition) }] };
    const revision = { format: "morivyx.graph-revision/0.1", id: "graph:sequence-spacing", parentRevision: null,
      rootDigest: graphRootDigest([element]), schemaLockDigest: schemaLockDigest(lock) };
    for (const [name, value] of [["graph/entities/00000000-0000-4000-8000-000000000001.yaml", element],
      ["revision.yaml", revision], ["schema.lock.yaml", lock], ["schemas/morivyx.core@0.1.yaml", definition]]) {
      await writeFile(join(metadata, name), serializeYamlRecord(value));
    }
    assert.equal((await validatePackage(fixture)).valid, true);
    const expected = await readGraphPackage(fixture);
    for (const width of [1, 2, 5]) {
      const target = join(root, `package-${width}`); await cp(fixture, target, { recursive: true });
      const metadata = join(target, ".morivyx");
      const entityDirectory = join(metadata, "graph/entities"), sources = new Map();
      for (const name of await readdir(entityDirectory)) {
        const path = join(entityDirectory, name);
        const source = (await readFile(path, "utf8")).replace(/^( *)- (?=")/gmu, `$1-${" ".repeat(width)}`);
        await writeFile(path, source); sources.set(path, source);
      }
      const lockPath = join(metadata, "schema.lock.yaml");
      const lock = (await readFile(lockPath, "utf8")).replace(/^  - /mu, `  -${" ".repeat(width)}`)
        .replace(/^    (?=(?:version|digest):)/gmu, " ".repeat(3 + width));
      await writeFile(lockPath, lock); sources.set(lockPath, lock);
      const node = await readGraphPackage(target), decoded = execute(["package_records.py", metadata, "--export"]);
      const validation = await validatePackage(target);
      assert.equal(validation.valid, true, JSON.stringify(validation));
      assert.equal(execute(["package_validation.py", metadata]).valid, true);
      assert.equal(decoded.calculatedRootDigest, expected.calculatedRootDigest);
      assert.equal(decoded.calculatedSchemaLockDigest, expected.calculatedSchemaLockDigest);
      assert.equal(node.calculatedRootDigest, expected.calculatedRootDigest);
      assert.deepEqual(decoded.elements, expected.elements);
      for (const [path, source] of sources) assert.equal(await readFile(path, "utf8"), source);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
