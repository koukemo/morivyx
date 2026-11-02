import assert from "node:assert/strict";
import test from "node:test";
import { validateSchemaDefinition } from "../src/schema-definition.js";

function definition() {
  return {
    format: "morivyx.schema/0.1",
    schemaId: "example.test",
    version: "0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    reviewStates: ["approved", "unreviewed"],
    entityTypes: [
      {
        typeId: "example.observation",
        requiredAttributes: ["name"],
        optionalAttributes: ["recordedAt"],
        lifecycle: ["active", "draft"],
      },
    ],
    relationTypes: [
      {
        predicate: "refers_to",
        sourceTypes: ["example.observation"],
        targetTypes: ["example.observation"],
        minCount: 0,
        maxCount: null,
        cycle: "forbidden",
      },
    ],
    authoringOrders: {
      root: ["format", "id", "attributes"],
      attributes: [],
      provenance: ["method", "actor", "recordedAt"],
    },
  };
}

function rejectsAt(value, path) {
  assert.throws(
    () => validateSchemaDefinition(value, "/tmp/schema.yaml"),
    (error) => {
      assert.equal(error.code, "SCHEMA_DEFINITION_INVALID");
      assert.equal(error.path, path ? `/tmp/schema.yaml#${path}` : "/tmp/schema.yaml");
      return true;
    },
  );
}

test("accepts a closed Stage 1 Schema definition", () => {
  const value = definition();
  assert.equal(validateSchemaDefinition(value), value);

  const empty = definition();
  empty.entityTypes = [];
  empty.relationTypes = [];
  assert.equal(validateSchemaDefinition(empty), empty);
});

test("rejects an invalid root and Stage 1 scalar values", async (t) => {
  await t.test("root map", () => rejectsAt(null, ""));
  await t.test("unknown field", () =>
    rejectsAt({ ...definition(), unknown: true }, "/unknown"));
  for (const [name, value, path] of [
    ["format", { ...definition(), format: "morivyx.schema/9" }, "/format"],
    ["Schema ID", { ...definition(), schemaId: "core" }, "/schemaId"],
    ["version", { ...definition(), version: "v1" }, "/version"],
    [
      "stable ID scheme",
      { ...definition(), stableIdScheme: "uuid" },
      "/stableIdScheme",
    ],
    [
      "digest algorithm",
      { ...definition(), digestAlgorithm: "sha512" },
      "/digestAlgorithm",
    ],
  ]) {
    await t.test(name, () => rejectsAt(value, path));
  }
});

test("rejects invalid Schema string sets", async (t) => {
  const emptyReviewStates = definition();
  emptyReviewStates.reviewStates = [];
  await t.test("empty review states", () =>
    rejectsAt(emptyReviewStates, "/reviewStates"));

  const unsorted = definition();
  unsorted.reviewStates = ["unreviewed", "approved"];
  await t.test("unsorted", () => rejectsAt(unsorted, "/reviewStates/1"));

  const normalizedDuplicate = definition();
  normalizedDuplicate.reviewStates = ["e\u0301", "é"];
  await t.test("NFC duplicate", () =>
    rejectsAt(normalizedDuplicate, "/reviewStates/1"));

  const nonString = definition();
  nonString.reviewStates = [1];
  await t.test("non-string", () =>
    rejectsAt(nonString, "/reviewStates/0"));
});

test("rejects invalid Entity type definitions", async (t) => {
  const invalidList = definition();
  invalidList.entityTypes = {};
  await t.test("entry list", () => rejectsAt(invalidList, "/entityTypes"));

  const invalidMap = definition();
  invalidMap.entityTypes = [null];
  await t.test("entry map", () => rejectsAt(invalidMap, "/entityTypes/0"));

  const unknown = definition();
  unknown.entityTypes[0].unknown = true;
  await t.test("unknown field", () =>
    rejectsAt(unknown, "/entityTypes/0/unknown"));

  const typeId = definition();
  typeId.entityTypes[0].typeId = "observation";
  await t.test("type ID", () =>
    rejectsAt(typeId, "/entityTypes/0/typeId"));

  const emptyOptional = definition();
  emptyOptional.entityTypes[0].optionalAttributes = [];
  await t.test("empty optional attributes", () =>
    rejectsAt(emptyOptional, "/entityTypes/0/optionalAttributes"));

  const overlap = definition();
  overlap.entityTypes[0].optionalAttributes = ["name"];
  await t.test("required and optional overlap", () =>
    rejectsAt(overlap, "/entityTypes/0/optionalAttributes/0"));

  const emptyLifecycle = definition();
  emptyLifecycle.entityTypes[0].lifecycle = [];
  await t.test("empty lifecycle", () =>
    rejectsAt(emptyLifecycle, "/entityTypes/0/lifecycle"));

  const duplicateTypes = definition();
  duplicateTypes.entityTypes.push(structuredClone(duplicateTypes.entityTypes[0]));
  await t.test("duplicate type ID", () =>
    rejectsAt(duplicateTypes, "/entityTypes/1/typeId"));
});

test("rejects invalid Relation type definitions", async (t) => {
  const invalidList = definition();
  invalidList.relationTypes = {};
  await t.test("entry list", () => rejectsAt(invalidList, "/relationTypes"));

  const invalidMap = definition();
  invalidMap.relationTypes = [null];
  await t.test("entry map", () =>
    rejectsAt(invalidMap, "/relationTypes/0"));

  const unknown = definition();
  unknown.relationTypes[0].unknown = true;
  await t.test("unknown field", () =>
    rejectsAt(unknown, "/relationTypes/0/unknown"));

  const emptyPredicate = definition();
  emptyPredicate.relationTypes[0].predicate = "";
  await t.test("predicate", () =>
    rejectsAt(emptyPredicate, "/relationTypes/0/predicate"));

  for (const field of ["sourceTypes", "targetTypes"]) {
    const emptyTypes = definition();
    emptyTypes.relationTypes[0][field] = [];
    await t.test(`empty ${field}`, () =>
      rejectsAt(emptyTypes, `/relationTypes/0/${field}`));
  }

  const invalidSource = definition();
  invalidSource.relationTypes[0].sourceTypes = ["observation"];
  await t.test("source type ID", () =>
    rejectsAt(invalidSource, "/relationTypes/0/sourceTypes/0"));

  for (const [name, minCount, maxCount, path] of [
    ["negative minimum", -1, null, "/relationTypes/0/minCount"],
    ["unsafe minimum", Number.MAX_SAFE_INTEGER + 1, null, "/relationTypes/0/minCount"],
    ["maximum below minimum", 2, 1, "/relationTypes/0/maxCount"],
    ["non-integer maximum", 0, 1.5, "/relationTypes/0/maxCount"],
  ]) {
    const value = definition();
    value.relationTypes[0].minCount = minCount;
    value.relationTypes[0].maxCount = maxCount;
    await t.test(name, () => rejectsAt(value, path));
  }

  const cycle = definition();
  cycle.relationTypes[0].cycle = "sometimes";
  await t.test("cycle", () => rejectsAt(cycle, "/relationTypes/0/cycle"));

  const duplicatePredicates = definition();
  duplicatePredicates.relationTypes.push(
    structuredClone(duplicatePredicates.relationTypes[0]),
  );
  await t.test("duplicate predicate", () =>
    rejectsAt(duplicatePredicates, "/relationTypes/1/predicate"));
});

test("rejects invalid authoring orders", async (t) => {
  const map = definition();
  map.authoringOrders = [];
  await t.test("map", () => rejectsAt(map, "/authoringOrders"));

  const unknown = definition();
  unknown.authoringOrders.unknown = [];
  await t.test("unknown field", () =>
    rejectsAt(unknown, "/authoringOrders/unknown"));

  const missing = definition();
  delete missing.authoringOrders.root;
  await t.test("missing list", () =>
    rejectsAt(missing, "/authoringOrders/root"));

  const duplicate = definition();
  duplicate.authoringOrders.root = ["id", "id"];
  await t.test("duplicate field", () =>
    rejectsAt(duplicate, "/authoringOrders/root/1"));

  const nonString = definition();
  nonString.authoringOrders.provenance = [1];
  await t.test("non-string field", () =>
    rejectsAt(nonString, "/authoringOrders/provenance/0"));
});
