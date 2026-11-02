import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
  graphRootDigest,
  revisionId,
  schemaLockDigest,
} from "../src/canonical.js";
import { PackageError } from "../src/errors.js";
import { readReport } from "../src/report.js";
import {
  createMigrationSemanticDiff,
  createSemanticDiff,
  diffPackages,
  migrationSemanticDiffCanonicalJson,
  migrationSemanticDiffDigest,
  semanticDiffCanonicalJson,
  semanticDiffDigest,
} from "../src/semantic-diff.js";
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

const lock = {
  format: "morivyx.schema-lock/0.1",
  stableIdScheme: "urn-uuid-v4",
  digestAlgorithm: "sha256",
  schemas: [],
};

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function element(suffix, kind = "entity", value = "first") {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind,
    id: stableId(suffix),
    type: kind === "entity" ? "example.item" : "example.relates",
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes:
      kind === "entity"
        ? { value }
        : { source: stableId(1), predicate: "relates", target: stableId(2), value },
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-08-30T16:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

async function createPackage(graphRevision, elements, schemaLock = lock) {
  const root = await mkdtemp(join(tmpdir(), "morivyx-diff-"));
  temporaryDirectories.add(root);
  const directory = join(root, ".morivyx");
  const entityDirectory = join(directory, "graph", "entities");
  const relationDirectory = join(directory, "graph", "relations");
  await mkdir(entityDirectory, { recursive: true });
  await mkdir(relationDirectory, { recursive: true });

  const revision = {
    format: "morivyx.graph-revision/0.1",
    id: graphRevision,
    parentRevision: null,
    rootDigest: graphRootDigest(elements),
    schemaLockDigest: schemaLockDigest(schemaLock),
  };
  await Promise.all([
    writeFile(join(directory, "schema.lock.yaml"), yaml(schemaLock)),
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

test("reads semantic diff packages in base then target order", async (t) => {
  const evaluatedAt = "2026-09-02T00:00:00Z";

  await t.test("valid packages", async () => {
    const basePath = await createPackage("graph:base", []);
    const targetPath = await createPackage("graph:target", []);

    const result = await diffPackages(basePath, targetPath, { evaluatedAt });

    assert.equal(result.valid, true);
    assert.equal(result.report.baseRevision, "graph:base");
    assert.equal(result.report.targetRevision, "graph:target");
  });

  await t.test("invalid base and target", async () => {
    const basePath = await createPackage("graph:base", []);
    const targetPath = await createPackage("graph:target", []);
    const baseRevisionPath = join(basePath, ".morivyx", "revision.yaml");
    const targetRevisionPath = join(targetPath, ".morivyx", "revision.yaml");
    await writeFile(baseRevisionPath, 'format: "morivyx.invalid/0.1"\n');
    await writeFile(targetRevisionPath, 'format: "morivyx.invalid/0.1"\n');

    await assert.rejects(
      diffPackages(basePath, targetPath, { evaluatedAt }),
      (error) =>
        error instanceof PackageError &&
        error.path === `${baseRevisionPath}#/format`,
    );
  });

  await t.test("valid base and invalid target", async () => {
    const basePath = await createPackage("graph:base", []);
    const targetPath = await createPackage("graph:target", []);
    const targetRevisionPath = join(targetPath, ".morivyx", "revision.yaml");
    await writeFile(targetRevisionPath, 'format: "morivyx.invalid/0.1"\n');

    await assert.rejects(
      diffPackages(basePath, targetPath, { evaluatedAt }),
      (error) =>
        error instanceof PackageError &&
        error.path === `${targetRevisionPath}#/format`,
    );
  });
});

test("matches the semantic diff validation vector", () => {
  const report = createSemanticDiff({
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440011",
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-package-v2",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    evaluatedAt: "2026-08-02T00:00:00Z",
    baseElements: [
      {
        id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        kind: "entity",
        revision:
          "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
      },
    ],
    targetElements: [
      {
        id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        kind: "entity",
        revision:
          "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
      },
      {
        id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
        kind: "entity",
        revision:
          "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
      },
    ],
    traceChanges: [
      {
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
        queryId: "governing-decision",
        beforeStatus: "partial",
        afterStatus: "complete",
      },
    ],
  });

  assert.equal(Buffer.byteLength(semanticDiffCanonicalJson(report)), 878);
  assert.equal(
    semanticDiffDigest(report),
    "sha256:8d05635012d207209a197cb68cface531db5f2970e5e4ce4f60ae35f2b25d66b",
  );
});

test("rejects semantic diff accessors without executing them", () => {
  let getterReads = 0;
  const baseReport = {
    format: "morivyx.semantic-diff/0.1",
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: `sha256:${"1".repeat(64)}`,
    evaluatedAt: "2026-08-30T17:00:00Z",
    entries: [],
  };
  const report = { ...baseReport };
  Object.defineProperty(report, "id", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "urn:uuid:550e8400-e29b-41d4-a716-446655440011";
    },
  });
  const contentAccessor = {
    ...baseReport,
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440011",
  };
  Object.defineProperty(contentAccessor, "entries", {
    enumerable: true,
    get() {
      getterReads += 1;
      return [];
    },
  });

  for (const action of [
    () => semanticDiffDigest(report),
    () => semanticDiffCanonicalJson(report),
    () => semanticDiffDigest(contentAccessor),
    () => semanticDiffCanonicalJson(contentAccessor),
  ]) {
    assert.throws(action, TypeError);
  }
  assert.equal(getterReads, 0);
});

test("generates the Migration planned semantic diff validation vector", () => {
  const sourceSchemaLock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [
      {
        schemaId: "morivyx.core",
        version: "0.1",
        digest:
          "sha256:f3bfeb8caaaf7ef46c847dd23c16845fedf6cd1c4547e75bd607961c995c90da",
      },
    ],
  };
  const targetSchemaLock = structuredClone(sourceSchemaLock);
  targetSchemaLock.schemas[0].version = "0.2";
  targetSchemaLock.schemas[0].digest =
    "sha256:fd354ccf8058f143f9355a727321de0eb2b9dfed2bd8d3203d3e628aeb4588b1";
  const baseElements = [
    {
      id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      kind: "entity",
      revision:
        "sha256:a22c6d07f0f48f1822bab48c1d9976b74be1f68fd5a79878a8b189af87002e62",
    },
  ];
  const targetElements = [
    {
      id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
      kind: "entity",
      revision:
        "sha256:4db0aef0e77cc2d25f56d6392094916370778eb4c94a4e21d185a2c1b379c53a",
    },
    {
      id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      kind: "entity",
      revision:
        "sha256:9f51932d46b8633a540b77fa145cc489e4fd498c95b09966e6278127840f9ae4",
    },
  ];
  const input = {
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440013",
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-migration-v1",
    sourceSchemaLock,
    targetSchemaLock,
    sourceSchemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    targetSchemaLockDigest:
      "sha256:85724a0823d941a238089f9de10f1fd81d5ff5710cc6f873a88bb067a58eb10d",
    evaluatedAt: "2026-08-03T00:00:00Z",
    baseElements,
    targetElements,
  };
  const snapshot = structuredClone(input);
  const report = createMigrationSemanticDiff(input);

  assert.deepEqual(
    report.entries.map(({ kind, targetId }) => ({ kind, targetId })),
    [
      {
        kind: "entity_added",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
      },
      {
        kind: "entity_revised",
        targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      },
      { kind: "schema_changed", targetId: "morivyx.core" },
    ],
  );
  assert.equal(report.format, "morivyx.migration-semantic-diff/0.1");
  assert.equal(
    report.sourceSchemaLockDigest,
    input.sourceSchemaLockDigest,
  );
  assert.equal(
    report.targetSchemaLockDigest,
    input.targetSchemaLockDigest,
  );
  assert.equal(
    migrationSemanticDiffDigest(report),
    "sha256:58cd060db029a17b8095c8fd8b8d55841792004a565ebebe4976993ada791090",
  );
  assert.equal(
    JSON.parse(migrationSemanticDiffCanonicalJson(report))
      .sourceSchemaLockDigest,
    input.sourceSchemaLockDigest,
  );
  assert.equal(
    migrationSemanticDiffDigest({
      ...report,
      id: "urn:uuid:550e8400-e29b-41d4-a716-446655440099",
      entries: [...report.entries].reverse(),
    }),
    migrationSemanticDiffDigest(report),
  );
  assert.deepEqual(input, snapshot);
});

test("rejects Migration semantic diff Schema lock mismatches", () => {
  const sourceSchemaLock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [
      {
        schemaId: "example.core",
        version: "0.1",
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
  };
  const targetSchemaLock = structuredClone(sourceSchemaLock);
  targetSchemaLock.schemas[0].version = "0.2";
  const baseInput = {
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    sourceSchemaLock,
    targetSchemaLock,
    sourceSchemaLockDigest: schemaLockDigest(sourceSchemaLock),
    targetSchemaLockDigest: schemaLockDigest(targetSchemaLock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [],
    targetElements: [],
  };

  for (const [field, path] of [
    ["sourceSchemaLockDigest", "/sourceSchemaLockDigest"],
    ["targetSchemaLockDigest", "/targetSchemaLockDigest"],
  ]) {
    assert.throws(
      () =>
        createMigrationSemanticDiff({
          ...baseInput,
          [field]: `sha256:${"0".repeat(64)}`,
        }),
      (error) =>
        error instanceof PackageError &&
        error.code === "SCHEMA_LOCK_CONFLICT" &&
        error.path === path,
    );
  }

  assert.throws(
    () =>
      createMigrationSemanticDiff({
        ...baseInput,
        targetSchemaLock: sourceSchemaLock,
        targetSchemaLockDigest: baseInput.sourceSchemaLockDigest,
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SCHEMA_LOCK_CONFLICT" &&
      error.path === "/targetSchemaLockDigest",
  );

  const uncanonicalizableSourceSchemaLock = {
    ...sourceSchemaLock,
    unsupported: 1n,
  };
  assert.throws(
    () =>
      createMigrationSemanticDiff({
        ...baseInput,
        sourceSchemaLock: uncanonicalizableSourceSchemaLock,
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SCHEMA_LOCK_CONFLICT" &&
      error.path === "/sourceSchemaLockDigest",
  );
});

test("rejects malformed Migration semantic diff Schema lock collections", () => {
  for (const input of [null, undefined]) {
    assert.throws(
      () => createMigrationSemanticDiff(input),
      (error) =>
        error instanceof PackageError &&
        error.code === "SCHEMA_LOCK_CONFLICT" &&
        error.path === "/sourceSchemaLockDigest",
    );
  }
  const validSchemaLock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [
      {
        schemaId: "example.core",
        version: "0.1",
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
  };
  const changedSchemaLock = structuredClone(validSchemaLock);
  changedSchemaLock.schemas[0].version = "0.2";
  const duplicateSchemaIdLock = {
    ...validSchemaLock,
    schemas: [
      { ...validSchemaLock.schemas[0], schemaId: "caf\u00e9" },
      { ...validSchemaLock.schemas[0], schemaId: "cafe\u0301" },
    ],
  };

  for (const [sourceSchemaLock, targetSchemaLock, path] of [
    [
      { ...validSchemaLock, schemas: {} },
      changedSchemaLock,
      "/sourceSchemaLock/schemas",
    ],
    [
      validSchemaLock,
      { ...changedSchemaLock, schemas: [null] },
      "/targetSchemaLock/schemas",
    ],
    [validSchemaLock, duplicateSchemaIdLock, "/targetSchemaLock/schemas"],
  ]) {
    assert.throws(
      () =>
        createMigrationSemanticDiff({
          baseRevision: "graph:base",
          targetRevision: "graph:target",
          sourceSchemaLock,
          targetSchemaLock,
          sourceSchemaLockDigest: schemaLockDigest(sourceSchemaLock),
          targetSchemaLockDigest: schemaLockDigest(targetSchemaLock),
          evaluatedAt: "2026-08-31T06:35:00+09:00",
          baseElements: [],
          targetElements: [],
        }),
      (error) =>
        error instanceof PackageError &&
        error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
        error.path === path,
    );
  }
});

test("rejects a Migration plan without a changed Schema entry", () => {
  const sourceSchemaLock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [],
  };
  const targetSchemaLock = {
    ...sourceSchemaLock,
    stableIdScheme: "other-stable-id-scheme",
  };

  assert.throws(
    () =>
      createMigrationSemanticDiff({
        baseRevision: "graph:base",
        targetRevision: "graph:target",
        sourceSchemaLock,
        targetSchemaLock,
        sourceSchemaLockDigest: schemaLockDigest(sourceSchemaLock),
        targetSchemaLockDigest: schemaLockDigest(targetSchemaLock),
        evaluatedAt: "2026-08-30T16:00:00Z",
        baseElements: [],
        targetElements: [],
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
      error.path === "/targetSchemaLock/schemas",
  );
});

test("detects and orders all basic structural changes", () => {
  const revisedEntityBefore = element(1);
  const revisedEntityAfter = element(1, "entity", "second");
  const revisedRelationBefore = element(10, "relation", "first");
  const revisedRelationAfter = element(10, "relation", "second");
  const report = createSemanticDiff({
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [
      revisedEntityBefore,
      element(5),
      revisedRelationBefore,
      element(11, "relation"),
    ],
    targetElements: [
      revisedEntityAfter,
      element(4),
      revisedRelationAfter,
      element(12, "relation"),
    ],
  });

  assert.deepEqual(
    report.entries.map((entry) => entry.kind),
    [
      "entity_added",
      "entity_revised",
      "entity_retired",
      "relation_added",
      "relation_revised",
      "relation_retired",
    ],
  );
});

test("omits unchanged inputs and expands a kind transition", () => {
  const unchanged = element(1);
  const before = element(2);
  const after = element(2, "relation");
  const report = createSemanticDiff({
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [unchanged, before],
    targetElements: [unchanged, after],
    traceChanges: [
      {
        targetId: stableId(1),
        queryId: "governing-decision",
        beforeStatus: "partial",
        afterStatus: "partial",
      },
    ],
  });

  assert.deepEqual(report.entries, [
    {
      kind: "entity_retired",
      targetId: before.id,
      beforeRevision: before.revision,
    },
    {
      kind: "relation_added",
      targetId: after.id,
      afterRevision: after.revision,
    },
  ]);
});

test("excludes the Report ID and normalizes entry order for the digest", () => {
  const report = {
    format: "morivyx.semantic-diff/0.1",
    id: stableId(20),
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    entries: [
      { kind: "entity_retired", targetId: stableId(2), beforeRevision: "b" },
      { kind: "entity_added", targetId: stableId(1), afterRevision: "a" },
    ],
  };
  const changed = {
    ...report,
    id: stableId(21),
    entries: [...report.entries].reverse(),
  };

  assert.equal(semanticDiffDigest(report), semanticDiffDigest(changed));
});

test("does not mutate Graph or Trace inputs", () => {
  const baseElements = [element(1)];
  const targetElements = [element(1, "entity", "second")];
  const traceChanges = [
    {
      targetId: stableId(1),
      queryId: "governing-decision",
      beforeStatus: "partial",
      afterStatus: "complete",
    },
  ];
  const before = structuredClone({ baseElements, targetElements, traceChanges });

  createSemanticDiff({
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements,
    targetElements,
    traceChanges,
  });
  assert.deepEqual({ baseElements, targetElements, traceChanges }, before);
});

test("rejects malformed Trace quality changes", () => {
  const input = {
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [],
    targetElements: [],
  };
  const change = {
    targetId: stableId(1),
    queryId: "governing-decision",
    beforeStatus: "partial",
    afterStatus: "complete",
  };
  const cases = [
    [null, "/traceChanges/0"],
    [{ ...change, targetId: "invalid" }, "/traceChanges/0/targetId"],
    [{ ...change, queryId: "unknown" }, "/traceChanges/0"],
  ];
  for (const [candidate, path] of cases) {
    assert.throws(
      () => createSemanticDiff({ ...input, traceChanges: [candidate] }),
      (error) =>
        error instanceof PackageError &&
        error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
        error.path === path,
    );
  }
});

test("rejects duplicate Trace quality logical keys", () => {
  const input = {
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [],
    targetElements: [],
  };
  const first = {
    targetId: stableId(1),
    queryId: "governing-decision",
    beforeStatus: "partial",
    afterStatus: "complete",
  };
  const second = {
    ...first,
    beforeStatus: "broken",
    afterStatus: "partial",
  };

  assert.throws(
    () => createSemanticDiff({ ...input, traceChanges: [first, second] }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SEMANTIC_DIFF_ENTRY_DUPLICATE" &&
      error.path === "/entries/1",
  );
  assert.throws(
    () =>
      semanticDiffDigest({
        format: "morivyx.semantic-diff/0.1",
        baseRevision: input.baseRevision,
        targetRevision: input.targetRevision,
        schemaLockDigest: input.schemaLockDigest,
        evaluatedAt: input.evaluatedAt,
        entries: [
          { kind: "trace_quality_changed", ...first },
          { kind: "trace_quality_changed", ...second },
        ],
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SEMANTIC_DIFF_ENTRY_DUPLICATE" &&
      error.path === "/entries/1",
  );
});

test("rejects malformed semantic diff inputs and an unknown diff kind", () => {
  for (const input of [null, undefined]) {
    assert.throws(
      () => createSemanticDiff(input),
      (error) =>
        error instanceof PackageError &&
        error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
        error.path === "/baseRevision",
    );
  }
  const input = {
    baseRevision: "graph:base",
    targetRevision: "graph:target",
    schemaLockDigest: schemaLockDigest(lock),
    evaluatedAt: "2026-08-30T16:00:00Z",
    baseElements: [],
    targetElements: [],
  };
  const cases = [
    ["baseRevision", "", "/baseRevision"],
    ["targetRevision", "invalid", "/targetRevision"],
    ["schemaLockDigest", "sha256:lock", "/schemaLockDigest"],
    ["evaluatedAt", "", "/evaluatedAt"],
    ["evaluatedAt", "2026-02-30T00:00:00Z", "/evaluatedAt"],
    ["evaluatedAt", "9999-12-31T23:59:59-14:00", "/evaluatedAt"],
    ["id", "invalid", "/id"],
    ["baseElements", {}, "/baseElements"],
    ["targetElements", {}, "/targetElements"],
    ["traceChanges", {}, "/traceChanges"],
  ];
  for (const [field, value, path] of cases) {
    assert.throws(
      () => createSemanticDiff({ ...input, [field]: value }),
      (error) =>
        error instanceof PackageError &&
        error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
        error.path === path,
      field,
    );
  }
  const validElement = element(1);
  const elementCases = [
    [null, "/baseElements/0"],
    [{ ...validElement, id: "invalid" }, "/baseElements/0/id"],
    [{ ...validElement, kind: "unknown" }, "/baseElements/0/kind"],
    [{ ...validElement, revision: "invalid" }, "/baseElements/0/revision"],
  ];
  for (const [candidate, path] of elementCases) {
    assert.throws(
      () => createSemanticDiff({ ...input, baseElements: [candidate] }),
      (error) =>
        error instanceof PackageError &&
        error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
        error.path === path,
      path,
    );
  }
  assert.throws(
    () =>
      createSemanticDiff({
        ...input,
        targetElements: [validElement, validElement],
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SEMANTIC_DIFF_INPUT_INVALID" &&
      error.path === "/targetElements/1/id",
  );
  assert.throws(
    () =>
      semanticDiffDigest({
        format: "morivyx.semantic-diff/0.1",
        baseRevision: "graph:base",
        targetRevision: "graph:target",
        schemaLockDigest: schemaLockDigest(lock),
        evaluatedAt: "2026-08-30T16:00:00Z",
        entries: [{ kind: "unknown", targetId: stableId(1) }],
      }),
    (error) =>
      error instanceof PackageError &&
      error.code === "SEMANTIC_DIFF_KIND_UNKNOWN",
  );
});

test("prints a semantic diff and digest from the command", async () => {
  const base = element(1);
  const target = element(1, "entity", "second");
  const basePath = await createPackage("graph:base", [base]);
  const targetPath = await createPackage("graph:target", [target]);
  const result = spawnSync(
    process.execPath,
    [
      join(testDirectory, "..", "src", "cli.js"),
      "diff",
      basePath,
      targetPath,
      "--evaluated-at",
      "2026-08-30T16:00:00Z",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.match(output.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(output.report.entries[0].kind, "entity_revised");

  for (const [option, value, path] of [
    ["--evaluated-at", "not-a-time", "/evaluatedAt"],
    ["--id", "invalid", "/id"],
  ]) {
    const invalidArguments = [
      join(testDirectory, "..", "src", "cli.js"),
      "diff",
      basePath,
      targetPath,
      "--evaluated-at",
      "2026-08-30T16:00:00Z",
    ];
    if (option === "--evaluated-at") {
      invalidArguments[5] = value;
    } else {
      invalidArguments.push(option, value);
    }
    const invalid = spawnSync(process.execPath, invalidArguments, {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    const issue = JSON.parse(invalid.stdout).issues[0];
    assert.equal(issue.code, "SEMANTIC_DIFF_INPUT_INVALID");
    assert.equal(issue.path, path);
  }
});

test("saves a semantic diff from the command without overwriting it", async () => {
  const basePath = await createPackage("graph:base", [element(1)]);
  const targetPath = await createPackage("graph:target", [
    element(1, "entity", "second"),
  ]);
  const reportId = stableId(22);
  const arguments_ = [
    join(testDirectory, "..", "src", "cli.js"),
    "diff",
    basePath,
    targetPath,
    "--evaluated-at",
    "2026-08-30T16:00:00Z",
    "--id",
    reportId,
    "--save",
  ];
  const first = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

  assert.equal(first.status, 0, first.stdout || first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.report.id, reportId);
  assert.equal(
    output.savedPath,
    join(
      targetPath,
      ".morivyx",
      "reports",
      `${reportId.slice("urn:uuid:".length)}.yaml`,
    ),
  );
  assert.equal((await readReport(output.savedPath)).digest, output.digest);

  const second = spawnSync(process.execPath, arguments_, { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.equal(
    JSON.parse(second.stdout).issues[0].code,
    "REPORT_ALREADY_EXISTS",
  );
});

test("rejects package comparison across Schema lock digests", async () => {
  const basePath = await createPackage("graph:base", [element(1)]);
  const otherLock = {
    ...lock,
    schemas: [
      {
        schemaId: "example.test",
        version: "0.1",
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
  };
  const targetPath = await createPackage(
    "graph:target",
    [element(1)],
    otherLock,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(testDirectory, "..", "src", "cli.js"),
      "diff",
      basePath,
      targetPath,
      "--evaluated-at",
      "2026-08-30T16:00:00Z",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).issues[0].code, "SCHEMA_LOCK_CONFLICT");
});
