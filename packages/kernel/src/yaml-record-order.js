export const GRAPH_ELEMENT_ORDER = [
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
];
export const DECISION_CREATION_REQUEST_ORDER = [
  "format",
  "decisionId",
  "attributes",
  "changeSetId",
  "resultingRevision",
  "actor",
  "recordedAt",
];
export const DECISION_REVISION_REQUEST_ORDER = [
  "format",
  "decisionId",
  "attributes",
  "changeSetId",
  "resultingRevision",
  "actor",
  "recordedAt",
];
export const SCHEMA_LOCK_ORDER = [
  "format",
  "stableIdScheme",
  "digestAlgorithm",
  "schemas",
];
export const SCHEMA_LOCK_ENTRY_ORDER = ["schemaId", "version", "digest"];
export const GRAPH_REVISION_ORDER = [
  "format",
  "id",
  "parentRevision",
  "rootDigest",
  "schemaLockDigest",
];
export const APPROVAL_ORDER = [
  "format",
  "id",
  "actor",
  "targetId",
  "targetRevision",
  "operation",
  "scope",
  "approvedAt",
  "recordedAt",
  "expiresAt",
  "revokes",
];
export const SCHEMA_DEFINITION_ORDER = [
  "format",
  "schemaId",
  "version",
  "stableIdScheme",
  "digestAlgorithm",
  "reviewStates",
  "entityTypes",
  "relationTypes",
  "authoringOrders",
];
export const ENTITY_TYPE_ORDER = [
  "typeId",
  "requiredAttributes",
  "optionalAttributes",
  "lifecycle",
];
export const RELATION_TYPE_ORDER = [
  "predicate",
  "sourceTypes",
  "targetTypes",
  "minCount",
  "maxCount",
  "cycle",
];
export const AUTHORING_ORDERS_ORDER = ["root", "attributes", "provenance"];
export const PROVENANCE_ORDER = ["method", "actor", "recordedAt"];
export const CHANGESET_ORDER = [
  "format",
  "id",
  "baseRevision",
  "resultingRevision",
  "resultingRootDigest",
  "schemaLockDigest",
  "operations",
  "provenance",
  "recordedAt",
];
export const CHANGESET_OPERATION_ORDER = [
  "op",
  "targetId",
  "beforeRevision",
  "afterRevision",
  "replacementId",
];
export const MIGRATION_ORDER = [
  "format",
  "id",
  "baseRevision",
  "sourceSchemaLockDigest",
  "targetSchemaLockDigest",
  "rulesDigest",
  "mappingDigest",
  "plannedSemanticDiffDigest",
  "changeSetId",
  "resultingRevision",
  "resultingRootDigest",
  "provenance",
  "recordedAt",
];
export const TRACE_REPORT_ORDER = [
  "format",
  "id",
  "queryId",
  "graphRevision",
  "schemaLockDigest",
  "focusId",
  "evaluatedAt",
  "status",
  "paths",
  "missing",
  "waiverDecisionId",
];
export const TRACE_PATH_ORDER = ["hops"];
export const TRACE_HOP_ORDER = [
  "fromId",
  "predicate",
  "toId",
  "fromRevision",
  "toRevision",
];
export const SEMANTIC_DIFF_ORDER = [
  "format",
  "id",
  "baseRevision",
  "targetRevision",
  "schemaLockDigest",
  "evaluatedAt",
  "entries",
];
export const MIGRATION_SEMANTIC_DIFF_ORDER = [
  "format",
  "id",
  "baseRevision",
  "targetRevision",
  "sourceSchemaLockDigest",
  "targetSchemaLockDigest",
  "evaluatedAt",
  "entries",
];
export const SEMANTIC_DIFF_ENTRY_ORDER = [
  "kind",
  "targetId",
  "beforeRevision",
  "afterRevision",
  "replacementId",
  "aspect",
  "queryId",
  "beforeStatus",
  "afterStatus",
];
export const EXTERNAL_ARTIFACT_REPORT_ORDER = [
  "format",
  "id",
  "graphRevision",
  "artifact",
  "externalSource",
  "relation",
  "retrieval",
  "comparedAt",
  "status",
  "issues",
];
export const EXTERNAL_ARTIFACT_IDENTITY_ORDER = [
  "id",
  "revision",
  "lifecycle",
];
export const EXTERNAL_ARTIFACT_RETRIEVAL_ORDER = [
  "status",
  "comparedAt",
  "digest",
  "digestRule",
  "externalVersion",
  "method",
  "reason",
];
export const EXTERNAL_ARTIFACT_ISSUE_ORDER = ["code"];
