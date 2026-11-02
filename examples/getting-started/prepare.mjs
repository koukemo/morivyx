import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graphRootDigest, revisionId, schemaDefinitionDigest, schemaLockDigest } from "../../packages/kernel/src/canonical.js";
import { readYamlRecord } from "../../packages/kernel/src/yaml-reader.js";
import { serializeYamlRecord } from "../../packages/kernel/src/yaml-writer.js";
import { validatePackage } from "../../packages/kernel/src/validator.js";

// This is sample-data preparation, not a general package-initialization API.
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: node examples/getting-started/prepare.mjs <new-directory>");
  process.exit(1);
}
const root = resolve(args[0]);
const schemaPath = fileURLToPath(new URL("../../docs/schema/morivyx.core@0.1.yaml", import.meta.url));
const schema = await readYamlRecord(schemaPath);
const actor = "urn:uuid:00000000-0000-4000-8000-000000000009";
const recordedAt = "2026-11-02T00:00:00Z";
const artifact = {
  format: "morivyx.git-graph/0.1", kind: "entity",
  id: "urn:uuid:00000000-0000-4000-8000-000000000001",
  type: "core.artifact", typeVersion: "0.1", lifecycle: "draft", reviewState: "unreviewed",
  attributes: { artifactKind: "document", uri: "urn:morivyx:example:storage-notes" },
  provenance: { method: "asserted", actor, recordedAt },
};
artifact.revision = revisionId(artifact);
const lock = {
  format: "morivyx.schema-lock/0.1", stableIdScheme: "urn-uuid-v4", digestAlgorithm: "sha256",
  schemas: [{ schemaId: schema.schemaId, version: schema.version, digest: schemaDefinitionDigest(schema) }],
};
const revision = {
  format: "morivyx.graph-revision/0.1", id: "graph:tutorial-base", parentRevision: null,
  rootDigest: graphRootDigest([artifact]), schemaLockDigest: schemaLockDigest(lock),
};
const request = {
  format: "morivyx.decision-creation-request/0.1",
  decisionId: "urn:uuid:00000000-0000-4000-8000-000000000002",
  attributes: {
    question: "設定の保存形式を何にするか？",
    rationale: "変更理由を差分で読めるよう、YAMLを選ぶ。",
    consequences: ["構造の検証を行ってから変更を保存する。"],
  },
  changeSetId: "urn:uuid:00000000-0000-4000-8000-000000000003",
  resultingRevision: "graph:tutorial-decision", actor, recordedAt,
};

// Exclusive creation: an existing destination is never reused or overwritten.
await mkdir(root);
const packageRoot = resolve(root, "base/.morivyx");
await mkdir(resolve(packageRoot, "graph/entities"), { recursive: true });
await mkdir(resolve(packageRoot, "schemas"));
const save = (path, value) => writeFile(path, serializeYamlRecord(value), { flag: "wx" });
await save(resolve(packageRoot, "graph/entities/00000000-0000-4000-8000-000000000001.yaml"), artifact);
await save(resolve(packageRoot, "schema.lock.yaml"), lock);
await save(resolve(packageRoot, "revision.yaml"), revision);
await writeFile(resolve(packageRoot, "schemas/morivyx.core@0.1.yaml"), await readFile(schemaPath), { flag: "wx" });
await save(resolve(root, "decision.yaml"), request);
const result = await validatePackage(resolve(root, "base"));
if (!result.valid) throw new Error("Tutorial sample validation failed");
console.log(JSON.stringify({ valid: true, base: resolve(root, "base"), request: resolve(root, "decision.yaml") }, null, 2));
