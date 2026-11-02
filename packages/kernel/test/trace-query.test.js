import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  graphRootDigest,
  revisionId,
  schemaLockDigest,
} from "../src/canonical.js";
import { PackageError } from "../src/errors.js";
import { readReport, validateTraceReport } from "../src/report.js";
import {
  executeTraceQuery,
  traceReportCanonicalJson,
  traceReportDigest,
} from "../src/trace-query.js";
import { yaml } from "../test-support/yaml.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(suffix, type, attributes = {}) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes,
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-08-30T17:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

function relation(suffix, source, predicate, target) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "relation",
    id: stableId(suffix),
    type: `core.${predicate}`,
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: { source, predicate, target },
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-08-30T17:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

function query(queryId, focusId, elements, id) {
  return executeTraceQuery({
    queryId,
    graphRevision: "graph:trace-v1",
    schemaLockDigest: `sha256:${"1".repeat(64)}`,
    focusId,
    evaluatedAt: "2026-08-30T17:00:00Z",
    elements,
    id,
  });
}

function completeGraph() {
  const artifact = entity(1, "core.artifact");
  const execution = entity(2, "core.execution");
  const plan = entity(3, "core.plan");
  const goal = entity(4, "core.goal");
  const decision = entity(5, "core.decision");
  const knowledge = entity(6, "core.knowledge");
  const observation = entity(7, "core.observation");
  const criterion = entity(8, "core.criterion");
  const verification = entity(9, "core.verification");
  const learning = entity(13, "core.learning");
  return [
    artifact,
    execution,
    plan,
    goal,
    decision,
    knowledge,
    observation,
    criterion,
    verification,
    learning,
    relation(20, execution.id, "produces", artifact.id),
    relation(21, execution.id, "executes", plan.id),
    relation(22, plan.id, "pursues", goal.id),
    relation(23, decision.id, "governs", artifact.id),
    relation(24, decision.id, "supported_by", knowledge.id),
    relation(25, decision.id, "challenged_by", observation.id),
    relation(26, goal.id, "has_criterion", criterion.id),
    relation(27, verification.id, "against", criterion.id),
    relation(28, verification.id, "produces", observation.id),
    relation(29, learning.id, "derived_from", observation.id),
    relation(30, learning.id, "triggers", goal.id),
  ];
}

const standardTraceQueryIds = [
  "why-artifact-exists",
  "governing-decision",
  "decision-evidence",
  "goal-achievement-evidence",
  "observation-triggered-change",
];

function buildReferenceGraph(example, exampleIndex, coreSchema) {
  const idByAlias = new Map();
  const aliasById = new Map();
  const typeByAlias = new Map();
  const coreEntityTypes = new Set(
    coreSchema.entityTypes.map(({ typeId }) => typeId),
  );
  const coreRelationTypes = new Map(
    coreSchema.relationTypes.map((definition) => [
      definition.predicate,
      definition,
    ]),
  );
  const base = (exampleIndex + 1) * 1_000;
  const entities = example.entities.map((entry, entityIndex) => {
    assert.equal(
      idByAlias.has(entry.alias),
      false,
      `${example.id}: Entity別名が重複しています: ${entry.alias}`,
    );
    assert.ok(
      coreEntityTypes.has(entry.type),
      `${example.id}: Core SchemaにないEntity型です: ${entry.type}`,
    );
    const value = entity(base + entityIndex + 1, entry.type);
    idByAlias.set(entry.alias, value.id);
    aliasById.set(value.id, entry.alias);
    typeByAlias.set(entry.alias, entry.type);
    return value;
  });
  const relationKeys = new Set();
  const relations = example.relations.map((entry, relationIndex) => {
    const source = idByAlias.get(entry.from);
    const target = idByAlias.get(entry.to);
    assert.ok(source, `${example.id}: 未定義のfrom別名です: ${entry.from}`);
    assert.ok(target, `${example.id}: 未定義のto別名です: ${entry.to}`);
    const definition = coreRelationTypes.get(entry.predicate);
    assert.ok(
      definition,
      `${example.id}: Core SchemaにないRelation型です: ${entry.predicate}`,
    );
    assert.ok(
      definition.sourceTypes.includes(typeByAlias.get(entry.from)),
      `${example.id}: Relationの接続元型がCore Schemaと一致しません: ${entry.from} ${entry.predicate}`,
    );
    assert.ok(
      definition.targetTypes.includes(typeByAlias.get(entry.to)),
      `${example.id}: Relationの接続先型がCore Schemaと一致しません: ${entry.predicate} ${entry.to}`,
    );
    const key = `${entry.from}\u0000${entry.predicate}\u0000${entry.to}`;
    assert.equal(
      relationKeys.has(key),
      false,
      `${example.id}: Relationが重複しています: ${entry.from} ${entry.predicate} ${entry.to}`,
    );
    relationKeys.add(key);
    return relation(base + 500 + relationIndex, source, entry.predicate, target);
  });
  return {
    elements: [...entities, ...relations],
    idByAlias,
    aliasById,
    relationKeys,
  };
}

function sortAliasPaths(paths) {
  return paths
    .map((path) => JSON.stringify(path.map((hop) => ({ ...hop }))))
    .sort()
    .map((path) => JSON.parse(path));
}

function reportPathsByAlias(report, aliasById) {
  return sortAliasPaths(
    report.paths.map((path) =>
      path.hops.map((hop) => {
        const from = aliasById.get(hop.fromId);
        const to = aliasById.get(hop.toId);
        assert.ok(from, `Query結果が未知のfrom IDを参照しています: ${hop.fromId}`);
        assert.ok(to, `Query結果が未知のto IDを参照しています: ${hop.toId}`);
        return { from, predicate: hop.predicate, to };
      }),
    ),
  );
}

async function createPackage(elements) {
  const root = await mkdtemp(join(tmpdir(), "morivyx-trace-"));
  temporaryDirectories.add(root);
  const directory = join(root, ".morivyx");
  const entityDirectory = join(directory, "graph", "entities");
  const relationDirectory = join(directory, "graph", "relations");
  await mkdir(entityDirectory, { recursive: true });
  await mkdir(relationDirectory, { recursive: true });
  const lock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [],
  };
  const revision = {
    format: "morivyx.graph-revision/0.1",
    id: "graph:trace-command-v1",
    parentRevision: null,
    rootDigest: graphRootDigest(elements),
    schemaLockDigest: schemaLockDigest(lock),
  };
  await Promise.all([
    writeFile(join(directory, "schema.lock.yaml"), yaml(lock)),
    writeFile(join(directory, "revision.yaml"), yaml(revision)),
    ...elements.map((record) =>
      writeFile(
        join(
          record.kind === "entity" ? entityDirectory : relationDirectory,
          `${record.id.slice("urn:uuid:".length)}.yaml`,
        ),
        yaml(record),
      ),
    ),
  ]);
  return root;
}

test("matches the Trace Report validation vector", () => {
  const artifact = {
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
    kind: "entity",
    type: "core.artifact",
    revision:
      "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
  };
  const decision = {
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440002",
    kind: "entity",
    type: "core.decision",
    revision:
      "sha256:2b56691b87622570d4d69c26a56cfd3cb9e01e8c83c434c88f9d4284ba94e3c6",
  };
  const governs = {
    id: stableId(20),
    kind: "relation",
    attributes: {
      source: decision.id,
      predicate: "governs",
      target: artifact.id,
    },
  };
  const report = executeTraceQuery({
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440010",
    queryId: "governing-decision",
    graphRevision: "graph:stage-1-package-v1",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    focusId: artifact.id,
    evaluatedAt: "2026-08-02T00:00:00Z",
    elements: [artifact, decision, governs],
  });

  assert.equal(Buffer.byteLength(traceReportCanonicalJson(report)), 665);
  assert.equal(
    traceReportDigest(report),
    "sha256:e2268da4eae9d3d868b483de0add3bbdb9359b4895f34043d771a0ed52b292b7",
  );
});

test("rejects Trace Report accessors without executing them", () => {
  let getterReads = 0;
  const baseReport = {
    format: "morivyx.trace-report/0.1",
    queryId: "governing-decision",
    graphRevision: "graph:trace-v1",
    schemaLockDigest: `sha256:${"1".repeat(64)}`,
    focusId: stableId(1),
    evaluatedAt: "2026-08-30T17:00:00Z",
    status: "partial",
    paths: [],
    missing: [],
  };
  const report = { ...baseReport };
  Object.defineProperty(report, "id", {
    enumerable: true,
    get() {
      getterReads += 1;
      return stableId(10);
    },
  });
  const contentAccessor = { ...baseReport, id: stableId(10) };
  Object.defineProperty(contentAccessor, "paths", {
    enumerable: true,
    get() {
      getterReads += 1;
      return [];
    },
  });

  for (const action of [
    () => traceReportDigest(report),
    () => traceReportCanonicalJson(report),
    () => traceReportDigest(contentAccessor),
    () => traceReportCanonicalJson(contentAccessor),
  ]) {
    assert.throws(action, TypeError);
  }
  assert.equal(getterReads, 0);
});

test("answers all five standard Trace queries", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(testDirectory, "fixtures", "stage-0-trace-query-vectors.json"),
      "utf8",
    ),
  );
  assert.equal(fixture.source, "docs/validation/stage-0-reference-graphs.md");
  assert.equal(fixture.schema, "docs/schema/morivyx.core@0.1.yaml");
  assert.equal(fixture.examples.length, 3);
  assert.equal(new Set(fixture.examples.map(({ id }) => id)).size, 3);
  const coreSchema = parseYaml(
    await readFile(
      join(testDirectory, "..", "..", "..", fixture.schema),
      "utf8",
    ),
  );

  let queryCount = 0;
  for (const [exampleIndex, example] of fixture.examples.entries()) {
    const { elements, idByAlias, aliasById, relationKeys } =
      buildReferenceGraph(example, exampleIndex, coreSchema);
    assert.equal(
      example.queries.length,
      standardTraceQueryIds.length,
      example.id,
    );
    assert.deepEqual(
      [...new Set(example.queries.map(({ queryId }) => queryId))].sort(),
      [...standardTraceQueryIds].sort(),
      example.id,
    );

    for (const expected of example.queries) {
      const focusId = idByAlias.get(expected.focus);
      assert.ok(
        focusId,
        `${example.id}/${expected.queryId}: 未定義のfocus別名です: ${expected.focus}`,
      );
      for (const path of expected.paths) {
        for (const hop of path) {
          const key = `${hop.from}\u0000${hop.predicate}\u0000${hop.to}`;
          assert.ok(
            relationKeys.has(key),
            `${example.id}/${expected.queryId}: Query経路が未定義のRelationを参照しています`,
          );
        }
      }

      const report = query(expected.queryId, focusId, elements);
      assert.equal(report.status, expected.status, example.id);
      assert.deepEqual(report.missing, expected.missing, example.id);
      assert.deepEqual(
        reportPathsByAlias(report, aliasById),
        sortAliasPaths(expected.paths),
        `${example.id}/${expected.queryId}`,
      );
      assert.equal(validateTraceReport(report), report, expected.queryId);
      queryCount += 1;
    }
  }
  assert.equal(queryCount, 15);
});

test("returns every path from a large Trace fan-out", () => {
  const pathCount = 1_000;
  const artifact = entity(100, "core.artifact");
  const elements = [artifact];
  let nextId = 1_000;
  for (let index = 0; index < pathCount; index += 1) {
    const execution = entity(nextId, "core.execution");
    nextId += 1;
    const plan = entity(nextId, "core.plan");
    nextId += 1;
    const goal = entity(nextId, "core.goal");
    nextId += 1;
    elements.push(
      execution,
      plan,
      goal,
      relation(nextId, execution.id, "produces", artifact.id),
    );
    nextId += 1;
    elements.push(relation(nextId, execution.id, "executes", plan.id));
    nextId += 1;
    elements.push(relation(nextId, plan.id, "pursues", goal.id));
    nextId += 1;
  }

  const report = query("why-artifact-exists", artifact.id, elements);
  assert.equal(report.status, "complete");
  assert.equal(report.paths.length, pathCount);
  assert.deepEqual(report.missing, []);
  assert.equal(validateTraceReport(report), report);
});

test("returns partial for a missing path and broken for a dangling reference", () => {
  const artifact = entity(1, "core.artifact");
  const partial = query("governing-decision", artifact.id, [artifact]);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.missing, ["governs"]);

  const dangling = relation(20, stableId(99), "governs", artifact.id);
  const broken = query("governing-decision", artifact.id, [artifact, dangling]);
  assert.equal(broken.status, "broken");
  assert.deepEqual(broken.paths, []);
});

test("returns broken for a missing or incompatible focus", () => {
  const artifact = entity(1, "core.artifact");
  const missing = query("governing-decision", stableId(99), [artifact]);
  assert.equal(missing.status, "broken");
  assert.deepEqual(missing.paths, []);
  assert.deepEqual(missing.missing, ["focus"]);

  const incompatible = query("decision-evidence", artifact.id, [artifact]);
  assert.equal(incompatible.status, "broken");
  assert.deepEqual(incompatible.paths, []);
  assert.deepEqual(incompatible.missing, ["focus-type"]);
});

const endpointCases = [
  ["why-artifact-exists", 1, [2, 3, 4]],
  ["governing-decision", 1, [5]],
  ["decision-evidence", 5, [6, 7]],
  ["goal-achievement-evidence", 4, [8, 9, 7]],
  ["observation-triggered-change", 7, [13, 4]],
];

function asRelation(record, includeRevision) {
  const replacement = relation(999, stableId(998), "unused", stableId(998));
  replacement.id = record.id;
  replacement.type = record.type;
  if (!includeRevision) delete replacement.revision;
  return replacement;
}

for (const [queryId, focus, endpoints] of endpointCases) {
  for (const includeRevision of [false, true]) {
    test(`${queryId} rejects a relation focus with revision=${includeRevision}`, () => {
      const elements = completeGraph().map(record =>
        record.id === stableId(focus) ? asRelation(record, includeRevision) : record,
      );
      const report = query(queryId, stableId(focus), elements);
      assert.equal(report.status, "broken");
      assert.deepEqual(report.paths, []);
      assert.deepEqual(report.missing, ["focus-type"]);
      assert.equal(validateTraceReport(report), report);
      assert.match(traceReportDigest(report), /^sha256:[0-9a-f]{64}$/);
    });
    for (const endpoint of endpoints) {
      test(`${queryId} rejects relation endpoint ${endpoint} with revision=${includeRevision}`, () => {
        const elements = completeGraph().map(record =>
          record.id === stableId(endpoint) ? asRelation(record, includeRevision) : record,
        );
        const report = query(queryId, stableId(focus), elements);
        assert.equal(report.status, "broken");
        assert.equal(report.paths.some(path => path.hops.some(hop =>
          hop.fromId === stableId(endpoint) || hop.toId === stableId(endpoint),
        )), false);
        assert.equal(validateTraceReport(report), report);
        assert.match(traceReportDigest(report), /^sha256:[0-9a-f]{64}$/);
      });
    }
  }
}

test("reports each missing standard Trace path stage", () => {
  const elements = completeGraph();
  const without = (...predicates) =>
    elements.filter(
      (element) => !predicates.includes(element.attributes?.predicate),
    );
  const cases = [
    ["why-artifact-exists", stableId(1), without("produces"), ["produces"]],
    ["why-artifact-exists", stableId(1), without("executes"), ["executes"]],
    ["why-artifact-exists", stableId(1), without("pursues"), ["pursues"]],
    ["decision-evidence", stableId(5), without("supported_by"), ["supported_by"]],
    [
      "decision-evidence",
      stableId(5),
      without("challenged_by"),
      ["challenged_by-or-challengeReview"],
    ],
    [
      "goal-achievement-evidence",
      stableId(4),
      without("has_criterion"),
      ["has_criterion"],
    ],
    ["goal-achievement-evidence", stableId(4), without("against"), ["against"]],
    [
      "goal-achievement-evidence",
      stableId(4),
      without("produces"),
      ["produces-observation"],
    ],
    [
      "observation-triggered-change",
      stableId(7),
      without("derived_from"),
      ["derived_from"],
    ],
    [
      "observation-triggered-change",
      stableId(7),
      without("triggers"),
      ["triggers"],
    ],
  ];

  for (const [queryId, focusId, source, missing] of cases) {
    const report = query(queryId, focusId, source);
    assert.equal(report.status, "partial", queryId);
    assert.equal(
      report.paths.length,
      queryId === "decision-evidence" ? 1 : 0,
      queryId,
    );
    assert.deepEqual(report.missing, missing, queryId);
    assert.equal(validateTraceReport(report), report, queryId);
  }
});

test("returns broken for incompatible intermediate Trace types", () => {
  const artifact = entity(1, "core.artifact");
  const execution = entity(2, "core.execution");
  const plan = entity(3, "core.plan");
  const goal = entity(4, "core.goal");
  const observation = entity(7, "core.observation");
  const criterion = entity(8, "core.criterion");
  const verification = entity(9, "core.verification");
  const cases = [
    [
      "governing-decision",
      artifact.id,
      [artifact, goal, relation(20, goal.id, "governs", artifact.id)],
      ["governs"],
    ],
    [
      "why-artifact-exists",
      artifact.id,
      [artifact, plan, relation(20, plan.id, "produces", artifact.id)],
      ["produces"],
    ],
    [
      "why-artifact-exists",
      artifact.id,
      [
        artifact,
        execution,
        goal,
        relation(20, execution.id, "produces", artifact.id),
        relation(21, execution.id, "executes", goal.id),
      ],
      ["executes"],
    ],
    [
      "why-artifact-exists",
      artifact.id,
      [
        artifact,
        execution,
        plan,
        relation(20, execution.id, "produces", artifact.id),
        relation(21, execution.id, "executes", plan.id),
        relation(22, plan.id, "pursues", artifact.id),
      ],
      ["pursues"],
    ],
    [
      "goal-achievement-evidence",
      goal.id,
      [goal, artifact, relation(20, goal.id, "has_criterion", artifact.id)],
      ["has_criterion"],
    ],
    [
      "goal-achievement-evidence",
      goal.id,
      [
        goal,
        criterion,
        artifact,
        relation(20, goal.id, "has_criterion", criterion.id),
        relation(21, artifact.id, "against", criterion.id),
      ],
      ["against"],
    ],
    [
      "goal-achievement-evidence",
      goal.id,
      [
        goal,
        criterion,
        verification,
        artifact,
        relation(20, goal.id, "has_criterion", criterion.id),
        relation(21, verification.id, "against", criterion.id),
        relation(22, verification.id, "produces", artifact.id),
      ],
      ["produces-observation"],
    ],
    [
      "observation-triggered-change",
      observation.id,
      [
        observation,
        artifact,
        relation(20, artifact.id, "derived_from", observation.id),
      ],
      ["derived_from"],
    ],
  ];

  for (const [queryId, focusId, elements, missing] of cases) {
    const report = query(queryId, focusId, elements);
    assert.equal(report.status, "broken", queryId);
    assert.deepEqual(report.paths, [], queryId);
    assert.deepEqual(report.missing, missing, queryId);
    assert.equal(validateTraceReport(report), report, queryId);
  }
});

test("sorts Trace paths by canonical form", () => {
  const artifact = entity(1, "core.artifact");
  const first = entity(5, "core.decision");
  const second = entity(6, "core.decision");
  const elements = [
    artifact,
    second,
    first,
    relation(20, second.id, "governs", artifact.id),
    relation(21, first.id, "governs", artifact.id),
  ];
  const report = query("governing-decision", artifact.id, elements);

  assert.equal(report.paths[0].hops[0].fromId, first.id);
  assert.equal(report.paths[1].hops[0].fromId, second.id);
});

test("excludes Report ID from the digest and preserves input Graph", () => {
  const elements = completeGraph();
  const before = structuredClone(elements);
  const report = query(
    "governing-decision",
    stableId(1),
    elements,
    stableId(40),
  );
  const changed = { ...report, id: stableId(41) };

  assert.equal(traceReportDigest(report), traceReportDigest(changed));
  assert.deepEqual(elements, before);
});

test("rejects an unknown query and malformed Trace Query inputs", () => {
  for (const input of [null, undefined]) {
    assert.throws(
      () => executeTraceQuery(input),
      (error) =>
        error instanceof PackageError &&
        error.code === "TRACE_QUERY_UNKNOWN" &&
        error.path === "/queryId",
    );
  }
  assert.throws(
    () => query("unknown", stableId(1), []),
    (error) =>
      error instanceof PackageError && error.code === "TRACE_QUERY_UNKNOWN",
  );
  const input = {
    queryId: "governing-decision",
    graphRevision: "graph:trace-v1",
    schemaLockDigest: `sha256:${"1".repeat(64)}`,
    focusId: stableId(1),
    evaluatedAt: "2026-08-30T17:00:00Z",
    elements: [],
  };
  const cases = [
    ["graphRevision", "", "/graphRevision"],
    ["schemaLockDigest", "sha256:lock", "/schemaLockDigest"],
    ["focusId", "invalid", "/focusId"],
    ["evaluatedAt", "", "/evaluatedAt"],
    ["evaluatedAt", "2026-02-30T00:00:00Z", "/evaluatedAt"],
    ["evaluatedAt", "9999-12-31T23:59:59-14:00", "/evaluatedAt"],
    ["id", "invalid", "/id"],
    ["elements", {}, "/elements"],
  ];
  for (const [field, value, path] of cases) {
    assert.throws(
      () => executeTraceQuery({ ...input, [field]: value }),
      (error) =>
        error instanceof PackageError &&
        error.code === "TRACE_QUERY_INPUT_INVALID" &&
        error.path === path,
      field,
    );
  }

  const validEntity = entity(1, "core.artifact");
  const validRelation = relation(20, stableId(1), "governs", stableId(2));
  const elementCases = [
    [null, "/elements/0"],
    [{ ...validEntity, id: "invalid" }, "/elements/0/id"],
    [{ ...validEntity, kind: "unknown" }, "/elements/0/kind"],
    [{ ...validEntity, type: "" }, "/elements/0/type"],
    [{ ...validEntity, revision: "invalid" }, "/elements/0/revision"],
    [{ ...validRelation, attributes: null }, "/elements/0/attributes"],
    [
      {
        ...validRelation,
        attributes: { ...validRelation.attributes, source: "invalid" },
      },
      "/elements/0/attributes/source",
    ],
    [
      {
        ...validRelation,
        attributes: { ...validRelation.attributes, predicate: "" },
      },
      "/elements/0/attributes/predicate",
    ],
    [
      {
        ...validRelation,
        attributes: { ...validRelation.attributes, target: "invalid" },
      },
      "/elements/0/attributes/target",
    ],
    [{ ...validRelation, revision: "invalid" }, "/elements/0/revision"],
  ];
  for (const [element, path] of elementCases) {
    assert.throws(
      () => executeTraceQuery({ ...input, elements: [element] }),
      (error) =>
        error instanceof PackageError &&
        error.code === "TRACE_QUERY_INPUT_INVALID" &&
        error.path === path,
      path,
    );
  }
  assert.throws(
    () => executeTraceQuery({ ...input, elements: [validEntity, validEntity] }),
    (error) =>
      error instanceof PackageError &&
      error.code === "TRACE_QUERY_INPUT_INVALID" &&
      error.path === "/elements/1/id",
  );
});

test("prints a Trace Report and digest from the command", async () => {
  const artifact = entity(1, "core.artifact");
  const decision = entity(5, "core.decision");
  const packagePath = await createPackage([
    artifact,
    decision,
    relation(20, decision.id, "governs", artifact.id),
  ]);
  const result = spawnSync(
    process.execPath,
    [
      join(testDirectory, "..", "src", "cli.js"),
      "trace",
      packagePath,
      "--query",
      "governing-decision",
      "--focus",
      artifact.id,
      "--evaluated-at",
      "2026-08-30T17:00:00Z",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.match(output.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(output.report.status, "complete");

  const invalid = spawnSync(
    process.execPath,
    [
      join(testDirectory, "..", "src", "cli.js"),
      "trace",
      packagePath,
      "--query",
      "governing-decision",
      "--focus",
      artifact.id,
      "--evaluated-at",
      "not-a-time",
    ],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  const invalidOutput = JSON.parse(invalid.stdout);
  assert.equal(invalidOutput.valid, false);
  assert.equal(invalidOutput.issues[0].code, "TRACE_QUERY_INPUT_INVALID");
  assert.equal(invalidOutput.issues[0].path, "/evaluatedAt");
});

test("saves a Trace Report from the command and requires its ID", async () => {
  const artifact = entity(1, "core.artifact");
  const decision = entity(5, "core.decision");
  const packagePath = await createPackage([
    artifact,
    decision,
    relation(20, decision.id, "governs", artifact.id),
  ]);
  const baseArguments = [
    join(testDirectory, "..", "src", "cli.js"),
    "trace",
    packagePath,
    "--query",
    "governing-decision",
    "--focus",
    artifact.id,
    "--evaluated-at",
    "2026-08-30T17:00:00Z",
  ];
  const missingId = spawnSync(
    process.execPath,
    [...baseArguments, "--save"],
    { encoding: "utf8" },
  );
  assert.equal(missingId.status, 2);

  const duplicateOption = spawnSync(
    process.execPath,
    [
      ...baseArguments,
      "--id",
      stableId(40),
      "--save",
      "--save",
    ],
    { encoding: "utf8" },
  );
  assert.equal(duplicateOption.status, 2);

  const invalidId = spawnSync(
    process.execPath,
    [...baseArguments, "--id", "invalid"],
    { encoding: "utf8" },
  );
  assert.equal(invalidId.status, 1);
  assert.equal(
    JSON.parse(invalidId.stdout).issues[0].code,
    "TRACE_QUERY_INPUT_INVALID",
  );

  const reportId = stableId(40);
  const saved = spawnSync(
    process.execPath,
    [...baseArguments, "--id", reportId, "--save"],
    { encoding: "utf8" },
  );
  assert.equal(saved.status, 0, saved.stdout || saved.stderr);
  const output = JSON.parse(saved.stdout);
  assert.equal(output.report.id, reportId);
  assert.equal((await readReport(output.savedPath)).digest, output.digest);
});
