import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionId } from "../src/canonical.js";
import { PackageError } from "../src/errors.js";
import {
  buildGraphIndex,
  graphIndexSnapshot,
  rebuildPackageIndex,
  verifyGraphIndex,
} from "../src/graph-index.js";
import { readGraphPackage } from "../src/package-reader.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");

test("builds the same index regardless of source element order", async () => {
  const packageContents = await readGraphPackage(fixture);
  const source = {
    graphRevision: packageContents.revision.id,
    elements: packageContents.elements,
  };
  const forward = buildGraphIndex(source);
  const reverse = buildGraphIndex({
    ...source,
    elements: [...source.elements].reverse(),
  });

  assert.deepEqual(graphIndexSnapshot(forward), graphIndexSnapshot(reverse));
  assert.deepEqual(verifyGraphIndex(forward, source), {
    valid: true,
    graphRevision: packageContents.revision.id,
    rootDigest: packageContents.revision.rootDigest,
  });
});

test("detects a damaged index and rebuilds it from the canonical package", async () => {
  const packageContents = await readGraphPackage(fixture);
  const source = {
    graphRevision: packageContents.revision.id,
    elements: packageContents.elements,
  };
  const index = buildGraphIndex(source);
  const expected = graphIndexSnapshot(index);
  index.byId.delete(packageContents.elements[0].id);
  index.byType.set("damaged", ["missing"]);

  assert.equal(verifyGraphIndex(index, source).valid, false);
  const rebuilt = buildGraphIndex(source);
  assert.deepEqual(graphIndexSnapshot(rebuilt), expected);
  assert.equal(verifyGraphIndex(rebuilt, source).valid, true);

  const nonCanonical = buildGraphIndex(source);
  nonCanonical.byType.set("damaged", [undefined]);
  assert.deepEqual(verifyGraphIndex(nonCanonical, source), {
    valid: false,
    graphRevision: packageContents.revision.id,
    rootDigest: packageContents.revision.rootDigest,
  });
});

test("indexes relation source and target in Unicode order", () => {
  const source = element(1, "entity", "example.beta");
  const target = element(2, "entity", "example.alpha");
  const relation = element(3, "relation", "example.refers_to", {
    source: source.id,
    predicate: "example.refers_to",
    target: target.id,
  });
  const index = buildGraphIndex({
    graphRevision: "graph:index-v1",
    elements: [relation, target, source],
  });
  const snapshot = graphIndexSnapshot(index);

  assert.deepEqual(snapshot.types.map(({ type }) => type), [
    "example.alpha",
    "example.beta",
    "example.refers_to",
  ]);
  assert.deepEqual(snapshot.outgoing, [
    { sourceId: source.id, relationIds: [relation.id] },
  ]);
  assert.deepEqual(snapshot.incoming, [
    { targetId: target.id, relationIds: [relation.id] },
  ]);
});

test("rejects duplicate stable IDs in an index source", () => {
  const first = element(1, "entity", "example.item");
  const duplicate = structuredClone(first);
  duplicate.revision = revisionId(duplicate);

  assert.throws(
    () =>
      buildGraphIndex({
        graphRevision: "graph:index-v1",
        elements: [first, duplicate],
      }),
    (error) =>
      error instanceof PackageError && error.code === "INDEX_SOURCE_INVALID",
  );
});

test("rejects malformed index source metadata and references", () => {
  const valid = element(1, "entity", "example.item");
  const malformed = { ...valid, id: "invalid" };
  const revised = { ...valid, type: "example.changed" };
  const nonCanonical = { ...valid, attributes: { unsafe: 1.5 } };
  const dangling = element(2, "relation", "example.refers_to", {
    source: stableId(99),
    predicate: "example.refers_to",
    target: valid.id,
  });
  const cases = [
    [null, "/graphRevision"],
    [undefined, "/graphRevision"],
    [{ graphRevision: "invalid", elements: [valid] }, "/graphRevision"],
    [{ graphRevision: "graph:index-v1", elements: null }, "/elements"],
    [
      { graphRevision: "graph:index-v1", elements: [malformed] },
      "/elements/0/id",
    ],
    [
      { graphRevision: "graph:index-v1", elements: [revised] },
      "/elements/0/revision",
    ],
    [
      { graphRevision: "graph:index-v1", elements: [nonCanonical] },
      "/elements/0",
    ],
    [
      { graphRevision: "graph:index-v1", elements: [dangling, valid] },
      "/elements/0/attributes/source",
    ],
  ];

  for (const [source, path] of cases) {
    assert.throws(
      () => buildGraphIndex(source),
      (error) =>
        error instanceof PackageError &&
        error.code === "INDEX_SOURCE_INVALID" &&
        error.path === path,
    );
  }
});

test("rebuilds a package index through the API and CLI without writing it", async () => {
  const apiResult = await rebuildPackageIndex(fixture);
  const command = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "reindex", fixture],
    { encoding: "utf8" },
  );

  assert.equal(command.status, 0, command.stdout || command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), apiResult);
  assert.equal(apiResult.valid, true);
  assert.equal(apiResult.index.elements.length, 2);
  await assert.rejects(access(join(fixture, ".morivyx", "index.json")));
});

function element(suffix, kind, type, attributes = {}) {
  const value = {
    format: "morivyx.git-graph/0.1",
    kind,
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes,
    provenance: {
      method: "asserted",
      actor: "urn:uuid:00000000-0000-4000-8000-000000000900",
      recordedAt: "2026-08-31T00:00:00Z",
    },
  };
  value.revision = revisionId(value);
  return value;
}

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}
