import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical.js";
import { serializeReportYaml } from "../src/report.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePackage = join(testDirectory, "fixtures", "package-v1", ".morivyx");
const digest = (value) => `sha256:${value.repeat(64)}`;
const stableId = (suffix) =>
  `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function changeSet() {
  return {
    format: "morivyx.changeset/0.1",
    id: stableId(10),
    baseRevision: "graph:base",
    resultingRevision: "graph:target",
    resultingRootDigest: digest("1"),
    schemaLockDigest: digest("2"),
    operations: [
      {
        op: "revise",
        targetId: stableId(1),
        beforeRevision: digest("3"),
        afterRevision: digest("4"),
      },
      {
        op: "create",
        targetId: stableId(2),
        afterRevision: digest("5"),
      },
    ],
    provenance: {
      method: "manual",
      actor: "koukemo",
      recordedAt: "2026-08-02T00:00:00Z",
    },
    recordedAt: "2026-08-02T00:00:00Z",
  };
}

function decisionRevisionRequest() {
  return {
    format: "morivyx.decision-revision-request/0.1",
    decisionId: stableId(1),
    attributes: {
      consequences: ["updated"],
      question: "What should remain stable?",
      rationale: "The revised rationale.",
    },
    changeSetId: stableId(16),
    resultingRevision: "graph:target",
    actor: stableId(900),
    recordedAt: "2026-09-01T15:05:00Z",
  };
}

function decisionCreationRequest() {
  return {
    format: "morivyx.decision-creation-request/0.1",
    decisionId: stableId(17),
    attributes: {
      consequences: ["created"],
      question: "What should be decided?",
      rationale: "Create the Decision from one request.",
    },
    changeSetId: stableId(18),
    resultingRevision: "graph:created",
    actor: stableId(900),
    recordedAt: "2026-09-01T15:06:00Z",
  };
}

function migration() {
  return {
    format: "morivyx.migration/0.1",
    id: stableId(11),
    baseRevision: "graph:base",
    sourceSchemaLockDigest: digest("1"),
    targetSchemaLockDigest: digest("2"),
    rulesDigest: digest("3"),
    mappingDigest: digest("4"),
    plannedSemanticDiffDigest: digest("5"),
    changeSetId: stableId(10),
    resultingRevision: "graph:target",
    resultingRootDigest: digest("6"),
    provenance: {
      method: "migration",
      actor: "koukemo",
      recordedAt: "2026-08-02T00:00:00Z",
    },
    recordedAt: "2026-08-02T00:00:00Z",
  };
}

function traceReport() {
  return {
    format: "morivyx.trace-report/0.1",
    id: stableId(12),
    queryId: "governing-decision",
    graphRevision: "graph:target",
    schemaLockDigest: digest("2"),
    focusId: stableId(1),
    evaluatedAt: "2026-08-02T00:00:00Z",
    status: "complete",
    paths: [
      {
        hops: [
          {
            fromId: stableId(1),
            predicate: "governed_by",
            toId: stableId(2),
            fromRevision: digest("3"),
            toRevision: digest("4"),
          },
        ],
      },
    ],
    missing: [],
  };
}

function semanticDiff() {
  return {
    format: "morivyx.semantic-diff/0.1",
    id: stableId(13),
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: digest("2"),
    evaluatedAt: "2026-08-02T00:00:00Z",
    entries: [
      {
        kind: "entity_added",
        targetId: stableId(2),
        afterRevision: digest("5"),
      },
      {
        kind: "entity_revised",
        targetId: stableId(1),
        beforeRevision: digest("3"),
        afterRevision: digest("4"),
      },
    ],
  };
}

function migrationSemanticDiff() {
  return {
    format: "morivyx.migration-semantic-diff/0.1",
    id: stableId(15),
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    sourceSchemaLockDigest: digest("1"),
    targetSchemaLockDigest: digest("2"),
    evaluatedAt: "2026-08-02T00:00:00Z",
    entries: [
      { kind: "schema_changed", targetId: "example.core" },
    ],
  };
}

function externalArtifactReport() {
  return {
    format: "morivyx.external-artifact-report/0.1",
    id: stableId(14),
    graphRevision: "graph:target",
    artifact: {
      id: stableId(1),
      revision: digest("1"),
      lifecycle: "active",
    },
    externalSource: { id: stableId(2), revision: digest("2") },
    relation: { id: stableId(3), revision: digest("3") },
    retrieval: {
      status: "resolved",
      comparedAt: "2026-09-01T01:00:00Z",
      digest: digest("4"),
      digestRule: "raw-bytes@1",
    },
    comparedAt: "2026-09-01T01:00:00Z",
    status: "current",
    issues: [],
  };
}

function reverseMappings(value) {
  if (Array.isArray(value)) {
    return value.map(reverseMappings);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseMappings(entry)]),
    );
  }
  return value;
}

async function knownRecords() {
  const fixturePaths = [
    join(
      fixturePackage,
      "graph",
      "entities",
      "550e8400-e29b-41d4-a716-446655440000.yaml",
    ),
    join(fixturePackage, "schema.lock.yaml"),
    join(fixturePackage, "revision.yaml"),
    join(
      fixturePackage,
      "approvals",
      "550e8400-e29b-41d4-a716-446655440003.yaml",
    ),
    join(testDirectory, "../../../docs/schema/morivyx.core@0.1.yaml"),
  ];
  return [
    ...(await Promise.all(fixturePaths.map((path) => readYamlRecord(path)))),
    decisionCreationRequest(),
    decisionRevisionRequest(),
    changeSet(),
    migration(),
    traceReport(),
    semanticDiff(),
    migrationSemanticDiff(),
    externalArtifactReport(),
  ];
}

test("serializes all known record formats for strict reader round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-writer-"));
  try {
    const records = [
      ...(await knownRecords()),
      {
        format: "morivyx.graph-revision/0.1",
        parentRevision: null,
      },
      {
        format: "morivyx.schema/0.1",
        relationTypes: [{ maxCount: null }],
      },
      {
        format: "morivyx.git-graph/0.1",
        extensions: { vendor: { nullable: null } },
      },
      {
        format: "morivyx.external-artifact-report/0.1",
        status: "invalid",
        graphRevision: null,
        retrieval: null,
      },
    ];
    assert.equal(records.length, 17);
    for (const [index, record] of records.entries()) {
      const source = serializeYamlRecord(record);
      assert.ok(source.endsWith("\n"), record.format);
      const path = join(directory, `${index}.yaml`);
      await writeFile(path, source, "utf8");
      assert.deepEqual(
        await readYamlRecord(path),
        JSON.parse(canonicalJson(record)),
        record.format,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("produces identical bytes regardless of mapping insertion order", async () => {
  for (const record of await knownRecords()) {
    assert.equal(
      serializeYamlRecord(reverseMappings(record)),
      serializeYamlRecord(record),
      record.format,
    );
  }
  const recordWithRootExtensions = {
    zeta: "Z",
    format: "morivyx.git-graph/0.1",
    alpha: "A",
  };
  const serialized = serializeYamlRecord(recordWithRootExtensions);
  assert.equal(
    serialized,
    serializeYamlRecord(reverseMappings(recordWithRootExtensions)),
  );
  assert.ok(serialized.indexOf("format:") < serialized.indexOf("alpha:"));
  assert.ok(serialized.indexOf("alpha:") < serialized.indexOf("zeta:"));
});

test("normalizes timestamps and Unicode mappings while preserving lists", () => {
  const graph = {
    format: "morivyx.git-graph/0.1",
    attributes: {
      zeta: "Cafe\u0301",
      "e\u0301": "2026-08-02T09:00:00+09:00",
    },
    extensions: {
      vendor: {
        zeta: "Cafe\u0301",
        alpha: "2026-08-02T09:00:00+09:00",
      },
    },
  };
  const equivalent = {
    format: "morivyx.git-graph/0.1",
    attributes: {
      "é": "2026-08-02T00:00:00Z",
      zeta: "Café",
    },
    extensions: {
      vendor: {
        alpha: "2026-08-02T00:00:00Z",
        zeta: "Café",
      },
    },
  };
  assert.equal(serializeYamlRecord(graph), serializeYamlRecord(equivalent));

  const record = changeSet();
  const serialized = serializeYamlRecord(record);
  assert.ok(serialized.indexOf(stableId(1)) < serialized.indexOf(stableId(2)));
});

test("uses the common writer for Report serialization", () => {
  for (const report of [
    traceReport(),
    semanticDiff(),
    migrationSemanticDiff(),
  ]) {
    assert.equal(serializeReportYaml(report), serializeYamlRecord(report));
  }
});

test("rejects unsupported formats and values without a canonical form", () => {
  assert.throws(
    () => serializeYamlRecord({ format: "morivyx.unknown/0.1" }),
    (error) =>
      error.code === "PACKAGE_FORMAT_UNSUPPORTED" && error.path === "/format",
  );
  assert.throws(
    () =>
      serializeYamlRecord({
        format: "morivyx.git-graph/0.1",
        kind: undefined,
      }),
    (error) =>
      error.code === "YAML_SERIALIZATION_INVALID" && error.path === "/kind",
  );
  for (const [record, path] of [
    [{ format: "morivyx.git-graph/0.1", provenance: null }, "/provenance"],
    [{ format: "morivyx.schema/0.1", entityTypes: null }, "/entityTypes"],
    [
      {
        format: "morivyx.graph-revision/0.1",
        "x-example": { nested: ["value", null] },
      },
      "/x-example/nested/1",
    ],
    [
      {
        format: "morivyx.external-artifact-report/0.1",
        status: "valid",
        graphRevision: null,
      },
      "/graphRevision",
    ],
  ]) {
    assert.throws(
      () => serializeYamlRecord(record),
      (error) =>
        error.code === "YAML_SERIALIZATION_INVALID" && error.path === path,
    );
  }
  assert.throws(
    () =>
      serializeYamlRecord({
        format: "morivyx.git-graph/0.1",
        attributes: { "e\u0301": 1, "é": 2 },
      }),
    (error) =>
      error.code === "YAML_SERIALIZATION_INVALID" &&
      error.path === "/attributes/é",
  );
});

test("codes stack exhaustion for a deeply nested logical value", () => {
  let value = "leaf";
  for (let depth = 0; depth < 5_000; depth += 1) {
    value = [value];
  }

  assert.throws(
    () =>
      serializeYamlRecord({
        format: "morivyx.git-graph/0.1",
        extensions: { deep: value },
      }),
    (error) =>
      error.code === "YAML_SERIALIZATION_INVALID" && error.path === "",
  );
});

test("rejects non-logical structures without executing accessors", () => {
  const record = (value) => ({
    format: "morivyx.git-graph/0.1",
    extensions: { "example/value": value },
  });
  const extraProperty = ["visible"];
  extraProperty.hidden = "lost";
  let getterReads = 0;
  const accessorValue = {};
  Object.defineProperty(accessorValue, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "visible";
    },
  });
  const circularValue = {};
  circularValue.self = circularValue;

  for (const value of [
    Array(2),
    extraProperty,
    { [Symbol("hidden")]: "lost" },
    accessorValue,
    circularValue,
    new Date(0),
    "before\ud800after",
    "before\udc00after",
  ]) {
    assert.throws(
      () => serializeYamlRecord(record(value)),
      (error) => error.code === "YAML_SERIALIZATION_INVALID",
    );
  }
  assert.equal(getterReads, 0);
});
