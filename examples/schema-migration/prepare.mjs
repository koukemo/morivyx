import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { graphRootDigest, revisionId, schemaDefinitionDigest, schemaLockDigest } from "../../packages/kernel/src/canonical.js";
import { assertSupportedNodeVersion } from "../../packages/kernel/src/node-runtime.js";
import { readGraphPackage } from "../../packages/kernel/src/package-reader.js";
import { createMigrationSemanticDiff, migrationSemanticDiffDigest } from "../../packages/kernel/src/semantic-diff.js";
import { validatePackage } from "../../packages/kernel/src/validator.js";
import { readYamlRecord } from "../../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../../packages/kernel/src/yaml-writer.js";

// This prepares one explicit tutorial mapping; it is not a conversion engine.
assertSupportedNodeVersion();
if (process.argv.length !== 4) throw new Error("Usage: node examples/schema-migration/prepare.mjs <tutorial-base> <new-plan-directory>");
const basePath = await realpath(resolve(process.argv[2]));
const requested = resolve(process.argv[3]);
const root = join(await realpath(dirname(requested)), basename(requested));
const within = relative(basePath, root);
if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))) {
  throw new Error("Plan directory must be outside the source package");
}
if (!(await validatePackage(basePath)).valid) throw new Error("Source package must validate");
const base = await readGraphPackage(basePath);
if (base.revision.id !== "graph:tutorial-base" || base.elements.length !== 1 || base.elements[0].type !== "core.artifact" || base.elements[0].typeVersion !== "0.1") {
  throw new Error("Use the unchanged base from examples/getting-started/prepare.mjs");
}
const schema = await readYamlRecord(join(basePath, ".morivyx/schemas/morivyx.core@0.1.yaml"));
if (base.schemaLock.schemas.length !== 1 || base.schemaLock.schemas[0].digest !== schemaDefinitionDigest(schema)) {
  throw new Error("Unexpected source Schema");
}
const targetSchema = structuredClone(schema);
targetSchema.version = "0.2";
targetSchema.entityTypes.find(type => type.typeId === "core.artifact").optionalAttributes.push("migrationNote");
const targetSchemaLock = { ...base.schemaLock, schemas: [{ schemaId: targetSchema.schemaId,
  version: targetSchema.version, digest: schemaDefinitionDigest(targetSchema) }] };
const targetDigest = schemaLockDigest(targetSchemaLock);
const rules = { example: "tutorial-only", sourceVersion: "0.1", targetVersion: "0.2",
  optionalAttribute: "migrationNote", execution: "explicit JavaScript example, not interpreted rules" };
const mapping = { type: "core.artifact", typeVersion: "0.2", migrationNote: "説明用の移行で加えた注記。" };
const json = value => JSON.stringify(value, null, 2) + "\n";
const rulesText = json(rules), mappingText = json(mapping);
const hash = source => `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
const candidate = structuredClone(base.elements[0]);
candidate.typeVersion = mapping.typeVersion;
candidate.attributes.migrationNote = mapping.migrationNote;
candidate.revision = revisionId(candidate);
const resultingRootDigest = graphRootDigest([candidate]);
const id = suffix => `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const recordedAt = "2026-11-02T01:00:00Z";
const provenance = { method: "generated", actor: id(9), recordedAt };
const changeSet = { format: "morivyx.changeset/0.1", id: id(20),
  baseRevision: base.revision.id, resultingRevision: "graph:tutorial-migrated", resultingRootDigest,
  schemaLockDigest: targetDigest,
  operations: [{ op: "revise", targetId: candidate.id, beforeRevision: base.elements[0].revision, afterRevision: candidate.revision }],
  provenance, recordedAt };
const diff = createMigrationSemanticDiff({ baseRevision: base.revision.id,
  targetRevision: changeSet.resultingRevision, sourceSchemaLock: base.schemaLock, targetSchemaLock,
  sourceSchemaLockDigest: base.calculatedSchemaLockDigest, targetSchemaLockDigest: targetDigest,
  evaluatedAt: recordedAt, baseElements: base.elements, targetElements: [candidate], id: id(21) });
const migration = { format: "morivyx.migration/0.1", id: id(22), baseRevision: base.revision.id,
  sourceSchemaLockDigest: base.calculatedSchemaLockDigest, targetSchemaLockDigest: targetDigest,
  rulesDigest: hash(rulesText), mappingDigest: hash(mappingText),
  plannedSemanticDiffDigest: migrationSemanticDiffDigest(diff), changeSetId: changeSet.id,
  resultingRevision: changeSet.resultingRevision, resultingRootDigest, provenance, recordedAt };
const revision = { format: "morivyx.graph-revision/0.1", id: migration.resultingRevision,
  parentRevision: migration.baseRevision, rootDigest: resultingRootDigest, schemaLockDigest: targetDigest };

// Exclusive creation, with removal limited to this invocation's own new plan.
await mkdir(root);
try {
  await mkdir(join(root, "candidates"));
  await mkdir(join(root, "target"));
  await mkdir(join(root, "target/schemas"));
  for (const [name, value] of [
    ["migration.yaml", migration], ["changeset.yaml", changeSet], ["diff.yaml", diff],
    ["revision.yaml", revision], ["candidates/artifact.yaml", candidate],
    ["target/schema.lock.yaml", targetSchemaLock], ["target/schemas/morivyx.core@0.2.yaml", targetSchema],
  ]) await writeFile(join(root, name), serializeYamlRecord(value), { flag: "wx" });
  await writeFile(join(root, "rules.json"), rulesText, { flag: "wx" });
  await writeFile(join(root, "mapping.json"), mappingText, { flag: "wx" });
} catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
console.log(json({ prepared: true, directory: root, baseRevision: base.revision.id,
  resultingRevision: revision.id, elementCount: 1,
  sourceSchemaLockDigest: migration.sourceSchemaLockDigest, targetSchemaLockDigest: targetDigest,
  diffKinds: diff.entries.map(entry => entry.kind) }));
