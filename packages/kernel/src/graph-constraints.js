import { compareUnicode } from "./canonical.js";

function issue(code, phase, elementId, path, relatedId = "") {
  return { code, phase, elementId, path, relatedId };
}

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function text(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

function relationDefinitions(schemas) {
  const definitions = new Map();
  for (const schema of schemas.values()) {
    for (const definition of schema.relationTypes ?? []) {
      if (!definitions.has(definition.predicate)) {
        definitions.set(definition.predicate, definition);
      }
    }
  }
  return definitions;
}

function elementGroups(elements) {
  const groups = new Map();
  for (const element of elements) {
    if (typeof element.id !== "string") {
      continue;
    }
    const id = text(element.id);
    const group = groups.get(id) ?? [];
    group.push(element);
    groups.set(id, group);
  }
  return groups;
}

function relationRecords(elements) {
  return elements
    .filter(
      (element) =>
        element.kind === "relation" &&
        element.attributes &&
        typeof element.attributes === "object",
    )
    .sort((left, right) => compareUnicode(text(left.id), text(right.id)));
}

function incrementEndpointCount(index, predicate, endpoint) {
  const counts = index.get(predicate) ?? new Map();
  counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
  index.set(predicate, counts);
}

function relationIndexes(relations) {
  const outgoingBySource = new Map();
  const relationsByPredicate = new Map();
  const sourceCountsByPredicate = new Map();
  const targetCountsByPredicate = new Map();
  for (const relation of relations) {
    const { source, predicate, target } = relation.attributes;
    const sourceId = text(source);
    const outgoing = outgoingBySource.get(sourceId) ?? [];
    outgoing.push(relation);
    outgoingBySource.set(sourceId, outgoing);
    const predicateRelations = relationsByPredicate.get(predicate) ?? [];
    predicateRelations.push(relation);
    relationsByPredicate.set(predicate, predicateRelations);
    incrementEndpointCount(sourceCountsByPredicate, predicate, sourceId);
    incrementEndpointCount(targetCountsByPredicate, predicate, text(target));
  }
  return {
    outgoingBySource,
    relationsByPredicate,
    sourceCountsByPredicate,
    targetCountsByPredicate,
  };
}

function entityElementsByType(elements) {
  const byType = new Map();
  elements.forEach((element, index) => {
    if (element.kind !== "entity") {
      return;
    }
    const entries = byType.get(element.type) ?? [];
    entries.push({ element, index });
    byType.set(element.type, entries);
  });
  return byType;
}

function cardinalitySources(definition, elementsByType) {
  const groups = [];
  for (const sourceType of new Set(definition.sourceTypes)) {
    const entries = elementsByType.get(sourceType);
    if (entries) {
      groups.push(entries);
    }
  }
  if (groups.length === 0) {
    return [];
  }
  if (groups.length === 1) {
    return groups[0];
  }
  return groups.flat().sort((left, right) => left.index - right.index);
}

function validateEndpoints(relations, definitions, groups) {
  const issues = [];
  for (const relation of relations) {
    const { source, predicate, target } = relation.attributes;
    const definition = definitions.get(predicate);
    if (!definition) {
      continue;
    }

    for (const [field, allowedTypes] of [
      ["source", definition.sourceTypes],
      ["target", definition.targetTypes],
    ]) {
      const reference = field === "source" ? source : target;
      if (reference === undefined || reference === null) {
        continue;
      }
      const referenceId = text(reference);
      const candidates =
        typeof reference === "string" ? groups.get(referenceId) ?? [] : [];
      if (candidates.length === 0) {
        issues.push(
          issue(
            "RELATION_TARGET_MISSING",
            5,
            text(relation.id),
            `/${field}`,
            referenceId,
          ),
        );
      } else if (
        candidates.length === 1 &&
        !allowedTypes.includes(candidates[0].type)
      ) {
        issues.push(
          issue(
            "RELATION_TYPE_DISALLOWED",
            5,
            text(relation.id),
            `/${field}`,
            referenceId,
          ),
        );
      }
    }
  }
  return issues;
}

function validateCardinality(definitions, indexes, elementsByType) {
  const issues = [];
  for (const [predicate, definition] of definitions) {
    if (
      predicate === "produces" ||
      predicate === "supported_by" ||
      predicate === "challenged_by"
    ) {
      continue;
    }
    for (const { element: source } of cardinalitySources(
      definition,
      elementsByType,
    )) {
      const count =
        indexes.sourceCountsByPredicate.get(predicate)?.get(text(source.id)) ??
        0;
      const belowMinimum = count < definition.minCount;
      const aboveMaximum =
        definition.maxCount !== null && count > definition.maxCount;
      if (belowMinimum || aboveMaximum) {
        issues.push(
          issue(
            "RELATION_CARDINALITY",
            5,
            text(source.id),
            pointerChild("/relations", predicate),
          ),
        );
      }
    }
  }
  return issues;
}

function validateAcceptedDecisionEvidence(elements, definitions, indexes) {
  const validatesSupport = definitions.has("supported_by");
  const validatesChallenge = definitions.has("challenged_by");
  if (!validatesSupport && !validatesChallenge) {
    return [];
  }
  const issues = [];
  for (const decision of elements) {
    if (
      decision.kind !== "entity" ||
      decision.type !== "core.decision" ||
      decision.lifecycle !== "accepted"
    ) {
      continue;
    }
    const outgoing = indexes.outgoingBySource.get(text(decision.id)) ?? [];
    if (
      validatesSupport &&
      !outgoing.some(
        (relation) => relation.attributes.predicate === "supported_by",
      )
    ) {
      issues.push(
        issue(
          "RELATION_CARDINALITY",
          5,
          text(decision.id),
          "/relations/supported_by",
        ),
      );
    }
    const hasChallengeReview =
      decision.attributes &&
      typeof decision.attributes === "object" &&
      Object.hasOwn(decision.attributes, "challengeReview");
    if (
      validatesChallenge &&
      !hasChallengeReview &&
      !outgoing.some(
        (relation) => relation.attributes.predicate === "challenged_by",
      )
    ) {
      issues.push(
        issue(
          "RELATION_CARDINALITY",
          5,
          text(decision.id),
          "/relations/challenged_by",
        ),
      );
    }
  }
  return issues;
}

function validateArtifactProducerCardinality(elements, definitions, indexes) {
  const definition = definitions.get("produces");
  if (!definition?.targetTypes.includes("core.artifact")) {
    return [];
  }
  const issues = [];
  for (const artifact of elements) {
    if (artifact.kind !== "entity" || artifact.type !== "core.artifact") {
      continue;
    }
    const count =
      indexes.targetCountsByPredicate
        .get("produces")
        ?.get(text(artifact.id)) ?? 0;
    if (count > 1) {
      issues.push(
        issue(
          "RELATION_CARDINALITY",
          5,
          text(artifact.id),
          "/relations/produces",
        ),
      );
    }
  }
  return issues;
}

function validateRelationDuplicates(relations, definitions) {
  const groups = new Map();
  for (const relation of relations) {
    const { source, predicate, target } = relation.attributes;
    if (
      typeof source !== "string" ||
      typeof predicate !== "string" ||
      typeof target !== "string" ||
      !definitions.has(predicate)
    ) {
      continue;
    }
    const key = JSON.stringify([text(source), text(predicate), text(target)]);
    const group = groups.get(key) ?? [];
    group.push(relation);
    groups.set(key, group);
  }

  const issues = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    group.sort((left, right) => compareUnicode(text(left.id), text(right.id)));
    issues.push(
      issue(
        "RELATION_DUPLICATE",
        6,
        text(group[0].id),
        pointerChild("/relations", group[0].attributes.predicate),
        text(group[1].id),
      ),
    );
  }
  return issues;
}

function stronglyConnectedComponents(nodes, adjacency) {
  const components = [];
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  let nextIndex = 0;

  function enter(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
  }

  for (const root of [...nodes].sort(compareUnicode)) {
    if (indices.has(root)) {
      continue;
    }
    enter(root);
    const frames = [
      { node: root, targets: adjacency.get(root) ?? [], nextTarget: 0 },
    ];
    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (frame.nextTarget < frame.targets.length) {
        const target = frame.targets[frame.nextTarget];
        frame.nextTarget += 1;
        if (!indices.has(target)) {
          enter(target);
          frames.push({
            node: target,
            targets: adjacency.get(target) ?? [],
            nextTarget: 0,
          });
        } else if (onStack.has(target)) {
          lowLinks.set(
            frame.node,
            Math.min(lowLinks.get(frame.node), indices.get(target)),
          );
        }
        continue;
      }

      frames.pop();
      const parent = frames.at(-1)?.node;
      if (parent !== undefined) {
        lowLinks.set(
          parent,
          Math.min(lowLinks.get(parent), lowLinks.get(frame.node)),
        );
      }
      if (lowLinks.get(frame.node) === indices.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }
  return components;
}

function validateForbiddenCycles(definitions, groups, indexes) {
  const issues = [];
  for (const [predicate, definition] of definitions) {
    if (definition.cycle !== "forbidden") {
      continue;
    }
    const nodes = new Set();
    const edgeSets = new Map();
    for (const relation of indexes.relationsByPredicate.get(predicate) ?? []) {
      const source = text(relation.attributes.source);
      const target = text(relation.attributes.target);
      const sourceCandidates = groups.get(source) ?? [];
      const targetCandidates = groups.get(target) ?? [];
      if (
        sourceCandidates.length !== 1 ||
        targetCandidates.length !== 1 ||
        !definition.sourceTypes.includes(sourceCandidates[0].type) ||
        !definition.targetTypes.includes(targetCandidates[0].type)
      ) {
        continue;
      }
      nodes.add(source);
      nodes.add(target);
      const targets = edgeSets.get(source) ?? new Set();
      targets.add(target);
      edgeSets.set(source, targets);
    }
    const adjacency = new Map(
      Array.from(edgeSets, ([source, targets]) => [
        source,
        [...targets].sort(compareUnicode),
      ]),
    );

    for (const component of stronglyConnectedComponents(nodes, adjacency)) {
      component.sort(compareUnicode);
      const selfCycle =
        component.length === 1 &&
        (adjacency.get(component[0]) ?? []).includes(component[0]);
      if (component.length > 1 || selfCycle) {
        issues.push(
          issue(
            "CYCLE_FORBIDDEN",
            6,
            component[0],
            pointerChild("/relations", predicate),
            component[1] ?? component[0],
          ),
        );
      }
    }
  }
  return issues;
}

export function validateGraphConstraints(elements, schemas) {
  const definitions = relationDefinitions(schemas);
  const groups = elementGroups(elements);
  const relations = relationRecords(elements);
  const indexes = relationIndexes(relations);
  const elementsByType = entityElementsByType(elements);
  return [
    ...validateEndpoints(relations, definitions, groups),
    ...validateCardinality(definitions, indexes, elementsByType),
    ...validateAcceptedDecisionEvidence(elements, definitions, indexes),
    ...validateArtifactProducerCardinality(elements, definitions, indexes),
    ...validateRelationDuplicates(relations, definitions),
    ...validateForbiddenCycles(definitions, groups, indexes),
  ];
}
