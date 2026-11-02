import { compareUnicode, graphRootDigest } from "./canonical.js";
import { validateGraphConstraints } from "./graph-constraints.js";
import { readGraphPackage } from "./package-reader.js";
import { resolveSchemaRegistry } from "./schema-registry.js";
import { validatePhase7 } from "./validation-phase-7.js";

const COMMON_REQUIRED_FIELDS = [
  "format",
  "kind",
  "id",
  "type",
  "typeVersion",
  "revision",
  "lifecycle",
  "reviewState",
  "attributes",
];
const COMMON_FIELDS = new Set([
  ...COMMON_REQUIRED_FIELDS,
  "provenance",
  "extensions",
]);
const RELATION_ATTRIBUTES = new Set([
  "source",
  "predicate",
  "target",
  "qualifiers",
]);
const RELATION_LIFECYCLE = new Set([
  "active",
  "deprecated",
  "draft",
  "retracted",
  "superseded",
]);

function issue(code, phase, elementId = "", path = "", relatedId = "") {
  return { code, phase, elementId, path, relatedId };
}

function text(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

export function compareIssues(left, right) {
  if (left.phase !== right.phase) {
    return left.phase - right.phase;
  }

  for (const field of ["elementId", "code", "path", "relatedId"]) {
    const comparison = compareUnicode(text(left[field]), text(right[field]));
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

function schemaTypeIndex(schemas) {
  const entityTypes = new Map();
  const relationTypes = new Map();
  for (const schema of schemas.values()) {
    for (const entityType of schema.entityTypes ?? []) {
      if (!entityTypes.has(entityType.typeId)) {
        entityTypes.set(entityType.typeId, { schema, entityType });
      }
    }
    for (const relationType of schema.relationTypes ?? []) {
      if (!relationTypes.has(relationType.predicate)) {
        relationTypes.set(relationType.predicate, { schema, relationType });
      }
    }
  }
  return { entityTypes, relationTypes };
}

function validateRequiredFields(element, issues) {
  for (const field of COMMON_REQUIRED_FIELDS) {
    if (!Object.hasOwn(element, field) || element[field] === null) {
      issues.push(
        issue(
          "SCHEMA_REQUIRED_FIELD",
          3,
          text(element.id),
          pointerChild("", field),
        ),
      );
    }
  }
}

function validateRootFields(element, issues) {
  for (const field of Object.keys(element)) {
    if (!COMMON_FIELDS.has(field) && field.startsWith("core.")) {
      issues.push(
        issue("CORE_UNKNOWN", 3, text(element.id), pointerChild("", field)),
      );
    }
  }
}

function validateCommonStates(element, schema, lifecycle, issues) {
  if (
    typeof element.typeVersion === "string" &&
    element.typeVersion !== schema.version
  ) {
    issues.push(
      issue("SCHEMA_VERSION_MISMATCH", 3, text(element.id), "/typeVersion"),
    );
  }
  if (
    typeof element.reviewState === "string" &&
    !(schema.reviewStates ?? []).includes(element.reviewState)
  ) {
    issues.push(issue("CORE_UNKNOWN", 3, text(element.id), "/reviewState"));
  }
  if (
    typeof element.lifecycle === "string" &&
    !lifecycle.has(element.lifecycle)
  ) {
    issues.push(issue("CORE_UNKNOWN", 3, text(element.id), "/lifecycle"));
  }
}

function validateEntity(element, types, issues) {
  const resolved = types.entityTypes.get(element.type);
  if (!resolved) {
    if (typeof element.type === "string") {
      issues.push(issue("CORE_UNKNOWN", 3, text(element.id), "/type"));
    }
    return;
  }

  const { schema, entityType } = resolved;
  validateCommonStates(
    element,
    schema,
    new Set(entityType.lifecycle ?? []),
    issues,
  );
  if (!element.attributes || typeof element.attributes !== "object") {
    return;
  }

  const required = new Set(entityType.requiredAttributes ?? []);
  const allowed = new Set([
    ...(entityType.requiredAttributes ?? []),
    ...(entityType.optionalAttributes ?? []),
  ]);
  for (const field of required) {
    if (
      !Object.hasOwn(element.attributes, field) ||
      element.attributes[field] === null
    ) {
      issues.push(
        issue(
          "SCHEMA_REQUIRED_FIELD",
          3,
          text(element.id),
          pointerChild("/attributes", field),
        ),
      );
    }
  }
  for (const field of Object.keys(element.attributes)) {
    if (!allowed.has(field)) {
      issues.push(
        issue(
          "CORE_UNKNOWN",
          3,
          text(element.id),
          pointerChild("/attributes", field),
        ),
      );
    }
  }
}

function validateRelation(element, types, issues) {
  const attributes = element.attributes;
  if (!attributes || typeof attributes !== "object") {
    return;
  }

  for (const field of ["source", "predicate", "target"]) {
    if (!Object.hasOwn(attributes, field) || attributes[field] === null) {
      issues.push(
        issue(
          "SCHEMA_REQUIRED_FIELD",
          3,
          text(element.id),
          pointerChild("/attributes", field),
        ),
      );
    }
  }
  for (const field of Object.keys(attributes)) {
    if (!RELATION_ATTRIBUTES.has(field)) {
      issues.push(
        issue(
          "CORE_UNKNOWN",
          3,
          text(element.id),
          pointerChild("/attributes", field),
        ),
      );
    }
  }

  const resolved = types.relationTypes.get(attributes.predicate);
  if (!resolved) {
    if (attributes.predicate !== undefined && attributes.predicate !== null) {
      issues.push(
        issue("CORE_UNKNOWN", 3, text(element.id), "/attributes/predicate"),
      );
    }
    return;
  }
  if (
    resolved.schema.schemaId === "morivyx.core" &&
    element.type !== `core.${attributes.predicate}`
  ) {
    issues.push(issue("CORE_UNKNOWN", 3, text(element.id), "/type"));
  }
  validateCommonStates(element, resolved.schema, RELATION_LIFECYCLE, issues);
}

function duplicateIssues(elements, field, path) {
  const groups = new Map();
  for (const element of elements) {
    if (typeof element[field] !== "string") {
      continue;
    }
    const value = element[field].normalize("NFC");
    const group = groups.get(value) ?? [];
    group.push(text(element.id));
    groups.set(value, group);
  }

  const issues = [];
  for (const [value, ids] of groups) {
    if (ids.length < 2) {
      continue;
    }
    ids.sort(compareUnicode);
    issues.push(
      issue(
        "ID_DUPLICATE",
        4,
        field === "id" ? value : ids[0],
        path,
        field === "id" ? value : ids[1],
      ),
    );
  }
  return issues;
}

export function validateGraph({
  graphRevision,
  schemaLockDigest,
  schemas,
  elements,
  registryIssues = [],
  previousElements = [],
  approvals = [],
}) {
  const issues = [...registryIssues];
  if (issues.length === 0) {
    const types = schemaTypeIndex(schemas);
    for (const element of elements) {
      validateRequiredFields(element, issues);
      validateRootFields(element, issues);
      if (element.kind === "entity") {
        validateEntity(element, types, issues);
      } else if (element.kind === "relation") {
        validateRelation(element, types, issues);
      } else if (typeof element.kind === "string") {
        issues.push(issue("CORE_UNKNOWN", 3, text(element.id), "/kind"));
      }
    }
    issues.push(...duplicateIssues(elements, "id", "/id"));
    issues.push(...duplicateIssues(elements, "revision", "/revision"));
    issues.push(...validateGraphConstraints(elements, schemas));
    issues.push(...validatePhase7(elements, { previousElements, approvals }));
  }

  issues.sort(compareIssues);
  const rootDigest = elements.every(
    (element) =>
      typeof element?.id === "string" && typeof element?.revision === "string",
  )
    ? graphRootDigest(elements)
    : "";
  return {
    valid: issues.length === 0,
    schemaLockDigest,
    graphRevision,
    rootDigest,
    issues,
  };
}

export async function validatePackage(path) {
  const packageContents = await readGraphPackage(path);
  const registry = await resolveSchemaRegistry(
    packageContents.directory,
    packageContents.schemaLock,
  );
  return validateGraph({
    graphRevision: packageContents.revision.id,
    schemaLockDigest: packageContents.revision.schemaLockDigest,
    schemas: registry.schemas,
    elements: packageContents.elements,
    approvals: packageContents.approvals,
    registryIssues: registry.issues,
  });
}
