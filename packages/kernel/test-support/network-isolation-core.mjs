import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import { writeImportedSnapshotPackage } from "../src/import-snapshot-creation.js";
import { prepareImportSnapshotRevision, writeReimportedSnapshotPackage } from "../src/import-snapshot-revision.js";
import { writeAppliedPackage } from "../src/package-writer.js";
import { networkFixture } from "./network-import-fixtures.mjs";

const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// The same Core sequence runs with offline conversion and with actual Docker conversion.
export async function exerciseNetworkCore({ fixture, first, provider, packageBytes, imageId, root, empty, run, validateSaved, preserve }) {
  const authoring = JSON.parse(await readFile(new URL("../test/fixtures/plugin-communication/import-authoring.json", import.meta.url)));
  const create = { ...authoring, manifest: fixture.input.execution.manifest, runRequest: fixture.input.request, runResult: first.result,
    resultingRevision: `graph:network-${provider}-initial`, recordedAt: "2026-09-09T07:00:01Z" };
  const initial = join(root, `${provider}-initial`);
  await writeImportedSnapshotPackage({ basePath: empty, outputPath: initial, request: create });
  const original = await validateSaved(initial);
  const same = networkFixture({ provider, packageBytes: packageBytes, imageId: imageId });
  same.input.request.runId = `run:network-live-${provider}-unchanged`;
  const unchanged = await run(same, "2026-09-09T07:00:30.000Z");
  const noChange = { ...create, format: "morivyx.import-snapshot-revision/0.1", runRequest: same.input.request, runResult: unchanged.result,
    baseRevision: original.revision.id, baseRootDigest: original.revision.rootDigest, baselineArtifactRevision: original.elements[0].revision,
    changeSetId: id(805), resultingRevision: `graph:network-${provider}-unchanged`, recordedAt: "2026-09-09T07:00:31Z" };
  const unchangedPath = join(root, `${provider}-unchanged`);
  await assert.rejects(writeReimportedSnapshotPackage({ basePath: initial, outputPath: unchangedPath, request: noChange }), { code: "IMPORT_REVISION_UNCHANGED" });
  await assert.rejects(access(unchangedPath), { code: "ENOENT" }); await preserve();
  const next = networkFixture({ provider, packageBytes: packageBytes, imageId: imageId, changed: true });
  const second = await run(next, "2026-09-09T07:01:00.000Z");
  const revision = { ...create, format: "morivyx.import-snapshot-revision/0.1", runRequest: next.input.request, runResult: second.result,
    baseRevision: original.revision.id, baseRootDigest: original.revision.rootDigest, baselineArtifactRevision: original.elements[0].revision,
    changeSetId: id(803), resultingRevision: `graph:network-${provider}-updated`, recordedAt: "2026-09-09T07:01:01Z" };
  const updated = join(root, `${provider}-updated`);
  await writeReimportedSnapshotPackage({ basePath: initial, outputPath: updated, request: revision });
  const saved = await validateSaved(updated), artifact = saved.elements[0];
  assert.equal(artifact.id, original.elements[0].id); assert.notEqual(artifact.attributes.digest, original.elements[0].attributes.digest);
  assert.equal(artifact.extensions["morivyx.import/snapshot"].executionBinding, "not-verified");
  assert.deepEqual(artifact.extensions["morivyx.import/snapshot"].informationLoss, second.result.output.informationLoss);
  const edited = structuredClone(artifact); edited.attributes.uri = "urn:human:retained"; delete edited.extensions;
  edited.provenance = { method: "asserted", actor: create.actor, recordedAt: "2026-09-09T07:01:30Z" }; edited.revision = revisionId(edited);
  const humanRevision = { ...saved.revision, id: `graph:network-${provider}-human`, parentRevision: saved.revision.id, rootDigest: graphRootDigest([edited]) };
  const changeSet = { format: "morivyx.changeset/0.1", id: id(899), baseRevision: saved.revision.id, resultingRevision: humanRevision.id,
    resultingRootDigest: humanRevision.rootDigest, schemaLockDigest: saved.calculatedSchemaLockDigest,
    operations: [{ op: "revise", targetId: edited.id, beforeRevision: artifact.revision, afterRevision: edited.revision }],
    provenance: edited.provenance, recordedAt: edited.provenance.recordedAt };
  const humanPath = join(root, `${provider}-human`);
  await writeAppliedPackage({ basePath: updated, outputPath: humanPath, changeSet, candidateElements: [edited], resultingRevision: humanRevision });
  const human = await validateSaved(humanPath);
  const conflict = networkFixture({ provider, packageBytes: packageBytes, imageId: imageId, changed: true });
  conflict.input.request.runId = `run:network-live-${provider}-human-conflict`;
  const fresh = await run(conflict, "2026-09-09T07:02:00.000Z");
  assert.throws(() => prepareImportSnapshotRevision(human, { ...revision, runRequest: conflict.input.request, runResult: fresh.result,
    changeSetId: id(901), resultingRevision: `graph:network-${provider}-blocked`, recordedAt: "2026-09-09T07:02:01Z",
    baseRevision: human.revision.id, baseRootDigest: human.revision.rootDigest, baselineArtifactRevision: artifact.revision }),
  { code: "IMPORT_REVISION_LOCAL_CONFLICT" });
  await preserve();
}
