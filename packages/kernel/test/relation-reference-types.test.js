import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { graphRootDigest, revisionId, schemaDefinitionDigest, schemaLockDigest } from "../src/canonical.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";
import { validateGraph } from "../src/validator.js";

const schema = await readYamlRecord(fileURLToPath(new URL("../../../docs/schema/morivyx.core@0.1.yaml", import.meta.url)));
const id = (index) => `urn:uuid:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function graph() {
  const actor = {
    format: "morivyx.git-graph/0.1", kind: "entity", id: id(1), type: "core.actor", typeVersion: "0.1",
    lifecycle: "draft", reviewState: "unreviewed", attributes: { actorKind: "human", name: "synthetic" },
    provenance: { method: "asserted", actor: id(1), recordedAt: "2026-10-27T00:00:00Z" },
  };
  actor.revision = revisionId(actor);
  const relation = { ...structuredClone(actor), kind: "relation", id: id(2), type: "core.depends_on",
    attributes: { source: actor.id, predicate: "depends_on", target: actor.id } };
  relation.revision = revisionId(relation);
  return [actor, relation];
}
function validate(elements) {
  return validateGraph({ graphRevision: "graph:synthetic", schemaLockDigest: "sha256:" + "0".repeat(64),
    schemas: new Map([["morivyx.core@0.1", schema]]), elements });
}

test("rejects arrays, mappings, booleans and numbers as relation references or predicates", async (t) => {
  for (const field of ["source", "target", "predicate"]) {
    for (const [name, value] of [["array", []], ["mapping", {}], ["false", false], ["true", true], ["zero", 0], ["one", 1]]) {
      await t.test(`${field}: ${name}`, () => {
        const elements = graph();
        elements[1].attributes[field] = value;
        elements[1].revision = revisionId(elements[1]);
        const before = structuredClone(elements);
        const result = validate(elements);
        assert.equal(result.valid, false);
        assert.deepEqual(result.issues, [{
          code: field === "predicate" ? "CORE_UNKNOWN" : "RELATION_TARGET_MISSING",
          phase: field === "predicate" ? 3 : 5,
          elementId: id(2), path: field === "predicate" ? "/attributes/predicate" : `/${field}`, relatedId: "",
        }]);
        assert.deepEqual(elements, before);
      });
    }
  }
});

test("preserves required-field diagnostics for missing and null values", () => {
  for (const field of ["source", "target", "predicate"]) {
    for (const missing of [true, false]) {
      const elements = graph();
      if (missing) delete elements[1].attributes[field];
      else elements[1].attributes[field] = null;
      elements[1].revision = revisionId(elements[1]);
      assert.deepEqual(validate(elements).issues, [{ code: "SCHEMA_REQUIRED_FIELD", phase: 3,
        elementId: id(2), path: `/attributes/${field}`, relatedId: "" }]);
    }
  }
});

test("keeps valid string references and predicates accepted", () => {
  assert.equal(validate(graph()).valid, true);
});

test("CLI rejects an authoring-valid package with a non-string reference without mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-reference-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const elements = graph();
  elements[1].attributes.source = [];
  elements[1].revision = revisionId(elements[1]);
  const lock = { format: "morivyx.schema-lock/0.1", stableIdScheme: "urn-uuid-v4", digestAlgorithm: "sha256",
    schemas: [{ schemaId: schema.schemaId, version: schema.version, digest: schemaDefinitionDigest(schema) }] };
  const revision = { format: "morivyx.graph-revision/0.1", id: "graph:synthetic", parentRevision: null,
    rootDigest: graphRootDigest(elements), schemaLockDigest: schemaLockDigest(lock) };
  const records = {
    "schema.lock.yaml": lock, "revision.yaml": revision, "schemas/morivyx.core@0.1.yaml": schema,
    [`graph/entities/${id(1).slice(9)}.yaml`]: elements[0],
    [`graph/relations/${id(2).slice(9)}.yaml`]: elements[1],
  };
  const sources = {};
  for (const [relative, value] of Object.entries(records)) {
    const path = join(directory, ".morivyx", relative);
    await mkdir(dirname(path), { recursive: true });
    sources[path] = serializeYamlRecord(value);
    await writeFile(path, sources[path]);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "validate", directory], {
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.issues[0].code, "RELATION_TARGET_MISSING");
  for (const [path, source] of Object.entries(sources)) {
    assert.equal(await readFile(path, "utf8"), source);
  }
});
