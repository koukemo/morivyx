import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { revisionId } from "../src/canonical.js";
import { projectDecisionMarkdown } from "../src/decision-markdown.js";
import { PackageError } from "../src/errors.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function stableId(suffix) {
  return `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function entity(
  suffix,
  type,
  attributes = {},
  lifecycle = "active",
  reviewState = "unreviewed",
) {
  const record = {
    format: "morivyx.git-graph/0.1",
    kind: "entity",
    id: stableId(suffix),
    type,
    typeVersion: "0.1",
    lifecycle,
    reviewState,
    attributes,
    provenance: {
      method: "asserted",
      actor: stableId(900),
      recordedAt: "2026-09-01T16:00:00Z",
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
      recordedAt: "2026-09-01T16:00:00Z",
    },
  };
  record.revision = revisionId(record);
  return record;
}

async function readVector() {
  return JSON.parse(
    await readFile(
      join(testDirectory, "fixtures", "decision-markdown-vector.json"),
      "utf8",
    ),
  );
}

function vectorElements(vector, reverse = false) {
  const descriptor = vector.input.decision;
  const attributes = reverse
    ? Object.fromEntries(
        Object.entries(descriptor.attributes)
          .reverse()
          .map(([key, value]) => [
            key,
            key === "challengeReview"
              ? Object.fromEntries(Object.entries(value).reverse())
              : value,
          ]),
      )
    : structuredClone(descriptor.attributes);
  const decision = entity(
    descriptor.suffix,
    "core.decision",
    attributes,
    descriptor.lifecycle,
    descriptor.reviewState,
  );
  const byAlias = new Map([["decision", decision]]);
  for (const entry of vector.input.entities) {
    byAlias.set(entry.alias, entity(entry.suffix, entry.type));
  }
  const relations = vector.input.relations.map((entry) =>
    relation(
      entry.suffix,
      decision.id,
      entry.predicate,
      byAlias.get(entry.to).id,
    ),
  );
  const elements = [...byAlias.values(), ...relations];
  return { decision, elements: reverse ? elements.reverse() : elements };
}

function projectionInput(vector, elements, decisionId) {
  return {
    graphRevision: vector.input.graphRevision,
    decisionId,
    elements,
    projectorPackageDigest: vector.input.projectorPackageDigest,
  };
}

function expectInputError(input, path) {
  assert.throws(
    () => projectDecisionMarkdown(input),
    (error) =>
      error instanceof PackageError &&
      error.code === "DECISION_PROJECTION_INPUT_INVALID" &&
      error.path === path,
  );
}

test("matches the fixed Decision Markdown Projection vector", async () => {
  const vector = await readVector();
  const { decision, elements } = vectorElements(vector);
  const before = structuredClone(elements);
  const projection = projectDecisionMarkdown(
    projectionInput(vector, elements, decision.id),
  );

  assert.equal(
    projection.format,
    "morivyx.decision-markdown-projection/0.1",
  );
  assert.equal(projection.graphRevision, vector.input.graphRevision);
  assert.equal(projection.sourceId, decision.id);
  assert.equal(projection.sourceRevision, vector.expected.sourceRevision);
  assert.equal(projection.rulesDigest, vector.expected.rulesDigest);
  assert.equal(
    projection.configurationDigest,
    vector.expected.configurationDigest,
  );
  assert.equal(projection.digest, vector.expected.digest);
  assert.equal(projection.mediaType, "text/markdown; charset=utf-8");
  assert.equal(Buffer.byteLength(projection.markdown), vector.expected.byteLength);
  assert.equal(
    projection.markdown.split("\n").length - 1,
    vector.expected.lineCount,
  );
  assert.equal(
    `sha256:${createHash("sha256").update(projection.markdown).digest("hex")}`,
    projection.digest,
  );
  assert.equal(projection.markdown.endsWith("\n"), true);
  assert.equal(projection.markdown.includes("\r"), false);
  assert.ok(projection.markdown.includes("Use \\*\\*Graph\\*\\* \\[now\\]?"));
  assert.ok(projection.markdown.includes("\\# Evidence\n\\- Keep history\\."));
  assert.ok(projection.markdown.includes("- Keep \\`history\\`\\."));
  assert.ok(projection.markdown.includes("- Avoid \\<copy\\>\\."));
  assert.deepEqual(
    [...projection.markdown.matchAll(/（`([^`]+)`）/g)].map(
      ([, predicate]) => predicate,
    ),
    vector.expected.relationPredicates,
  );
  assert.deepEqual(elements, before);

  const reversed = vectorElements(vector, true);
  assert.deepEqual(
    projectDecisionMarkdown(
      projectionInput(vector, reversed.elements, reversed.decision.id),
    ),
    projection,
  );

  const escaped = vectorElements(vector);
  escaped.decision.attributes.question = "tab\tbell\u0007";
  escaped.decision.revision = revisionId(escaped.decision);
  assert.ok(
    projectDecisionMarkdown(
      projectionInput(vector, escaped.elements, escaped.decision.id),
    ).markdown.includes("tab    bell\\\\u0007"),
  );

  const blockSyntax = vectorElements(vector);
  blockSyntax.decision.attributes.question =
    "before\n~~~\nafter\nTitle\n===\n    indented";
  blockSyntax.decision.attributes.consequences = [
    "first\n- injected item\n    continuation",
  ];
  blockSyntax.decision.revision = revisionId(blockSyntax.decision);
  const blockSafeMarkdown = projectDecisionMarkdown(
    projectionInput(vector, blockSyntax.elements, blockSyntax.decision.id),
  ).markdown;
  assert.ok(
    blockSafeMarkdown.includes(
      "before\n\\~\\~\\~\nafter\nTitle\n\\=\\=\\=\n" +
        "&#32;&#32;&#32;&#32;indented",
    ),
  );
  assert.ok(
    blockSafeMarkdown.includes(
      "- first\n  \\- injected item\n  &#32;&#32;&#32;&#32;continuation",
    ),
  );

  const composed = vectorElements(vector);
  composed.decision.attributes.question = "Caf\u00e9";
  composed.decision.revision = revisionId(composed.decision);
  const decomposed = vectorElements(vector);
  decomposed.decision.attributes.question = "Cafe\u0301";
  decomposed.decision.revision = revisionId(decomposed.decision);
  assert.deepEqual(
    projectDecisionMarkdown(
      projectionInput(vector, decomposed.elements, decomposed.decision.id),
    ),
    projectDecisionMarkdown(
      projectionInput(vector, composed.elements, composed.decision.id),
    ),
  );

  assert.deepEqual(
    projectDecisionMarkdown({
      ...projectionInput(vector, elements, decision.id),
      graphRevision: "graph:Cafe\u0301",
    }),
    projectDecisionMarkdown({
      ...projectionInput(vector, elements, decision.id),
      graphRevision: "graph:Caf\u00e9",
    }),
  );
});

test("rejects invalid Decision Markdown Projection inputs", async () => {
  const vector = await readVector();
  const { decision, elements } = vectorElements(vector);
  const input = projectionInput(vector, elements, decision.id);

  expectInputError(null, "");
  expectInputError({ ...input, extra: true }, "/extra");
  expectInputError({ ...input, graphRevision: "invalid" }, "/graphRevision");
  expectInputError({ ...input, decisionId: "invalid" }, "/decisionId");
  expectInputError(
    { ...input, projectorPackageDigest: "invalid" },
    "/projectorPackageDigest",
  );
  expectInputError({ ...input, elements: {} }, "/elements");
  expectInputError({ ...input, decisionId: stableId(99) }, "/decisionId");
  expectInputError({ ...input, decisionId: elements[1].id }, "/decisionId");
  expectInputError(
    { ...input, elements: [...elements, elements[0]] },
    `/elements/${elements.length}/id`,
  );

  const dangling = structuredClone(elements);
  dangling.at(-1).attributes.target = stableId(99);
  expectInputError(
    { ...input, elements: dangling },
    `/elements/${dangling.length - 1}/attributes/target`,
  );
  const mismatched = structuredClone(elements);
  mismatched.at(-1).type = "core.addresses";
  expectInputError(
    { ...input, elements: mismatched },
    `/elements/${mismatched.length - 1}/type`,
  );
  const invalidSource = structuredClone(elements);
  invalidSource.at(-1).attributes.source = "invalid";
  expectInputError(
    { ...input, elements: invalidSource },
    `/elements/${invalidSource.length - 1}/attributes/source`,
  );
  const relationEndpoint = structuredClone(elements);
  relationEndpoint.at(-1).attributes.target = relationEndpoint.at(-2).id;
  expectInputError(
    { ...input, elements: relationEndpoint },
    `/elements/${relationEndpoint.length - 1}/attributes/target`,
  );

  const missingQuestion = structuredClone(elements);
  delete missingQuestion[0].attributes.question;
  expectInputError(
    { ...input, elements: missingQuestion },
    "/decision/attributes/question",
  );
  const emptyConsequences = structuredClone(elements);
  emptyConsequences[0].attributes.consequences = [];
  expectInputError(
    { ...input, elements: emptyConsequences },
    "/decision/attributes/consequences",
  );
  const invalidTriggers = structuredClone(elements);
  invalidTriggers[0].attributes.revisitTriggers = "later";
  expectInputError(
    { ...input, elements: invalidTriggers },
    "/decision/attributes/revisitTriggers",
  );

  let getterReads = 0;
  const accessorInput = { ...input };
  Object.defineProperty(accessorInput, "elements", {
    enumerable: true,
    get() {
      getterReads += 1;
      return elements;
    },
  });
  assert.throws(() => projectDecisionMarkdown(accessorInput), TypeError);
  assert.equal(getterReads, 0);
});
