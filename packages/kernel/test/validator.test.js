import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  graphRootDigest,
  revisionId,
  schemaDefinitionDigest,
  schemaLockDigest,
} from "../src/canonical.js";
import { validateGraphConstraints } from "../src/graph-constraints.js";
import { resolveSchemaRegistry } from "../src/schema-registry.js";
import { validatePhase7 } from "../src/validation-phase-7.js";
import { compareIssues, validateGraph } from "../src/validator.js";
import { yaml } from "../test-support/yaml.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

const schema = {
  format: "morivyx.schema/0.1",
  schemaId: "morivyx.core",
  version: "0.1",
  stableIdScheme: "urn-uuid-v4",
  digestAlgorithm: "sha256",
  reviewStates: ["approved", "proposed", "rejected", "unreviewed"],
  entityTypes: [
    {
      typeId: "core.artifact",
      requiredAttributes: ["artifactKind", "uri"],
      optionalAttributes: ["digest"],
      lifecycle: ["active", "draft"],
    },
    {
      typeId: "core.criterion",
      requiredAttributes: ["evaluationRule", "method", "necessity"],
      lifecycle: ["active", "draft"],
    },
    {
      typeId: "core.goal",
      requiredAttributes: ["beneficiaries", "scope", "statement"],
      lifecycle: ["active", "draft"],
    },
    {
      typeId: "core.learning",
      requiredAttributes: ["insight"],
      lifecycle: ["active", "draft", "retracted", "superseded"],
    },
    {
      typeId: "core.verification",
      requiredAttributes: ["method", "result"],
      lifecycle: ["accepted", "active", "draft"],
    },
  ],
  relationTypes: [
    {
      predicate: "against",
      sourceTypes: ["core.verification"],
      targetTypes: ["core.criterion"],
      minCount: 1,
      maxCount: 1,
      cycle: "not_applicable",
    },
    {
      predicate: "refines",
      sourceTypes: ["core.goal"],
      targetTypes: ["core.goal"],
      minCount: 0,
      maxCount: null,
      cycle: "forbidden",
    },
  ],
  authoringOrders: {
    root: [
      "format",
      "kind",
      "id",
      "type",
      "typeVersion",
      "revision",
      "lifecycle",
      "reviewState",
      "attributes",
      "provenance",
      "extensions",
    ],
    attributes: [],
    provenance: ["method", "actor", "recordedAt"],
  },
};

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(suffix, type, attributes) {
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
      recordedAt: "2026-08-30T15:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

function relation(suffix, source, target, predicate = "against") {
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
      recordedAt: "2026-08-30T15:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

function approval(suffix, target, overrides = {}) {
  return {
    format: "morivyx.approval/0.1",
    id: stableId(suffix),
    actor: stableId(900),
    targetId: target.id,
    targetRevision: target.revision,
    operation: "approve",
    scope: "single-revision",
    approvedAt: "2026-08-30T15:01:00Z",
    recordedAt: "2026-08-30T15:02:00Z",
    ...overrides,
  };
}

function validate(elements, registryIssues = [], options = {}) {
  return validateGraph({
    graphRevision: "graph:stage-1-validator-v1",
    schemaLockDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    schemas: new Map([["morivyx.core@0.1", schema]]),
    elements,
    registryIssues,
    ...options,
  });
}

function validElements() {
  const criterion = entity(1, "core.criterion", {
    evaluationRule: "manual",
    method: "inspection",
    necessity: "required",
  });
  const artifact = entity(2, "core.artifact", {
    artifactKind: "document",
    uri: "https://example.test/artifact",
  });
  const verification = entity(3, "core.verification", {
    method: "inspection",
    result: "passed",
  });
  return [
    criterion,
    artifact,
    verification,
    relation(13, verification.id, criterion.id),
  ];
}

async function createPackage(elements, approvals = []) {
  const root = await mkdtemp(join(tmpdir(), "morivyx-validator-"));
  const directory = join(root, ".morivyx");
  const schemaDirectory = join(directory, "schemas");
  const entityDirectory = join(directory, "graph", "entities");
  const relationDirectory = join(directory, "graph", "relations");
  const approvalDirectory = join(directory, "approvals");
  await mkdir(schemaDirectory, { recursive: true });
  await mkdir(entityDirectory, { recursive: true });
  await mkdir(relationDirectory, { recursive: true });
  await mkdir(approvalDirectory, { recursive: true });

  const definitionDigest = schemaDefinitionDigest(schema);
  const lock = {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas: [
      { schemaId: "morivyx.core", version: "0.1", digest: definitionDigest },
    ],
  };
  const artifact = entity(2, "core.artifact", {
    artifactKind: "document",
    uri: "https://example.test/artifact",
  });
  const packageElements = elements ?? [artifact];
  const rootDigest = graphRootDigest(packageElements);
  const revision = {
    format: "morivyx.graph-revision/0.1",
    id: "graph:validator-command-v1",
    parentRevision: null,
    rootDigest,
    schemaLockDigest: schemaLockDigest(lock),
  };

  await Promise.all([
    writeFile(
      join(schemaDirectory, "morivyx.core@0.1.yaml"),
      yaml(schema),
    ),
    writeFile(join(directory, "schema.lock.yaml"), yaml(lock)),
    writeFile(join(directory, "revision.yaml"), yaml(revision)),
    ...packageElements.map((element) =>
      writeFile(
        join(
          element.kind === "entity" ? entityDirectory : relationDirectory,
          `${element.id.slice("urn:uuid:".length)}.yaml`,
        ),
        yaml(element),
      ),
    ),
    ...approvals.map((record) =>
      writeFile(
        join(
          approvalDirectory,
          `${record.id.slice("urn:uuid:".length)}.yaml`,
        ),
        yaml(record),
      ),
    ),
  ]);
  return { root, directory, lock };
}

test("accepts the phase 2 to 4 validation vector", () => {
  const result = validate(validElements());
  assert.deepEqual(result, {
    valid: true,
    schemaLockDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    graphRevision: "graph:stage-1-validator-v1",
    rootDigest: graphRootDigest(validElements()),
    issues: [],
  });
});

test("reports malformed GraphElements without throwing or unstable ordering", () => {
  const malformedEntity = entity(90, "core.artifact", null);
  malformedEntity.id = null;
  malformedEntity.revision = null;
  const malformedRelation = relation(91, stableId(1), stableId(2));
  malformedRelation.attributes = null;
  malformedRelation.revision = revisionId(malformedRelation);

  const result = validate([malformedRelation, malformedEntity]);

  assert.equal(result.valid, false);
  assert.equal(result.rootDigest, "");
  assert.deepEqual(result.issues, [
    {
      code: "SCHEMA_REQUIRED_FIELD",
      phase: 3,
      elementId: "",
      path: "/attributes",
      relatedId: "",
    },
    {
      code: "SCHEMA_REQUIRED_FIELD",
      phase: 3,
      elementId: "",
      path: "/id",
      relatedId: "",
    },
    {
      code: "SCHEMA_REQUIRED_FIELD",
      phase: 3,
      elementId: "",
      path: "/revision",
      relatedId: "",
    },
    {
      code: "SCHEMA_REQUIRED_FIELD",
      phase: 3,
      elementId: malformedRelation.id,
      path: "/attributes",
      relatedId: "",
    },
  ]);
  assert.equal(compareIssues(result.issues[0], result.issues[0]), 0);
  assert.deepEqual([...result.issues].sort(compareIssues), result.issues);
});

test("preserves an unknown Extension value and list order", () => {
  const elements = validElements();
  elements[1].extensions = {
    "example.device/reading": { labels: ["first", "second"], value: "42" },
  };
  const before = structuredClone(elements);

  assert.equal(validate(elements).valid, true);
  assert.deepEqual(elements, before);
});

test("reports required, unknown Core, and version issues in phase 3", () => {
  const elements = validElements();
  delete elements[1].lifecycle;
  elements[1]["core.unregisteredField"] = "value";
  elements[2].typeVersion = "0.2";

  assert.deepEqual(validate(elements).issues, [
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(2),
      path: "/core.unregisteredField",
      relatedId: "",
    },
    {
      code: "SCHEMA_REQUIRED_FIELD",
      phase: 3,
      elementId: stableId(2),
      path: "/lifecycle",
      relatedId: "",
    },
    {
      code: "SCHEMA_VERSION_MISMATCH",
      phase: 3,
      elementId: stableId(3),
      path: "/typeVersion",
      relatedId: "",
    },
  ]);
});

test("escapes dynamic root and attribute JSON Pointer segments", () => {
  const elements = validElements();
  elements[0]["core.bad/key"] = true;
  elements[0]["core.bad~key"] = true;
  elements[0].attributes["bad/key"] = true;
  elements[0].attributes["bad~key"] = true;

  assert.deepEqual(validate(elements).issues, [
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(1),
      path: "/attributes/bad~0key",
      relatedId: "",
    },
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(1),
      path: "/attributes/bad~1key",
      relatedId: "",
    },
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(1),
      path: "/core.bad~0key",
      relatedId: "",
    },
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(1),
      path: "/core.bad~1key",
      relatedId: "",
    },
  ]);
});

test("reports Schema resolution and attribute issues in phase 3", () => {
  const elements = validElements();
  elements[0].type = "example.unknown";
  elements[1].reviewState = "unknown";
  elements[1].lifecycle = "unknown";
  delete elements[1].attributes.uri;
  elements[1].attributes.extra = "value";
  elements[3].attributes.source = null;
  elements[3].attributes.predicate = "unknown";
  elements[3].attributes.extra = "value";

  assert.deepEqual(
    validate(elements).issues.filter((entry) => entry.phase === 3),
    [
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(1),
        path: "/type",
        relatedId: "",
      },
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(2),
        path: "/attributes/extra",
        relatedId: "",
      },
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(2),
        path: "/lifecycle",
        relatedId: "",
      },
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(2),
        path: "/reviewState",
        relatedId: "",
      },
      {
        code: "SCHEMA_REQUIRED_FIELD",
        phase: 3,
        elementId: stableId(2),
        path: "/attributes/uri",
        relatedId: "",
      },
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(13),
        path: "/attributes/extra",
        relatedId: "",
      },
      {
        code: "CORE_UNKNOWN",
        phase: 3,
        elementId: stableId(13),
        path: "/attributes/predicate",
        relatedId: "",
      },
      {
        code: "SCHEMA_REQUIRED_FIELD",
        phase: 3,
        elementId: stableId(13),
        path: "/attributes/source",
        relatedId: "",
      },
    ],
  );

  for (const field of ["source", "target"]) {
    const malformedEndpointElements = validElements();
    malformedEndpointElements[3].attributes[field] = null;

    assert.deepEqual(
      validate(malformedEndpointElements).issues.filter(
        (entry) =>
          entry.elementId === stableId(13) &&
          (entry.path === `/attributes/${field}` || entry.path === `/${field}`),
      ),
      [
        {
          code: "SCHEMA_REQUIRED_FIELD",
          phase: 3,
          elementId: stableId(13),
          path: `/attributes/${field}`,
          relatedId: "",
        },
      ],
    );
  }
});

test("resolves many Schema types without repeated linear searches", () => {
  const typeCount = 10_000;
  const digest = (index) =>
    `sha256:${index.toString(16).padStart(64, "0")}`;
  const entityTypes = Array.from({ length: typeCount }, (_, index) => ({
    typeId: `example.type${String(index).padStart(5, "0")}`,
    requiredAttributes: [],
    lifecycle: ["active"],
  }));
  const largeSchema = {
    schemaId: "example.schema",
    version: "0.1",
    reviewStates: ["unreviewed"],
    entityTypes,
    relationTypes: [],
  };
  const elements = entityTypes.map(({ typeId }, index) => ({
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(10_000 + index),
    type: typeId,
    typeVersion: "0.1",
    revision: digest(index),
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: {},
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-08-30T15:00:00Z",
    },
  }));

  assert.equal(
    validateGraph({
      graphRevision: "graph:many-schema-types",
      schemaLockDigest: digest(typeCount),
      schemas: new Map([["example.schema@0.1", largeSchema]]),
      elements,
    }).valid,
    true,
  );
});

test("reports a Core Relation type that disagrees with its predicate", () => {
  const elements = validElements();
  elements[3].type = "core.evaluates";
  elements[3].revision = revisionId(elements[3]);

  assert.deepEqual(validate(elements).issues, [
    {
      code: "CORE_UNKNOWN",
      phase: 3,
      elementId: stableId(13),
      path: "/type",
      relatedId: "",
    },
  ]);
});

test("reports stable and Revision ID duplicates in deterministic order", () => {
  const elements = validElements();
  const duplicateId = structuredClone(elements[0]);
  duplicateId.type = "core.artifact";
  duplicateId.attributes = {
    artifactKind: "document",
    uri: "https://example.test/duplicate",
  };
  duplicateId.revision = revisionId(duplicateId);
  const duplicateRevision = structuredClone(elements[1]);
  duplicateRevision.id = stableId(4);
  elements.push(duplicateId, duplicateRevision);

  assert.deepEqual(
    validate(elements).issues.filter((entry) => entry.phase === 4),
    [
      {
        code: "ID_DUPLICATE",
        phase: 4,
        elementId: stableId(1),
        path: "/id",
        relatedId: stableId(1),
      },
      {
        code: "ID_DUPLICATE",
        phase: 4,
        elementId: stableId(2),
        path: "/revision",
        relatedId: stableId(4),
      },
    ],
  );
});

test("reports a missing Relation target in phase 5", () => {
  const elements = validElements();
  elements[3].attributes.target = stableId(99);

  assert.deepEqual(validate(elements).issues, [
    {
      code: "RELATION_TARGET_MISSING",
      phase: 5,
      elementId: stableId(13),
      path: "/target",
      relatedId: stableId(99),
    },
  ]);
});

test("reports a disallowed Relation endpoint type in phase 5", () => {
  const elements = validElements();
  elements[3].attributes.target = stableId(2);

  assert.deepEqual(validate(elements).issues, [
    {
      code: "RELATION_TYPE_DISALLOWED",
      phase: 5,
      elementId: stableId(13),
      path: "/target",
      relatedId: stableId(2),
    },
  ]);
});

test("reports Relation cardinality in phase 5", () => {
  const elements = validElements();
  const secondCriterion = entity(4, "core.criterion", {
    evaluationRule: "automated",
    method: "test",
    necessity: "required",
  });
  elements.push(
    secondCriterion,
    relation(14, stableId(3), secondCriterion.id),
  );

  assert.deepEqual(validate(elements).issues, [
    {
      code: "RELATION_CARDINALITY",
      phase: 5,
      elementId: stableId(3),
      path: "/relations/against",
      relatedId: "",
    },
  ]);
});

test("reports a Relation minimum cardinality in phase 5", () => {
  const elements = validElements().filter(
    (element) => element.kind !== "relation",
  );

  assert.deepEqual(validate(elements).issues, [
    {
      code: "RELATION_CARDINALITY",
      phase: 5,
      elementId: stableId(3),
      path: "/relations/against",
      relatedId: "",
    },
  ]);
});

test("handles empty and large Relation definition sets without repeated scans", () => {
  assert.deepEqual(
    validateGraphConstraints([], new Map([["example@0.1", {}]])),
    [],
  );

  const definitionCount = 10_000;
  const elements = Array.from({ length: definitionCount }, (_, index) => ({
    kind: "entity",
    id: `entity:${index}`,
    type: `example.type:${index}`,
  }));
  const relationTypes = Array.from(
    { length: definitionCount },
    (_, index) => ({
      predicate: `example.predicate:${index}`,
      sourceTypes: [`example.type:${index}`],
      targetTypes: [`example.type:${index}`],
      minCount: 0,
      maxCount: null,
      cycle: "not_applicable",
    }),
  );

  assert.deepEqual(
    validateGraphConstraints(
      elements,
      new Map([["example@0.1", { relationTypes }]]),
    ),
    [],
  );
});

test("preserves element order across cardinality source types", () => {
  const elements = [
    { kind: "entity", id: "entity:b", type: "example.b" },
    { kind: "entity", id: "entity:a", type: "example.a" },
  ];
  const relationTypes = [
    {
      predicate: "example.requires",
      sourceTypes: ["example.a", "example.b"],
      targetTypes: ["example.a"],
      minCount: 1,
      maxCount: null,
      cycle: "not_applicable",
    },
  ];

  assert.deepEqual(
    validateGraphConstraints(
      elements,
      new Map([["example@0.1", { relationTypes }]]),
    ),
    ["entity:b", "entity:a"].map((elementId) => ({
      code: "RELATION_CARDINALITY",
      phase: 5,
      elementId,
      path: "/relations/example.requires",
      relatedId: "",
    })),
  );
});

test("enforces produces cardinality per Artifact target", () => {
  const producesSchema = structuredClone(schema);
  producesSchema.relationTypes.push({
    predicate: "produces",
    sourceTypes: ["core.verification"],
    targetTypes: ["core.artifact"],
    minCount: 0,
    maxCount: 1,
    cycle: "not_applicable",
  });
  const schemas = new Map([["morivyx.core@0.1", producesSchema]]);
  const multipleArtifacts = validElements();
  const secondArtifact = entity(4, "core.artifact", {
    artifactKind: "document",
    uri: "https://example.test/second-artifact",
  });
  multipleArtifacts.push(
    secondArtifact,
    relation(14, stableId(3), stableId(2), "produces"),
    relation(15, stableId(3), secondArtifact.id, "produces"),
  );

  assert.equal(validate(multipleArtifacts, [], { schemas }).valid, true);

  const multipleProducers = validElements();
  const secondVerification = entity(4, "core.verification", {
    method: "inspection",
    result: "passed",
  });
  multipleProducers.push(
    secondVerification,
    relation(14, secondVerification.id, stableId(1)),
    relation(15, stableId(3), stableId(2), "produces"),
    relation(16, secondVerification.id, stableId(2), "produces"),
  );

  assert.deepEqual(validate(multipleProducers, [], { schemas }).issues, [
    {
      code: "RELATION_CARDINALITY",
      phase: 5,
      elementId: stableId(2),
      path: "/relations/produces",
      relatedId: "",
    },
  ]);
});

test("requires evidence and a challenge check for an accepted Decision", () => {
  const decisionSchema = structuredClone(schema);
  decisionSchema.entityTypes.push(
    {
      typeId: "core.decision",
      requiredAttributes: ["consequences", "question", "rationale"],
      optionalAttributes: ["challengeReview"],
      lifecycle: ["accepted", "active", "draft"],
    },
    {
      typeId: "core.knowledge",
      requiredAttributes: ["claim", "epistemicState", "scope"],
      lifecycle: ["active", "draft"],
    },
  );
  decisionSchema.relationTypes.push(
    {
      predicate: "challenged_by",
      sourceTypes: ["core.decision", "core.knowledge"],
      targetTypes: ["core.knowledge"],
      minCount: 1,
      maxCount: null,
      cycle: "not_applicable",
    },
    {
      predicate: "supported_by",
      sourceTypes: ["core.decision", "core.knowledge"],
      targetTypes: ["core.artifact", "core.knowledge"],
      minCount: 0,
      maxCount: null,
      cycle: "not_applicable",
    },
  );
  const schemas = new Map([["morivyx.core@0.1", decisionSchema]]);
  const decision = entity(4, "core.decision", {
    consequences: ["recorded"],
    question: "Which option?",
    rationale: "Evidence supports it.",
  });
  assert.equal(
    validate([...validElements(), decision], [], { schemas }).valid,
    true,
  );

  decision.lifecycle = "accepted";
  decision.revision = revisionId(decision);
  assert.deepEqual(
    validate([...validElements(), decision], [], { schemas }).issues,
    [
      {
        code: "RELATION_CARDINALITY",
        phase: 5,
        elementId: decision.id,
        path: "/relations/challenged_by",
        relatedId: "",
      },
      {
        code: "RELATION_CARDINALITY",
        phase: 5,
        elementId: decision.id,
        path: "/relations/supported_by",
        relatedId: "",
      },
    ],
  );

  const reviewedDecision = structuredClone(decision);
  reviewedDecision.attributes.challengeReview = { result: "none-found" };
  reviewedDecision.revision = revisionId(reviewedDecision);
  assert.equal(
    validate(
      [
        ...validElements(),
        reviewedDecision,
        relation(14, reviewedDecision.id, stableId(2), "supported_by"),
      ],
      [],
      { schemas },
    ).valid,
    true,
  );

  const knowledge = entity(5, "core.knowledge", {
    claim: "A counterexample was checked.",
    epistemicState: "observed",
    scope: "decision",
  });
  assert.equal(
    validate(
      [
        ...validElements(),
        decision,
        knowledge,
        relation(14, decision.id, stableId(2), "supported_by"),
        relation(15, decision.id, knowledge.id, "challenged_by"),
      ],
      [],
      { schemas },
    ).valid,
    true,
  );
});

test("reports a duplicate semantic Relation in phase 6", () => {
  const elements = validElements();
  elements.push(relation(14, stableId(3), stableId(1)));
  const issues = validate(elements).issues;

  assert.equal(issues[0].code, "RELATION_CARDINALITY");
  assert.deepEqual(issues[1], {
    code: "RELATION_DUPLICATE",
    phase: 6,
    elementId: stableId(13),
    path: "/relations/against",
    relatedId: stableId(14),
  });
});

test("reports a forbidden cycle with sorted stable IDs in phase 6", () => {
  const elements = validElements();
  const firstGoal = entity(21, "core.goal", {
    beneficiaries: ["team"],
    scope: "repository",
    statement: "first",
  });
  const secondGoal = entity(22, "core.goal", {
    beneficiaries: ["team"],
    scope: "repository",
    statement: "second",
  });
  elements.push(
    firstGoal,
    secondGoal,
    relation(31, firstGoal.id, secondGoal.id, "refines"),
    relation(32, secondGoal.id, firstGoal.id, "refines"),
  );

  assert.deepEqual(validate(elements).issues, [
    {
      code: "CYCLE_FORBIDDEN",
      phase: 6,
      elementId: stableId(21),
      path: "/relations/refines",
      relatedId: stableId(22),
    },
  ]);
});

test("selects many forbidden-cycle Relations without repeated scans", () => {
  const definitionCount = 10_000;
  const elements = [];
  const relationTypes = [];
  for (let index = 0; index < definitionCount; index += 1) {
    const type = `example.type:${index}`;
    const predicate = `example.predicate:${index}`;
    elements.push(
      { kind: "entity", id: `source:${index}`, type },
      { kind: "entity", id: `target:${index}`, type },
      {
        kind: "relation",
        id: `relation:${index}`,
        attributes: {
          source: `source:${index}`,
          predicate,
          target: `target:${index}`,
        },
      },
    );
    relationTypes.push({
      predicate,
      sourceTypes: [type],
      targetTypes: [type],
      minCount: 0,
      maxCount: null,
      cycle: "forbidden",
    });
  }

  assert.deepEqual(
    validateGraphConstraints(
      elements,
      new Map([["example@0.1", { relationTypes }]]),
    ),
    [],
  );
});

test("escapes a Schema predicate in a constraint JSON Pointer", () => {
  const predicate = "refines/~";
  const customSchema = structuredClone(schema);
  customSchema.relationTypes.find(
    (definition) => definition.predicate === "refines",
  ).predicate = predicate;
  const firstGoal = entity(21, "core.goal", {
    beneficiaries: ["team"],
    scope: "repository",
    statement: "first",
  });
  const secondGoal = entity(22, "core.goal", {
    beneficiaries: ["team"],
    scope: "repository",
    statement: "second",
  });
  const elements = [
    ...validElements(),
    firstGoal,
    secondGoal,
    relation(31, firstGoal.id, secondGoal.id, predicate),
    relation(32, secondGoal.id, firstGoal.id, predicate),
  ];

  assert.deepEqual(
    validate(elements, [], {
      schemas: new Map([["morivyx.core@0.1", customSchema]]),
    }).issues,
    [
      {
        code: "CYCLE_FORBIDDEN",
        phase: 6,
        elementId: stableId(21),
        path: "/relations/refines~1~0",
        relatedId: stableId(22),
      },
    ],
  );
});

test("finds a forbidden cycle deeper than the JavaScript call stack", () => {
  const nodeCount = 5_000;
  const nodeId = (index) => `node-${String(index).padStart(5, "0")}`;
  const elements = Array.from({ length: nodeCount }, (_, index) => ({
    id: nodeId(index),
    kind: "entity",
    type: "node",
    attributes: {},
  }));
  for (let index = 0; index < nodeCount; index += 1) {
    elements.push({
      id: `edge-${String(index).padStart(5, "0")}`,
      kind: "relation",
      type: "edge",
      attributes: {
        source: nodeId(index),
        predicate: "next",
        target: nodeId((index + 1) % nodeCount),
      },
    });
  }
  const schemas = new Map([
    [
      "test@0.1",
      {
        relationTypes: [
          {
            predicate: "next",
            sourceTypes: ["node"],
            targetTypes: ["node"],
            minCount: 0,
            maxCount: null,
            cycle: "forbidden",
          },
        ],
      },
    ],
  ]);

  assert.deepEqual(validateGraphConstraints(elements, schemas), [
    {
      code: "CYCLE_FORBIDDEN",
      phase: 6,
      elementId: nodeId(0),
      path: "/relations/next",
      relatedId: nodeId(1),
    },
  ]);
});

test("reports a forbidden Criterion lifecycle transition in phase 7", () => {
  const previousElements = validElements();
  const elements = structuredClone(previousElements);
  elements[0].lifecycle = "draft";
  elements[0].revision = revisionId(elements[0]);

  assert.deepEqual(validate(elements, [], { previousElements }).issues, [
    {
      code: "LIFECYCLE_TRANSITION",
      phase: 7,
      elementId: stableId(1),
      path: "/lifecycle",
      relatedId: "",
    },
  ]);
});

test("accepts an allowed Criterion lifecycle transition", () => {
  const elements = validElements();
  const previousElements = structuredClone(elements);
  previousElements[0].lifecycle = "draft";
  previousElements[0].revision = revisionId(previousElements[0]);

  assert.equal(validate(elements, [], { previousElements }).valid, true);
});

test("reports a forbidden Learning lifecycle transition in phase 7", () => {
  const previous = entity(5, "core.learning", { insight: "found" });
  const current = structuredClone(previous);
  current.lifecycle = "draft";
  current.revision = revisionId(current);

  assert.deepEqual(
    validate([current], [], { previousElements: [previous] }).issues,
    [
      {
        code: "LIFECYCLE_TRANSITION",
        phase: 7,
        elementId: stableId(5),
        path: "/lifecycle",
        relatedId: "",
      },
    ],
  );
});

test("reports missing GraphElement and approval Provenance in phase 7", () => {
  const elements = validElements();
  delete elements[1].provenance;
  delete elements[2].provenance.actor;
  const incompleteApproval = approval(70, elements[0]);
  delete incompleteApproval.actor;

  assert.deepEqual(
    validate(elements, [], { approvals: [incompleteApproval] }).issues,
    [
      {
        code: "PROVENANCE_REQUIRED",
        phase: 7,
        elementId: stableId(1),
        path: `/approvals/${stableId(70)}/actor`,
        relatedId: stableId(70),
      },
      {
        code: "PROVENANCE_REQUIRED",
        phase: 7,
        elementId: stableId(2),
        path: "/provenance",
        relatedId: "",
      },
      {
        code: "PROVENANCE_REQUIRED",
        phase: 7,
        elementId: stableId(3),
        path: "/provenance/actor",
        relatedId: "",
      },
    ],
  );
});

test("requires an applicable approval for an approved Revision", () => {
  const elements = validElements();
  elements[1].reviewState = "approved";
  elements[1].revision = revisionId(elements[1]);

  assert.deepEqual(validate(elements).issues, [
    {
      code: "APPROVAL_REQUIRED",
      phase: 7,
      elementId: stableId(2),
      path: "/reviewState",
      relatedId: "",
    },
  ]);

  assert.equal(
    validate(elements, [], { approvals: [approval(70, elements[1])] }).valid,
    true,
  );
});

test("does not apply a revoked approval", () => {
  const elements = validElements();
  elements[1].reviewState = "approved";
  elements[1].revision = revisionId(elements[1]);
  const granted = approval(70, elements[1]);
  const revoked = approval(71, elements[1], {
    operation: "revoke",
    revokes: granted.id,
  });

  assert.deepEqual(
    validate(elements, [], { approvals: [granted, revoked] }).issues,
    [
      {
        code: "APPROVAL_REQUIRED",
        phase: 7,
        elementId: stableId(2),
        path: "/reviewState",
        relatedId: "",
      },
    ],
  );
});

test("matches many approved Revisions without repeated Approval scans", () => {
  const approvalCount = 10_000;
  const elements = Array.from({ length: approvalCount }, (_, index) => ({
    id: stableId(20_000 + index),
    type: "core.artifact",
    revision: `revision:${index}`,
    lifecycle: "active",
    reviewState: "approved",
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-08-30T15:00:00Z",
    },
  }));
  const approvals = elements.map((element, index) =>
    approval(100_000 + index, element),
  );

  assert.deepEqual(validatePhase7(elements, { approvals }), []);
});

test("does not mutate phase 7 inputs", () => {
  const elements = validElements();
  const previousElements = structuredClone(elements);
  const approvals = [approval(70, elements[1])];
  const before = structuredClone({ elements, previousElements, approvals });

  validate(elements, [], { previousElements, approvals });
  assert.deepEqual({ elements, previousElements, approvals }, before);
});

test("stops after a Schema registry issue", () => {
  const elements = validElements();
  delete elements[0].lifecycle;
  const registryIssue = {
    code: "SCHEMA_LOCK_MISSING",
    phase: 2,
    elementId: "",
    path: "/schemas/morivyx.core@0.1",
    relatedId: "",
  };

  assert.deepEqual(validate(elements, [registryIssue]).issues, [registryIssue]);
});

test("resolves only locked Schema files and rejects missing or conflicting content", async (t) => {
  const packageData = await createPackage();
  t.after(() => rm(packageData.root, { recursive: true, force: true }));
  const resolved = await resolveSchemaRegistry(
    packageData.directory,
    packageData.lock,
  );
  assert.equal(resolved.issues.length, 0);
  assert.equal(resolved.schemas.get("morivyx.core@0.1").version, "0.1");

  await Promise.all([
    writeFile(join(packageData.directory, "schemas", "z-extra.yaml"), "---\n"),
    writeFile(join(packageData.directory, "schemas", "a-extra.yaml"), "---\n"),
  ]);
  const unlocked = await resolveSchemaRegistry(
    packageData.directory,
    packageData.lock,
  );
  assert.deepEqual(
    unlocked.issues.map(({ code, path }) => ({ code, path })),
    [
      { code: "SCHEMA_LOCK_CONFLICT", path: "/schemas/a-extra.yaml" },
      { code: "SCHEMA_LOCK_CONFLICT", path: "/schemas/z-extra.yaml" },
    ],
  );

  const missing = await resolveSchemaRegistry(
    join(packageData.root, "other"),
    packageData.lock,
  );
  assert.equal(missing.issues[0].code, "SCHEMA_LOCK_MISSING");

  const conflictDirectory = join(packageData.root, "conflict");
  await mkdir(join(conflictDirectory, "schemas"), { recursive: true });
  await writeFile(
    join(conflictDirectory, "schemas", "morivyx.core@0.1.yaml"),
    yaml({ ...schema, reviewStates: ["unreviewed"] }),
  );
  const conflict = await resolveSchemaRegistry(conflictDirectory, packageData.lock);
  assert.equal(conflict.issues[0].code, "SCHEMA_LOCK_CONFLICT");

  const invalidDirectory = join(packageData.root, "invalid");
  await mkdir(join(invalidDirectory, "schemas"), { recursive: true });
  await writeFile(
    join(invalidDirectory, "schemas", "morivyx.core@0.1.yaml"),
    yaml({ ...schema, stableIdScheme: "unsupported" }),
  );
  const invalid = await resolveSchemaRegistry(invalidDirectory, packageData.lock);
  assert.deepEqual(invalid.issues, [
    {
      code: "SCHEMA_LOCK_CONFLICT",
      phase: 2,
      elementId: "",
      path: "/schemas/morivyx.core@0.1",
      relatedId: "",
    },
  ]);
});

test("rejects malformed Schema lock identifiers before file resolution", async (t) => {
  const packageData = await createPackage();
  t.after(() => rm(packageData.root, { recursive: true, force: true }));
  const digest = packageData.lock.schemas[0].digest;
  const resolved = await resolveSchemaRegistry(
    join(packageData.root, "missing-schema-root"),
    {
      schemas: [
        { schemaId: "Morivyx.core", version: "0.1", digest },
        { schemaId: "morivyx.core", version: "next", digest },
      ],
    },
  );

  assert.equal(resolved.schemas.size, 0);
  assert.deepEqual(resolved.issues, [
    {
      code: "SCHEMA_LOCK_CONFLICT",
      phase: 2,
      elementId: "",
      path: "/schemas/Morivyx.core@0.1",
      relatedId: "",
    },
    {
      code: "SCHEMA_LOCK_CONFLICT",
      phase: 2,
      elementId: "",
      path: "/schemas/morivyx.core@next",
      relatedId: "",
    },
  ]);
});

test("matches the repository Core Schema definition digest", async () => {
  const path = join(
    testDirectory,
    "..",
    "..",
    "..",
    "docs",
    "schema",
    "morivyx.core@0.1.yaml",
  );
  const definition = parse(await readFile(path, "utf8"));
  assert.equal(
    schemaDefinitionDigest(definition),
    "sha256:f3bfeb8caaaf7ef46c847dd23c16845fedf6cd1c4547e75bd607961c995c90da",
  );
  assert.deepEqual(
    definition.relationTypes
      .filter((relation) => relation.minCount > 0)
      .map(({ predicate, minCount, maxCount }) => ({
        predicate,
        minCount,
        maxCount,
      })),
    [
      { predicate: "against", minCount: 1, maxCount: 1 },
      { predicate: "evaluates", minCount: 1, maxCount: null },
    ],
  );
});

test("prints a valid JSON result from the validate command", async () => {
  const packageData = await createPackage();
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "validate", packageData.root],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.graphRevision, "graph:validator-command-v1");
});

test("reads an applicable approval in the validate command", async () => {
  const artifact = entity(2, "core.artifact", {
    artifactKind: "document",
    uri: "https://example.test/artifact",
  });
  artifact.reviewState = "approved";
  artifact.revision = revisionId(artifact);
  const packageData = await createPackage(
    [artifact],
    [approval(70, artifact)],
  );
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "validate", packageData.root],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
});

test("prints a coded phase 5 issue from the validate command", async () => {
  const verification = entity(3, "core.verification", {
    method: "inspection",
    result: "passed",
  });
  const missingTarget = stableId(99);
  const packageData = await createPackage([
    verification,
    relation(13, verification.id, missingTarget),
  ]);
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "validate", packageData.root],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, false);
  assert.deepEqual(output.issues[0], {
    code: "RELATION_TARGET_MISSING",
    phase: 5,
    elementId: stableId(13),
    path: "/target",
    relatedId: missingTarget,
  });
});

test("exits with a coded phase 2 issue when validate cannot resolve a Schema", async () => {
  const packageData = await createPackage();
  const missingSchemaRoot = join(packageData.root, "without-schema");
  await mkdir(join(missingSchemaRoot, ".morivyx"), { recursive: true });
  const sourceDirectory = packageData.directory;
  const targetDirectory = join(missingSchemaRoot, ".morivyx");
  await cp(sourceDirectory, targetDirectory, { recursive: true });
  await rm(join(targetDirectory, "schemas"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "..", "src", "cli.js"), "validate", missingSchemaRoot],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, false);
  assert.equal(output.issues[0].code, "SCHEMA_LOCK_MISSING");
  assert.equal(output.issues[0].phase, 2);
});
