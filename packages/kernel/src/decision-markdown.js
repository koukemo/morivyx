import { createHash } from "node:crypto";
import { canonicalJson, compareUnicode, digestValue } from "./canonical.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";

const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INPUT_FIELDS = new Set([
  "graphRevision",
  "decisionId",
  "elements",
  "projectorPackageDigest",
]);
const RELATION_PREDICATES = [
  "addresses",
  "considers",
  "selects",
  "supported_by",
  "challenged_by",
  "governs",
];
const RELATION_LABELS = new Map([
  ["addresses", "対象"],
  ["considers", "検討した選択肢"],
  ["selects", "採用した選択肢"],
  ["supported_by", "根拠"],
  ["challenged_by", "反証と懸念"],
  ["governs", "統制する対象"],
]);
const RULES = {
  format: "morivyx.decision-markdown-rules/0.1",
  projectorId: "morivyx.decision-markdown",
  projectorVersion: "0.1",
  relationPredicates: RELATION_PREDICATES,
  sections: [
    "state",
    "question",
    "rationale",
    "consequences",
    "revisitTriggers",
    "challengeReview",
    "relations",
  ],
};
const CONFIGURATION = {
  escaping: "markdown-backslash-v1",
  headings: "ja-v1",
  lineEnding: "lf",
};
const RULES_DIGEST = digestValue(
  "morivyx:decision-markdown-rules:v1",
  RULES,
);
const CONFIGURATION_DIGEST = digestValue(
  "morivyx:decision-markdown-configuration:v1",
  CONFIGURATION,
);

function invalid(path, message) {
  throw new PackageError("DECISION_PROJECTION_INPUT_INVALID", path, message);
}

function assertText(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(path, "空でない文字列が必要です。");
  }
}

function assertStableId(value, path) {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    invalid(path, "小文字のUUID版4 stable IDが必要です。");
  }
}

function assertDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    invalid(path, "小文字のSHA-256 digestが必要です。");
  }
}

function assertStringList(value, path, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(path, "文字列の一覧が必要です。");
  }
  value.forEach((entry, index) => assertText(entry, `${path}/${index}`));
}

function markdownText(value) {
  return value
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (entry) =>
      `\\u${entry.codePointAt(0).toString(16).padStart(4, "0")}`,
    )
    .split("\n")
    .map((line) => {
      const leadingSpaces = /^ +/.exec(line)?.[0].length ?? 0;
      return `${"&#32;".repeat(leadingSpaces)}${line
        .slice(leadingSpaces)
        .replace(/[\\`*_{}\[\]<>#+\-.!|()>=~]/g, "\\$&")}`;
    })
    .join("\n");
}

function renderTextList(values) {
  return values.length === 0
    ? ["- なし"]
    : values.map((value) => {
        const [firstLine, ...continuationLines] = markdownText(value).split("\n");
        return [
          `- ${firstLine}`,
          ...continuationLines.map((line) => `  ${line}`),
        ].join("\n");
      });
}

function relationKey(relation) {
  const predicateIndex = RELATION_PREDICATES.indexOf(
    relation.attributes.predicate,
  );
  return [
    String(predicateIndex).padStart(2, "0"),
    relation.attributes.target,
    relation.id,
  ].join("\u0000");
}

function compareRelations(left, right) {
  return compareUnicode(relationKey(left), relationKey(right));
}

function validateInput(input) {
  canonicalJson(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("", "入力は対応表でなければなりません。");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      invalid(`/${field}`, `定義されていない項目です: ${field}`);
    }
  }
  if (
    typeof input.graphRevision !== "string" ||
    !GRAPH_REVISION_PATTERN.test(input.graphRevision)
  ) {
    invalid("/graphRevision", "GraphRevision IDが不正です。");
  }
  assertStableId(input.decisionId, "/decisionId");
  assertDigest(input.projectorPackageDigest, "/projectorPackageDigest");
  if (!Array.isArray(input.elements)) {
    invalid("/elements", "GraphElementは一覧でなければなりません。");
  }
}

function indexElements(elements) {
  const index = new Map();
  elements.forEach((element, elementIndex) => {
    validateGraphElement(element, `/elements/${elementIndex}`);
    if (index.has(element.id)) {
      invalid(
        `/elements/${elementIndex}/id`,
        "GraphElementのstable IDが重複しています。",
      );
    }
    index.set(element.id, element);
  });
  return index;
}

function validateRelations(elements, index) {
  for (const [elementIndex, element] of elements.entries()) {
    if (element.kind !== "relation") {
      continue;
    }
    const { source, predicate, target } = element.attributes;
    assertStableId(source, `/elements/${elementIndex}/attributes/source`);
    assertStableId(target, `/elements/${elementIndex}/attributes/target`);
    assertText(predicate, `/elements/${elementIndex}/attributes/predicate`);
    if (element.type !== `core.${predicate}`) {
      invalid(
        `/elements/${elementIndex}/type`,
        "Relation型とpredicateが一致しません。",
      );
    }
    for (const [field, endpoint] of [
      ["source", source],
      ["target", target],
    ]) {
      const value = index.get(endpoint);
      if (!value) {
        invalid(
          `/elements/${elementIndex}/attributes/${field}`,
          "Relationの接続先GraphElementがありません。",
        );
      }
      if (value.kind !== "entity") {
        invalid(
          `/elements/${elementIndex}/attributes/${field}`,
          "Relationの接続先はEntityでなければなりません。",
        );
      }
    }
  }
}

function validateDecision(decision) {
  if (decision.kind !== "entity" || decision.type !== "core.decision") {
    invalid("/decisionId", "焦点はcore.decision Entityでなければなりません。");
  }
  const { attributes } = decision;
  assertText(attributes.question, "/decision/attributes/question");
  assertText(attributes.rationale, "/decision/attributes/rationale");
  assertStringList(
    attributes.consequences,
    "/decision/attributes/consequences",
    false,
  );
  if (Object.hasOwn(attributes, "revisitTriggers")) {
    assertStringList(
      attributes.revisitTriggers,
      "/decision/attributes/revisitTriggers",
    );
  }
  if (Object.hasOwn(attributes, "challengeReview")) {
    canonicalJson(attributes.challengeReview);
  }
}

function renderRelations(decisionId, elements, index) {
  const relations = elements
    .filter(
      (element) =>
        element.kind === "relation" &&
        element.attributes.source === decisionId &&
        RELATION_LABELS.has(element.attributes.predicate),
    )
    .sort(compareRelations);
  const byPredicate = new Map(
    RELATION_PREDICATES.map((predicate) => [predicate, []]),
  );
  for (const relation of relations) {
    const target = index.get(relation.attributes.target);
    byPredicate.get(relation.attributes.predicate).push(
      `- type: ${markdownText(target.type)}、stable ID: \`${target.id}\` @ \`${target.revision}\`（Relation \`${relation.id}\` @ \`${relation.revision}\`）`,
    );
  }
  return RELATION_PREDICATES.flatMap((predicate) => [
    `### ${RELATION_LABELS.get(predicate)}（\`${predicate}\`）`,
    "",
    ...(byPredicate.get(predicate).length > 0
      ? byPredicate.get(predicate)
      : ["- なし"]),
    "",
  ]);
}

function renderMarkdown(input, decision, elements, index) {
  const { attributes } = decision;
  const lines = [
    "---",
    "type: Decision Projection",
    'title: "Decisionの派生表現"',
    'description: "Decisionを人が確認するためにGraphから生成したMarkdown。"',
    `graphRevision: ${JSON.stringify(input.graphRevision)}`,
    `sourceId: ${JSON.stringify(decision.id)}`,
    `sourceRevision: ${JSON.stringify(decision.revision)}`,
    `rulesDigest: ${JSON.stringify(RULES_DIGEST)}`,
    `projectorId: ${JSON.stringify(RULES.projectorId)}`,
    `projectorVersion: ${JSON.stringify(RULES.projectorVersion)}`,
    `projectorPackageDigest: ${JSON.stringify(input.projectorPackageDigest)}`,
    `configurationDigest: ${JSON.stringify(CONFIGURATION_DIGEST)}`,
    "---",
    "",
    "# Decision",
    "",
    "## 状態",
    "",
    `- stable ID: \`${decision.id}\``,
    `- Revision ID: \`${decision.revision}\``,
    `- lifecycle: ${markdownText(decision.lifecycle)}`,
    `- review state: ${markdownText(decision.reviewState)}`,
    "",
    "## 問い",
    "",
    markdownText(attributes.question),
    "",
    "## 選択理由",
    "",
    markdownText(attributes.rationale),
    "",
    "## 結果",
    "",
    ...renderTextList(attributes.consequences),
    "",
    "## 再検討条件",
    "",
    ...renderTextList(attributes.revisitTriggers ?? []),
    "",
    "## 反証確認",
    "",
    ...(Object.hasOwn(attributes, "challengeReview")
      ? [`    ${canonicalJson(attributes.challengeReview)}`]
      : ["- なし"]),
    "",
    "## 関係",
    "",
    ...renderRelations(decision.id, elements, index),
  ];
  return `${lines.join("\n")}\n`;
}

export function projectDecisionMarkdown(input) {
  validateInput(input);
  const index = indexElements(input.elements);
  validateRelations(input.elements, index);
  const decision = index.get(input.decisionId);
  if (!decision) {
    invalid("/decisionId", "焦点のDecisionがGraphにありません。");
  }
  validateDecision(decision);
  const graphRevision = input.graphRevision.normalize("NFC");
  const markdown = renderMarkdown(
    { ...input, graphRevision },
    decision,
    input.elements,
    index,
  );
  const digest = `sha256:${createHash("sha256").update(markdown).digest("hex")}`;
  return {
    format: "morivyx.decision-markdown-projection/0.1",
    graphRevision,
    sourceId: decision.id,
    sourceRevision: decision.revision,
    rulesDigest: RULES_DIGEST,
    projectorId: RULES.projectorId,
    projectorVersion: RULES.projectorVersion,
    projectorPackageDigest: input.projectorPackageDigest,
    configurationDigest: CONFIGURATION_DIGEST,
    mediaType: "text/markdown; charset=utf-8",
    digest,
    markdown,
  };
}
