import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { revisionId } from "../src/canonical.js";
import { PackageError } from "../src/errors.js";
import { validateGraphElement } from "../src/graph-element.js";
import { readGraphPackage } from "../src/package-reader.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const entityFixture = join(
  fixture,
  ".morivyx",
  "graph",
  "entities",
  "550e8400-e29b-41d4-a716-446655440000.yaml",
);
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;

function graphElement(overrides = {}) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "relation",
    id: stableId(50),
    type: "core.supports",
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: {
      source: stableId(1),
      predicate: "supports",
      target: stableId(2),
    },
    provenance: {
      method: "asserted",
      actor: stableId(3),
      recordedAt: "2026-08-03T09:00:00+09:00",
    },
    extensions: {
      "example.test/quality": { labels: ["first", "second"] },
    },
    ...overrides,
  };
  record.revision = overrides.revision ?? revisionId(record);
  return record;
}

function expectCode(value, path) {
  assert.throws(
    () => validateGraphElement(value),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "GRAPH_ELEMENT_INVALID");
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("accepts the repository Entity and a Relation with an Extension", async () => {
  const entity = await readYamlRecord(entityFixture);
  assert.equal(validateGraphElement(entity), entity);
  const relation = graphElement();
  assert.equal(validateGraphElement(relation), relation);
});

test("rejects malformed roots and common scalar fields", () => {
  const cases = [
    [null, ""],
    [[], ""],
    [{ ...graphElement(), format: "morivyx.git-graph/1.0" }, "/format"],
    [{ ...graphElement(), unknown: "value" }, "/unknown"],
    [{ ...graphElement(), kind: "other" }, "/kind"],
    [{ ...graphElement(), id: "invalid" }, "/id"],
    [{ ...graphElement(), type: "invalid" }, "/type"],
    [{ ...graphElement(), typeVersion: "" }, "/typeVersion"],
    [{ ...graphElement(), revision: "invalid" }, "/revision"],
    [{ ...graphElement(), lifecycle: "" }, "/lifecycle"],
    [{ ...graphElement(), reviewState: "other" }, "/reviewState"],
  ];
  for (const [record, path] of cases) {
    expectCode(record, path);
  }
});

test("rejects invalid attributes, Provenance, and Extensions", () => {
  const cases = [
    [{ ...graphElement(), attributes: [] }, "/attributes"],
    [{ ...graphElement(), provenance: null }, "/provenance"],
    [
      {
        ...graphElement(),
        provenance: { ...graphElement().provenance, method: "" },
      },
      "/provenance/method",
    ],
    [
      {
        ...graphElement(),
        provenance: { ...graphElement().provenance, actor: "invalid" },
      },
      "/provenance/actor",
    ],
    [
      {
        ...graphElement(),
        provenance: {
          ...graphElement().provenance,
          recordedAt: "2026-08-31T00:00:00",
        },
      },
      "/provenance/recordedAt",
    ],
    [
      {
        ...graphElement(),
        provenance: {
          ...graphElement().provenance,
          recordedAt: "2026-02-30T00:00:00Z",
        },
      },
      "/provenance/recordedAt",
    ],
    [{ ...graphElement(), extensions: [] }, "/extensions"],
    [
      { ...graphElement(), extensions: { unnamespaced: true } },
      "/extensions/unnamespaced",
    ],
  ];
  for (const [record, path] of cases) {
    expectCode(record, path);
  }
});

test("includes the source file before a GraphElement JSON Pointer", () => {
  const path = "/package/.morivyx/graph/entities/record.yaml";
  assert.throws(
    () => validateGraphElement({ ...graphElement(), id: "invalid" }, path),
    (error) =>
      error.code === "GRAPH_ELEMENT_INVALID" && error.path === `${path}#/id`,
  );
});

test("rejects an unknown root before the Revision digest check", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-element-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const path = join(
    directory,
    ".morivyx",
    "graph",
    "entities",
    "550e8400-e29b-41d4-a716-446655440000.yaml",
  );
  const record = await readYamlRecord(path);
  await writeFile(
    path,
    serializeYamlRecord({ ...record, unknown: "value" }),
    "utf8",
  );

  await assert.rejects(
    readGraphPackage(directory),
    (error) =>
      error.code === "GRAPH_ELEMENT_INVALID" &&
      error.path === `${path}#/unknown`,
  );
});
