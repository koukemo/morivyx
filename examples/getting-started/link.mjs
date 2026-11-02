import { graphRootDigest, revisionId } from "../../packages/kernel/src/canonical.js";
import { readGraphPackage } from "../../packages/kernel/src/package-reader.js";
import { writeAppliedPackage } from "../../packages/kernel/src/package-writer.js";
import { validatePackage } from "../../packages/kernel/src/validator.js";

if (process.argv.length !== 4) {
  console.error("Usage: node examples/getting-started/link.mjs <tutorial-package> <new-output>");
  process.exit(1);
}
const [basePath, outputPath] = process.argv.slice(2);
const base = await readGraphPackage(basePath);
const id = suffix => `urn:uuid:00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const artifact = base.elements.find(value => value.id === id(1) && value.type === "core.artifact");
const decision = base.elements.find(value => value.id === id(2) && value.type === "core.decision");
if (!artifact || !decision) throw new Error("Use the package from the getting-started tutorial");
const recordedAt = "2026-11-02T00:40:00Z";
const provenance = { method: "asserted", actor: id(9), recordedAt };
function element(suffix, kind, type, attributes) {
  const value = { format: "morivyx.git-graph/0.1", kind, id: id(suffix), type,
    typeVersion: "0.1", lifecycle: "draft", reviewState: "unreviewed", attributes, provenance };
  return { ...value, revision: revisionId(value) };
}
// Synthetic observations for this tutorial, not measurements or verified claims.
const support = element(11, "entity", "core.observation", {
  method: "tutorial-example", observedAt: recordedAt, value: "サンプル: 変更差分で理由を読める。",
});
const challenge = element(12, "entity", "core.observation", {
  method: "tutorial-example", observedAt: recordedAt, value: "サンプル: 記法に慣れないと編集を誤る。",
});
const relation = (suffix, predicate, target) => element(suffix, "relation", `core.${predicate}`,
  { source: decision.id, predicate, target });
const candidateElements = [support, challenge,
  relation(21, "governs", artifact.id),
  relation(22, "supported_by", support.id),
  relation(23, "challenged_by", challenge.id)];
const resultingRootDigest = graphRootDigest([...base.elements, ...candidateElements]);
const changeSet = {
  format: "morivyx.changeset/0.1", id: id(30), baseRevision: base.revision.id,
  resultingRevision: "graph:tutorial-linked", resultingRootDigest,
  schemaLockDigest: base.calculatedSchemaLockDigest,
  operations: candidateElements.map(value => ({ op: "create", targetId: value.id, afterRevision: value.revision })),
  provenance, recordedAt,
};
const resultingRevision = {
  format: "morivyx.graph-revision/0.1", id: changeSet.resultingRevision,
  parentRevision: base.revision.id, rootDigest: resultingRootDigest,
  schemaLockDigest: base.calculatedSchemaLockDigest,
};
const result = await writeAppliedPackage({ basePath, outputPath, candidateElements, changeSet, resultingRevision });
const validation = await validatePackage(outputPath);
if (!validation.valid) throw new Error(JSON.stringify(validation.issues));
console.log(JSON.stringify({ ...result, artifactId: artifact.id, decisionId: decision.id,
  supportId: support.id, challengeId: challenge.id }, null, 2));
