import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FROZEN_REFERENCES, REPAIRED_SOURCE_PATHS, SOURCE_INTEGRITY_PATH,
  validateSourceIntegrityManifest, verifyHistoricalHarnessBody, verifyReferenceSources } from "./reference-source-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(join(root, SOURCE_INTEGRITY_PATH)));
const clone = () => structuredClone(manifest);

test("exact repaired source identities bind six unchanged historical corpora", async () => {
  assert.equal(Object.keys(FROZEN_REFERENCES).length, 6);
  for (const [id, reference] of Object.entries(FROZEN_REFERENCES)) {
    const verified = await verifyReferenceSources(root, id);
    assert.equal(verified.frozenCases, reference.count);
    assert.equal(verified.repairedSourceCount, 18);
    assert.equal(verified.historicalHarnessBodyMatched, true);
  }
});

test("unregistered, missing, wildcard and placeholder source mappings are rejected", () => {
  const path = REPAIRED_SOURCE_PATHS[0];
  for (const change of [
    (x) => { x.override = true; },
    (x) => { x.repairedSources["packages/kernel/src/canonical.js"] = "a".repeat(64); },
    (x) => { delete x.repairedSources[path]; },
    (x) => { x.repairedSources[path] = "*"; },
    (x) => { x.repairedSources[path] = "pending"; },
    (x) => { x.frozenFixtures["yaml-file-api"].sha256 = "a".repeat(64); },
    (x) => { x.frozenFixtures["yaml-file-api"].count--; },
  ]) {
    const value = clone(); change(value);
    assert.throws(() => validateSourceIntegrityManifest(value));
  }
});

test("normalization and replay changes cannot be approved by a replacement source hash", async () => {
  for (const id of Object.keys(FROZEN_REFERENCES)) {
    const source = await readFile(join(root, `tools/python-${id}-conformance.test.mjs`), "utf8");
    verifyHistoricalHarnessBody(id, source);
    assert.throws(() => verifyHistoricalHarnessBody(id, source + "\n"), /historical normalization/);
  }
});

test("tampered files, corpus replacements and recomputed normalization hashes fail in an isolated tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-source-integrity-"));
  try {
    const files = new Set([SOURCE_INTEGRITY_PATH, ...REPAIRED_SOURCE_PATHS]);
    for (const id of Object.keys(FROZEN_REFERENCES)) {
      const path = `packages/portable-core/fixtures/${id}-vectors.json`;
      files.add(path);
      const frozen = JSON.parse(await readFile(join(root, path)));
      const metadata = ["ledger-store", "package-migration-writer"].includes(id) ? frozen : frozen.reference;
      for (const source of Object.keys(metadata.sources)) files.add(source);
    }
    for (const path of files) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), await readFile(join(root, path)));
    }
    await verifyReferenceSources(directory, "yaml-serialization");
    const manifestPath = join(directory, SOURCE_INTEGRITY_PATH);
    const save = (value) => writeFile(manifestPath, JSON.stringify(value, null, 2) + "\n");

    const sourcePath = join(directory, REPAIRED_SOURCE_PATHS[0]);
    const originalSource = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([originalSource, Buffer.from("\n")]));
    await assert.rejects(verifyReferenceSources(directory, "yaml-serialization"), /registered repaired source/);
    await writeFile(sourcePath, originalSource);

    const fixturePath = join(directory, "packages/portable-core/fixtures/yaml-serialization-vectors.json");
    const fixtureBytes = await readFile(fixturePath);
    await writeFile(fixturePath, Buffer.concat([fixtureBytes, Buffer.from("\n")]));
    await assert.rejects(verifyReferenceSources(directory, "yaml-serialization"), /immutable frozen fixture/);
    await writeFile(fixturePath, fixtureBytes);

    const canonicalPath = join(directory, "packages/kernel/src/canonical.js");
    const canonicalBytes = await readFile(canonicalPath);
    await writeFile(canonicalPath, Buffer.concat([canonicalBytes, Buffer.from("\n")]));
    await assert.rejects(verifyReferenceSources(directory, "yaml-serialization"), /frozen or explicitly repaired/);
    await writeFile(canonicalPath, canonicalBytes);

    for (const id of ["yaml-file-api", "ledger-store", "package-migration-writer"]) {
      const harness = `tools/python-${id}-conformance.test.mjs`;
      const harnessBytes = await readFile(join(directory, harness));
      const changed = Buffer.concat([harnessBytes, Buffer.from("\n")]);
      await writeFile(join(directory, harness), changed);
      const replacement = clone(); replacement.repairedSources[harness] = sha(changed); await save(replacement);
      await assert.rejects(verifyReferenceSources(directory, id), /historical normalization/);
      await writeFile(join(directory, harness), harnessBytes); await save(manifest);
    }
    for (const id of ["ledger-store", "package-migration-writer"]) {
      const path = join(directory, `packages/portable-core/fixtures/${id}-vectors.json`);
      const bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
      await assert.rejects(verifyReferenceSources(directory, id), /immutable frozen fixture/);
      await writeFile(path, bytes);
    }

    const duplicate = JSON.stringify(manifest, null, 2).replace('  "format":', '  "format": "ignored",\n  "format":') + "\n";
    await writeFile(manifestPath, duplicate);
    await assert.rejects(verifyReferenceSources(directory, "yaml-serialization"), /canonical source-integrity manifest/);
    await save(manifest);

    const missing = join(directory, "packages/kernel/package-lock.json");
    const originalLock = await readFile(missing); await rm(missing);
    await assert.rejects(verifyReferenceSources(directory, "yaml-serialization"), { code: "ENOENT" });
    await writeFile(missing, originalLock);
    await verifyReferenceSources(directory, "yaml-serialization");
    await assert.rejects(verifyReferenceSources(directory, "../unknown"), /registered reference required/);
    await assert.rejects(verifyReferenceSources(directory, "constructor"), /registered reference required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
