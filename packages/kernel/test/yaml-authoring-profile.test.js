import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PackageError, readYamlRecord } from "../src/package-reader.js";
import { validateSchemaDefinition } from "../src/schema-definition.js";
import { normalizeYamlLogicalValue } from "../src/yaml-authoring-profile.js";

async function readSource(source) {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-profile-"));
  const path = join(directory, "input.yaml");
  try {
    await writeFile(path, source);
    return await readYamlRecord(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectInvalid(
  source,
  code = "PACKAGE_AUTHORING_PROFILE_INVALID",
  pathSuffix,
) {
  await assert.rejects(
    () => readSource(source),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, code);
      if (pathSuffix) {
        assert.ok(error.path.endsWith(pathSuffix), error.path);
      }
      return true;
    },
  );
}

test("accepts the scalar forms and empty collections allowed by the profile", async () => {
  const result = await readSource(
    'text: "value"\ntruth: true\nempty: null\ncount: -1\nlist: []\nmap: {}\n',
  );
  assert.deepEqual(result, {
    text: "value",
    truth: true,
    empty: null,
    count: -1,
    list: [],
    map: {},
  });
});

test("rejects non-mapping YAML record roots", async (t) => {
  for (const [name, source] of [
    ["scalar", '"value"\n'],
    ["sequence", '- "value"\n'],
  ]) {
    await t.test(name, () => expectInvalid(source, "PACKAGE_YAML_INVALID"));
  }
});

test("reports YAML parser errors as PACKAGE_YAML_INVALID", async (t) => {
  for (const [name, source] of [
    ["unterminated collection", "value: [\n"],
    ["duplicate key", 'value: "first"\nvalue: "second"\n'],
  ]) {
    await t.test(name, () => expectInvalid(source, "PACKAGE_YAML_INVALID"));
  }
});

test("rejects invalid UTF-8 and byte-level formatting", async (t) => {
  const cases = [
    ["invalid UTF-8", Buffer.from([0x76, 0x3a, 0x20, 0xc3, 0x28, 0x0a])],
    ["BOM", '\uFEFFvalue: "x"\n'],
    ["CRLF", 'value: "x"\r\n'],
    ["tab", 'value:\t"x"\n'],
    ["missing final LF", 'value: "x"'],
    ["extra final LF", 'value: "x"\n\n'],
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => expectInvalid(source));
  }
});

test("rejects YAML presentation features outside the profile", async (t) => {
  const cases = [
    ["comment", 'value: "x" # note\n'],
    ["numeric key", '1: "x"\n'],
    ["complex key", '? ["key"]\n: "value"\n'],
    ["omitted value", "value:\n"],
    ["null shorthand", "value: ~\n"],
    ["merge key", '<<: "value"\n'],
    ["flow sequence", 'value: ["x"]\n'],
    ["flow map", 'value: { key: "x" }\n'],
    ["block scalar", "value: |\n  x\n"],
    ["anchor", '&saved key: "x"\n'],
    ["alias", 'first: &saved "x"\nsecond: *saved\n'],
    ["custom tag", 'value: !example "x"\n'],
    ["directive", '%YAML 1.2\nvalue: "x"\n'],
    ["document marker", '---\nvalue: "x"\n'],
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => expectInvalid(source));
  }
});

test("rejects unquoted strings and non-canonical numbers", async (t) => {
  const cases = [
    ["plain string", "value: text\n"],
    ["single quoted string", "value: 'text'\n"],
    ["leading zero", "value: 01\n"],
    ["positive sign", "value: +1\n"],
    ["negative zero", "value: -0\n"],
    ["decimal", "value: 1.0\n"],
    ["exponent", "value: 1e0\n"],
    ["unsafe integer", "value: 9007199254740992\n"],
    ["NaN", "value: .nan\n"],
    ["Infinity", "value: .inf\n"],
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => expectInvalid(source));
  }
});

test("normalizes keys and string values to NFC", async () => {
  const result = await readSource('e\u0301: "e\u0301"\nquoted: "# value"\n');
  assert.deepEqual(result, { é: "é", quoted: "# value" });

  assert.throws(
    () => normalizeYamlLogicalValue({ "e\u0301": "first", é: "second" }),
    /NFC 正規化後に重複する項目/,
  );
});

test("rejects keys that collide after NFC normalization", async () => {
  await expectInvalid('e\u0301: "first"\né: "second"\n');
});

test("accepts fixed and Unicode authoring orders", async () => {
  const result = await readSource(
    'format: "morivyx.git-graph/0.1"\n' +
      'kind: "entity"\n' +
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
      'type: "example.item"\n' +
      'typeVersion: "0.1"\n' +
      `revision: "sha256:${"0".repeat(64)}"\n` +
      'lifecycle: "draft"\n' +
      'reviewState: "unreviewed"\n' +
      'attributes:\n  alpha: "A"\n  beta: "B"\n' +
      'provenance:\n  method: "asserted"\n  actor: "actor"\n' +
      '  recordedAt: "2026-08-30T00:00:00Z"\n  alpha: "A"\n' +
      '  alphaDetail: "AA"\n  beta: "B"\n' +
      'extensions:\n  example.test/unknown:\n    alpha: "A"\n' +
      '    nested:\n      - alpha: "A"\n        beta: "B"\n',
  );

  assert.equal(result.attributes.alpha, "A");
});

test("accepts all Report authoring orders", async () => {
  const trace = await readSource(
    'format: "morivyx.trace-report/0.1"\n' +
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
      'queryId: "governing-decision"\n' +
      'graphRevision: "graph:test"\n' +
      `schemaLockDigest: "sha256:${"0".repeat(64)}"\n` +
      'focusId: "urn:uuid:00000000-0000-4000-8000-000000000002"\n' +
      'evaluatedAt: "2026-08-30T00:00:00Z"\n' +
      'status: "complete"\n' +
      'paths:\n  - hops:\n      - fromId: "from"\n' +
      '        predicate: "governs"\n        toId: "to"\n' +
      '        fromRevision: "from-revision"\n' +
      '        toRevision: "to-revision"\n' +
      'missing: []\n',
  );
  const diff = await readSource(
    'format: "morivyx.semantic-diff/0.1"\n' +
      'id: "urn:uuid:00000000-0000-4000-8000-000000000003"\n' +
      'baseRevision: "graph:base"\n' +
      'targetRevision: "graph:target"\n' +
      `schemaLockDigest: "sha256:${"0".repeat(64)}"\n` +
      'evaluatedAt: "2026-08-30T00:00:00Z"\n' +
      'entries:\n  - kind: "entity_revised"\n' +
      '    targetId: "target"\n    beforeRevision: "before"\n' +
      '    afterRevision: "after"\n',
  );
  const migrationDiff = await readSource(
    'format: "morivyx.migration-semantic-diff/0.1"\n' +
      'id: "urn:uuid:00000000-0000-4000-8000-000000000005"\n' +
      'baseRevision: "graph:base"\n' +
      'targetRevision: "graph:target"\n' +
      `sourceSchemaLockDigest: "sha256:${"0".repeat(64)}"\n` +
      `targetSchemaLockDigest: "sha256:${"1".repeat(64)}"\n` +
      'evaluatedAt: "2026-08-30T00:00:00Z"\n' +
      'entries:\n  - kind: "schema_changed"\n' +
      '    targetId: "example.core"\n',
  );
  const external = await readSource(
    'format: "morivyx.external-artifact-report/0.1"\n' +
      'id: "urn:uuid:00000000-0000-4000-8000-000000000004"\n' +
      'graphRevision: "graph:test"\n' +
      'artifact:\n  id: "artifact"\n  revision: "artifact-revision"\n' +
      '  lifecycle: "active"\n' +
      'externalSource:\n  id: "source"\n  revision: "source-revision"\n' +
      'relation:\n  id: "relation"\n  revision: "relation-revision"\n' +
      'retrieval:\n  status: "resolved"\n' +
      '  comparedAt: "2026-09-01T01:00:00Z"\n' +
      '  digest: "digest"\n  digestRule: "raw-bytes@1"\n' +
      'comparedAt: "2026-09-01T01:00:00Z"\n' +
      'status: "current"\nissues:\n  - code: "EXTERNAL_DIGEST_CHANGED"\n',
  );

  assert.equal(trace.paths[0].hops[0].predicate, "governs");
  assert.equal(diff.entries[0].kind, "entity_revised");
  assert.equal(migrationDiff.entries[0].kind, "schema_changed");
  assert.equal(external.retrieval.status, "resolved");
});

test("rejects fixed authoring order violations with JSON Pointers", async (t) => {
  const cases = [
    [
      "GraphElement root",
      'format: "morivyx.git-graph/0.1"\nkind: "entity"\n' +
        'typeVersion: "0.1"\ntype: "example.item"\n',
      "#/type",
    ],
    [
      "GraphElement attributes",
      'format: "morivyx.git-graph/0.1"\nattributes:\n  beta: "B"\n  alpha: "A"\n',
      "#/attributes/alpha",
    ],
    [
      "GraphElement provenance",
      'format: "morivyx.git-graph/0.1"\nprovenance:\n  actor: "actor"\n' +
        '  method: "asserted"\n  recordedAt: "2026-08-30T00:00:00Z"\n',
      "#/provenance/method",
    ],
    [
      "unknown Extension",
      'format: "morivyx.git-graph/0.1"\nextensions:\n' +
        '  example.test/value:\n    beta: "B"\n    alpha: "A"\n',
      "#/extensions/example.test~1value/alpha",
    ],
    [
      "Schema lock entry",
      'format: "morivyx.schema-lock/0.1"\nstableIdScheme: "urn-uuid-v4"\n' +
        'digestAlgorithm: "sha256"\nschemas:\n  - version: "0.1"\n' +
        '    schemaId: "example.test"\n    digest: "digest"\n',
      "#/schemas/0/schemaId",
    ],
    [
      "Decision creation request root",
      'decisionId: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.decision-creation-request/0.1"\n',
      "#/format",
    ],
    [
      "Decision revision request root",
      'decisionId: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.decision-revision-request/0.1"\n',
      "#/format",
    ],
    [
      "GraphRevision root",
      'id: "graph:test"\nformat: "morivyx.graph-revision/0.1"\n',
      "#/format",
    ],
    [
      "approval root",
      'format: "morivyx.approval/0.1"\nid: "approval"\n' +
        'targetId: "target"\nactor: "actor"\n',
      "#/actor",
    ],
    [
      "Schema entity type",
      'format: "morivyx.schema/0.1"\nentityTypes:\n' +
        '  - requiredAttributes: []\n    typeId: "example.item"\n',
      "#/entityTypes/0/typeId",
    ],
    [
      "ChangeSet root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.changeset/0.1"\n',
      "#/format",
    ],
    [
      "ChangeSet operation",
      'format: "morivyx.changeset/0.1"\noperations:\n' +
        `  - afterRevision: "sha256:${"1".repeat(64)}"\n` +
        '    targetId: "urn:uuid:00000000-0000-4000-8000-000000000001"\n',
      "#/operations/0/targetId",
    ],
    [
      "Migration root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.migration/0.1"\n',
      "#/format",
    ],
    [
      "Trace Report root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.trace-report/0.1"\n',
      "#/format",
    ],
    [
      "Trace Report hop",
      'format: "morivyx.trace-report/0.1"\npaths:\n  - hops:\n' +
        '      - fromId: "from"\n        fromRevision: "before"\n' +
        '        toId: "to"\n',
      "#/paths/0/hops/0/toId",
    ],
    [
      "semantic diff root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.semantic-diff/0.1"\n',
      "#/format",
    ],
    [
      "semantic diff entry",
      'format: "morivyx.semantic-diff/0.1"\nentries:\n' +
        '  - kind: "entity_revised"\n    afterRevision: "after"\n' +
        '    targetId: "target"\n',
      "#/entries/0/targetId",
    ],
    [
      "Migration semantic diff root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.migration-semantic-diff/0.1"\n',
      "#/format",
    ],
    [
      "Migration semantic diff entry",
      'format: "morivyx.migration-semantic-diff/0.1"\nentries:\n' +
        '  - kind: "schema_changed"\n    afterRevision: "after"\n' +
        '    targetId: "example.core"\n',
      "#/entries/0/targetId",
    ],
    [
      "external Artifact Report root",
      'id: "urn:uuid:00000000-0000-4000-8000-000000000001"\n' +
        'format: "morivyx.external-artifact-report/0.1"\n',
      "#/format",
    ],
    [
      "external Artifact identity",
      'format: "morivyx.external-artifact-report/0.1"\nartifact:\n' +
        '  revision: "revision"\n  id: "artifact"\n',
      "#/artifact/id",
    ],
    [
      "external Artifact retrieval",
      'format: "morivyx.external-artifact-report/0.1"\nretrieval:\n' +
        '  comparedAt: "2026-09-01T01:00:00Z"\n  status: "resolved"\n',
      "#/retrieval/status",
    ],
  ];
  for (const [name, source, pathSuffix] of cases) {
    await t.test(name, () =>
      expectInvalid(source, "PACKAGE_AUTHORING_ORDER_INVALID", pathSuffix),
    );
  }
  await expectInvalid(
    'format: "morivyx.git-graph/0.1"\nprovenance:\n' +
      '  method: "asserted"\n  actor: "actor"\n' +
      '  recordedAt: "2026-08-30T00:00:00Z"\n' +
      '  beta: "B"\n  alpha: "A"\n',
    "PACKAGE_AUTHORING_ORDER_INVALID",
    "#/provenance/alpha",
  );
});

test("accepts null only at Schema-authorized locations", async (t) => {
  const cases = [
    [
      "GraphRevision parent",
      'format: "morivyx.graph-revision/0.1"\nid: "graph:test"\nparentRevision: null\n',
    ],
    [
      "Schema relation maximum",
      'format: "morivyx.schema/0.1"\nrelationTypes:\n' +
        '  - predicate: "example.refers_to"\n    maxCount: null\n',
    ],
    [
      "unknown Extension",
      'format: "morivyx.git-graph/0.1"\nextensions:\n' +
        '  example.test/value:\n    empty: null\n',
    ],
    [
      "invalid external Artifact Report",
      'format: "morivyx.external-artifact-report/0.1"\n' +
        'graphRevision: null\nartifact:\n  id: null\n  revision: null\n' +
        '  lifecycle: null\nexternalSource:\n  id: null\n  revision: null\n' +
        'relation:\n  id: null\n  revision: null\nretrieval: null\n' +
        'comparedAt: null\nstatus: "invalid"\nissues: []\n',
    ],
  ];
  for (const [name, source] of cases) {
    await t.test(name, async () => {
      const result = await readSource(source);
      assert.ok(result);
    });
  }
});

test("rejects null outside Schema-authorized locations", async (t) => {
  const cases = [
    [
      "Decision creation request attribute",
      'format: "morivyx.decision-creation-request/0.1"\n' +
        "attributes:\n  consequences:\n    - null\n",
      "#/attributes/consequences/0",
    ],
    [
      "Decision revision request attribute",
      'format: "morivyx.decision-revision-request/0.1"\n' +
        "attributes:\n  consequences:\n    - null\n",
      "#/attributes/consequences/0",
    ],
    [
      "GraphElement attribute list",
      'format: "morivyx.git-graph/0.1"\nattributes:\n  values:\n    - null\n',
      "#/attributes/values/0",
    ],
    [
      "extensions root",
      'format: "morivyx.git-graph/0.1"\nextensions: null\n',
      "#/extensions",
    ],
    [
      "Schema lock",
      'format: "morivyx.schema-lock/0.1"\nstableIdScheme: null\n',
      "#/stableIdScheme",
    ],
    [
      "GraphRevision digest",
      'format: "morivyx.graph-revision/0.1"\nid: "graph:test"\n' +
        'parentRevision: null\nrootDigest: null\n',
      "#/rootDigest",
    ],
    [
      "approval expiry",
      'format: "morivyx.approval/0.1"\nexpiresAt: null\n',
      "#/expiresAt",
    ],
    [
      "Schema relation minimum",
      'format: "morivyx.schema/0.1"\nrelationTypes:\n' +
        '  - predicate: "example.refers_to"\n    minCount: null\n',
      "#/relationTypes/0/minCount",
    ],
    [
      "ChangeSet operation",
      'format: "morivyx.changeset/0.1"\noperations:\n  - op: "create"\n' +
        '    targetId: null\n',
      "#/operations/0/targetId",
    ],
    [
      "Migration digest",
      'format: "morivyx.migration/0.1"\nrulesDigest: null\n',
      "#/rulesDigest",
    ],
    [
      "Trace Report missing",
      'format: "morivyx.trace-report/0.1"\nmissing:\n  - null\n',
      "#/missing/0",
    ],
    [
      "semantic diff target Revision",
      'format: "morivyx.semantic-diff/0.1"\ntargetRevision: null\n',
      "#/targetRevision",
    ],
    [
      "Migration semantic diff source Schema digest",
      'format: "morivyx.migration-semantic-diff/0.1"\n' +
        'sourceSchemaLockDigest: null\n',
      "#/sourceSchemaLockDigest",
    ],
    [
      "current external Artifact Report comparison time",
      'format: "morivyx.external-artifact-report/0.1"\n' +
        'comparedAt: null\nstatus: "current"\n',
      "#/comparedAt",
    ],
  ];
  for (const [name, source, pathSuffix] of cases) {
    await t.test(name, () =>
      expectInvalid(source, "PACKAGE_NULL_INVALID", pathSuffix),
    );
  }
});

test("accepts empty, single, and ascending Schema sets", async () => {
  const result = await readSource(
    'format: "morivyx.schema/0.1"\n' +
      'reviewStates:\n  - "approved"\n  - "unreviewed"\n' +
      'entityTypes:\n  - typeId: "example.alpha"\n' +
      '    requiredAttributes: []\n    optionalAttributes:\n      - "value"\n' +
      '    lifecycle:\n      - "active"\n      - "draft"\n' +
      'relationTypes:\n  - predicate: "example.refers_to"\n' +
      '    sourceTypes:\n      - "example.alpha"\n' +
      '    targetTypes:\n      - "example.alpha"\n',
  );

  assert.equal(result.entityTypes[0].typeId, "example.alpha");

  const malformedEntityType = await readSource(
    'format: "morivyx.schema/0.1"\n' +
      'schemaId: "example.test"\nversion: "0.1"\n' +
      'stableIdScheme: "urn-uuid-v4"\ndigestAlgorithm: "sha256"\n' +
      'reviewStates:\n  - "unreviewed"\nentityTypes:\n  - 1\n' +
      'relationTypes: []\nauthoringOrders:\n' +
      '  root:\n    - "format"\n  attributes: []\n' +
      '  provenance:\n    - "method"\n',
  );
  assert.throws(
    () => validateSchemaDefinition(malformedEntityType, "/tmp/schema.yaml"),
    (error) =>
      error instanceof PackageError &&
      error.code === "SCHEMA_DEFINITION_INVALID" &&
      error.path === "/tmp/schema.yaml#/entityTypes/0",
  );
});

test("accepts an ascending Trace Report missing set", async () => {
  const result = await readSource(
    'format: "morivyx.trace-report/0.1"\nmissing:\n' +
      '  - "governs"\n  - "produces"\n',
  );

  assert.deepEqual(result.missing, ["governs", "produces"]);
});

test("rejects unordered and duplicate authoring sets", async (t) => {
  const cases = [
    [
      "review states",
      'format: "morivyx.schema/0.1"\nreviewStates:\n  - "z"\n  - "a"\n',
      "#/reviewStates/1",
    ],
    [
      "NFC duplicate",
      'format: "morivyx.schema/0.1"\nreviewStates:\n  - "é"\n  - "é"\n',
      "#/reviewStates/1",
    ],
    [
      "entity types",
      'format: "morivyx.schema/0.1"\nentityTypes:\n' +
        '  - typeId: "example.z"\n  - typeId: "example.a"\n',
      "#/entityTypes/1/typeId",
    ],
    [
      "required attributes",
      'format: "morivyx.schema/0.1"\nentityTypes:\n' +
        '  - typeId: "example.a"\n    requiredAttributes:\n' +
        '      - "z"\n      - "a"\n',
      "#/entityTypes/0/requiredAttributes/1",
    ],
    [
      "entity lifecycle",
      'format: "morivyx.schema/0.1"\nentityTypes:\n' +
        '  - typeId: "example.a"\n    lifecycle:\n      - "draft"\n' +
        '      - "active"\n',
      "#/entityTypes/0/lifecycle/1",
    ],
    [
      "optional attributes",
      'format: "morivyx.schema/0.1"\nentityTypes:\n' +
        '  - typeId: "example.a"\n    optionalAttributes:\n' +
        '      - "value"\n      - "value"\n',
      "#/entityTypes/0/optionalAttributes/1",
    ],
    [
      "relation types",
      'format: "morivyx.schema/0.1"\nrelationTypes:\n' +
        '  - predicate: "example.z"\n  - predicate: "example.a"\n',
      "#/relationTypes/1/predicate",
    ],
    [
      "relation sources",
      'format: "morivyx.schema/0.1"\nrelationTypes:\n' +
        '  - predicate: "example.a"\n    sourceTypes:\n' +
        '      - "example.z"\n      - "example.a"\n',
      "#/relationTypes/0/sourceTypes/1",
    ],
    [
      "relation targets",
      'format: "morivyx.schema/0.1"\nrelationTypes:\n' +
        '  - predicate: "example.a"\n    targetTypes:\n' +
        '      - "example.z"\n      - "example.a"\n',
      "#/relationTypes/0/targetTypes/1",
    ],
    [
      "Trace Report missing",
      'format: "morivyx.trace-report/0.1"\nmissing:\n  - "z"\n  - "a"\n',
      "#/missing/1",
    ],
    [
      "Trace Report missing NFC duplicate",
      'format: "morivyx.trace-report/0.1"\nmissing:\n  - "é"\n  - "é"\n',
      "#/missing/1",
    ],
  ];
  for (const [name, source, pathSuffix] of cases) {
    await t.test(name, () =>
      expectInvalid(source, "PACKAGE_SET_ORDER_INVALID", pathSuffix),
    );
  }
});
