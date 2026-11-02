import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readGraphPackageReference,
  writeGraphPackageReference,
} from "../test-support/graph-package-roundtrip-reference.mjs";
import { serializeYamlRecord } from "../src/yaml-writer.js";
import { writeYamlRecordReference } from "../test-support/yaml-authoring-roundtrip-reference.mjs";
import { graphRootDigest, revisionId } from "../src/canonical.js";
import { readGraphPackage } from "../src/package-reader.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(testDirectory, "fixtures");
const vectorPath = join(
  fixtureDirectory,
  "graph-package-roundtrip-vector.json",
);

function logicalValue({
  schemaLock,
  revision,
  elements,
  approvals,
  changeSets,
  migrations,
  reports,
}) {
  return {
    schemaLock,
    revision,
    elements,
    approvals,
    changeSets,
    migrations,
    reports,
  };
}

async function loadVector() {
  return JSON.parse(await readFile(vectorPath, "utf8"));
}

async function loadInputFiles(vector) {
  return Object.fromEntries(
    await Promise.all(
      vector.inputFiles.map(async (path) => [
        path,
        await readFile(join(fixtureDirectory, vector.inputRoot, path), "utf8"),
      ]),
    ),
  );
}

async function loadExpectedFiles(vector) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(vector.expectedOutputFiles).map(
        async ([path, fixture]) => [
          path,
          await readFile(join(fixtureDirectory, fixture), "utf8"),
        ],
      ),
    ),
  );
}

async function materializePackage(root, files) {
  for (const [path, source] of Object.entries(files)) {
    const outputPath = join(root, ".morivyx", path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source, "utf8");
  }
}

test("independent reader and product reader agree on a fixed Graph package", async () => {
  const vector = await loadVector();
  const files = await loadInputFiles(vector);
  const product = logicalValue(
    await readGraphPackage(join(fixtureDirectory, "package-v1-roundtrip")),
  );

  assert.deepEqual(product, vector.inputLogicalValue);
  assert.deepEqual(
    readGraphPackageReference(files),
    vector.inputLogicalValue,
  );
});

test("independent writer recreates the fixed Graph package for both readers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-package-vector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vector = await loadVector();
  const expectedFiles = await loadExpectedFiles(vector);
  const writtenFiles = writeGraphPackageReference(vector.inputLogicalValue);

  assert.deepEqual(Object.keys(writtenFiles), Object.keys(expectedFiles));
  assert.deepEqual(writtenFiles, expectedFiles);
  await materializePackage(directory, writtenFiles);

  const independentOutput = readGraphPackageReference(writtenFiles);
  const productOutput = logicalValue(await readGraphPackage(directory));
  assert.deepEqual(independentOutput, vector.outputLogicalValue);
  assert.deepEqual(productOutput, vector.outputLogicalValue);
  assert.deepEqual(
    writeGraphPackageReference(independentOutput),
    writtenFiles,
  );
});

test("reads Core data and provenance after the plugin runtime is removed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-plugin-removal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vector = await loadVector();
  const packageValue = structuredClone(vector.inputLogicalValue);
  packageValue.approvals = [];
  packageValue.changeSets = [];
  packageValue.migrations = [];
  packageValue.reports = [];

  const source = packageValue.elements[0];
  source.provenance.method = "imported";
  const pluginExtension = {
    packageDigest: `sha256:${"a".repeat(64)}`,
    pluginId: "example.plugin",
    pluginVersion: "1.0.0",
    runId: "urn:uuid:550e8400-e29b-41d4-a716-446655440700",
  };
  source.extensions["example.plugin/run-provenance"] = pluginExtension;
  source.revision = revisionId(source);
  packageValue.revision.rootDigest = graphRootDigest(packageValue.elements);

  await materializePackage(
    directory,
    writeGraphPackageReference(packageValue),
  );
  const pluginDirectory = join(directory, ".plugin-runtime", "example.plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(
    join(pluginDirectory, "manifest.json"),
    `${JSON.stringify({ id: "example.plugin", version: "1.0.0" })}\n`,
    "utf8",
  );

  const beforeRemoval = logicalValue(await readGraphPackage(directory));
  const beforeSource = beforeRemoval.elements.find(
    (element) => element.id === source.id,
  );
  assert.ok(beforeSource);
  await rm(join(directory, ".plugin-runtime"), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    access(pluginDirectory),
    (error) => error.code === "ENOENT",
  );
  const afterRemoval = logicalValue(await readGraphPackage(directory));

  assert.deepEqual(afterRemoval, beforeRemoval);
  const restored = afterRemoval.elements.find(
    (element) => element.id === source.id,
  );
  assert.ok(restored);
  assert.deepEqual(
    restored.extensions["example.plugin/run-provenance"],
    pluginExtension,
  );
  assert.deepEqual(restored.provenance, beforeSource.provenance);
  assert.equal(restored.revision, revisionId(restored));
  assert.equal(
    afterRemoval.revision.rootDigest,
    graphRootDigest(afterRemoval.elements),
  );
});

for (const [name, expires, revokes] of [
  ["neither optional field", false, false],
  ["expiry only", true, false],
  ["revocation only", false, true],
  ["expiry and revocation", true, true],
]) {
  test(`independent Approval roundtrip preserves ${name}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-vector-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const vector = await loadVector();
    const value = structuredClone(vector.inputLogicalValue);
    const original = value.approvals[0];
    const approval = {
      ...original,
      id: "urn:uuid:550e8400-e29b-41d4-a716-446655440900",
      operation: revokes ? "revoke" : original.operation,
      ...(revokes ? { revokes: original.id } : {}),
      ...(expires ? { expiresAt: "2026-08-01T00:00:00Z" } : {}),
    };
    value.approvals.push(approval);
    const before = structuredClone(value);
    const expected = structuredClone(vector.outputLogicalValue);
    expected.approvals.push(structuredClone(approval));
    const referenceYaml = writeYamlRecordReference(approval);
    assert.equal(referenceYaml, serializeYamlRecord(approval));
    if (expires && revokes) {
      assert.ok(referenceYaml.indexOf("expiresAt:") < referenceYaml.indexOf("revokes:"));
    }
    const files = writeGraphPackageReference(value);
    assert.equal(files["approvals/550e8400-e29b-41d4-a716-446655440900.yaml"], referenceYaml);
    await materializePackage(directory, files);
    const independent = readGraphPackageReference(files);
    const product = logicalValue(await readGraphPackage(directory));
    assert.deepEqual(independent, expected);
    assert.deepEqual(product, expected);
    assert.deepEqual(writeGraphPackageReference(independent), files);
    assert.deepEqual(value, before);
    assert.deepEqual(vector.inputLogicalValue.approvals, [original]);
  });
}
