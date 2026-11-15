import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const SOURCE_INTEGRITY_PATH = "packages/portable-core/fixtures/yaml-runtime-source-integrity.json";
export const FROZEN_REFERENCES = Object.freeze({
  "yaml-serialization": { count: 695, sha256: "3a568836d5df6db6e38ffb59d32e8b012bdcb1e107fdd1212e10cb1204752178",
    harness: "2fa5d45b715b3de46e46a1832828557745fc493c829422503c995b7011ba8e8d",
    oldLabel: "the original writer retains all pre-implementation bytes, rejection paths and inputs",
    label: "the repaired writer retains all frozen bytes, rejection paths and inputs" },
  "report-file-api": { count: 1041, sha256: "cab3373891f15513869a24955ef042f85a27d1d183769867c5f77f8e171b5793",
    harness: "8dc5173de6e1e63d8d71d3be7e6bb1bae24d8d68c5cf4ff2d742c14ff31f176a",
    oldLabel: "the original file APIs reproduce the frozen results and owned file layouts",
    label: "the repaired file APIs reproduce the frozen results and owned file layouts" },
  "yaml-file-api": { count: 5045, sha256: "a66814ba144c3ca7d6bcda9b7570baf1c847430af36af4b6bb2bf3215cadd275",
    harness: "3ffce717b60ec9e86de66be72de48c6bb171111e838d7bdf17165911da29c5d2",
    oldLabel: "original YAML file reads reproduce frozen logical values, diagnostics and untouched layouts",
    label: "repaired YAML file reads reproduce frozen logical values, diagnostics and untouched layouts" },
  "package-file-api": { count: 1063, sha256: "9557f51fd314eeb510526211ab4fa478c3afe05ff7e0cdde51e8fc79f2e57ddd",
    harness: "7518eacbf5251ec87fdc0aca709445715eb3d5194cfd4d7f5cf78f54e0813bfe",
    oldLabel: "original package file APIs replay the frozen results and unchanged layouts",
    label: "repaired package file APIs replay the frozen results and unchanged layouts" },
  "ledger-store": { count: 156, sha256: "0e7374160de9d9b90f2f9497f9c87b469cd89b56b61cd75b81a4cca4e77f5637",
    harness: "c01215925b4ec6061c315802bf4c6b6d71ee15d108aedd0fc0d100a220c03afa",
    oldLabel: "the pinned Node ledger operations reproduce every frozen filesystem result",
    label: "the repaired Node ledger operations reproduce every frozen filesystem result" },
  "package-migration-writer": { count: 194, sha256: "90e1ffd76d284176de463446ade3a3785ccee12639164d30c653424158069887",
    harness: "811440ae94d89dcf4937e4e0f91f15e37743867d60a866815178265e4e6486e6",
    oldLabel: "the original migration writer reproduces every pre-implementation result",
    label: "the repaired migration writer reproduces every pre-implementation result" },
});
export const REPAIRED_SOURCE_PATHS = Object.freeze([
  ...["reader", "writer", "authoring-profile", "authoring-order", "null-policy", "set-policy"].map((name) => `packages/kernel/src/yaml-${name}.js`),
  "packages/kernel/test/yaml-depth-runtime.test.js",
  "packages/kernel/test/yaml-writer.test.js",
  "packages/kernel/test/fixtures/yaml-depth-runtime-runner.mjs",
  "packages/kernel/test/fixtures/yaml-depth-runtime-vectors.json",
  "tools/reference-source-integrity.mjs",
  "tools/reference-source-integrity.test.mjs",
  ...Object.keys(FROZEN_REFERENCES).map((id) => `tools/python-${id}-conformance.test.mjs`),
]);
for (const reference of Object.values(FROZEN_REFERENCES)) Object.freeze(reference);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

export function validateSourceIntegrityManifest(manifest) {
  exactKeys(manifest, ["format", "frozenFixtures", "repairedSources"], "source-integrity manifest fields");
  assert.equal(manifest.format, "morivyx.yaml-runtime-source-integrity/1");
  exactKeys(manifest.frozenFixtures, Object.keys(FROZEN_REFERENCES), "frozen fixture identities");
  for (const [id, expected] of Object.entries(FROZEN_REFERENCES)) {
    assert.deepEqual(manifest.frozenFixtures[id], { count: expected.count, sha256: expected.sha256 });
  }
  exactKeys(manifest.repairedSources, REPAIRED_SOURCE_PATHS, "exact repaired source paths");
  for (const [path, hash] of Object.entries(manifest.repairedSources)) {
    assert.match(hash, /^[0-9a-f]{64}$/, path);
  }
}

function replaceOnce(source, from, to, label) {
  assert.equal(source.split(from).length, 2, label);
  return source.replace(from, to);
}

export function verifyHistoricalHarnessBody(id, current) {
  assert.ok(Object.hasOwn(FROZEN_REFERENCES, id), "registered reference required");
  const reference = FROZEN_REFERENCES[id];
  assert.ok(reference, "registered reference required");
  let restored = replaceOnce(current,
    'import { verifyReferenceSources } from "./reference-source-integrity.mjs";\n', "", "integrity import");
  restored = replaceOnce(restored, `test("${reference.label}",`, `test("${reference.oldLabel}",`, "test label");
  const selfGuard = ["yaml-file-api", "package-file-api"].includes(id) ?
    "    assert.equal(sha(await readFile(fileURLToPath(import.meta.url))), frozen.reference.normalizationHarnessSha256);\n" : "";
  const sourceGuard = id === "ledger-store" ?
    '    for (const [path, expected] of Object.entries(fixture.sources)) assert.equal(digest(await readFile(new URL("../" + path, import.meta.url))), expected);' :
    id === "package-migration-writer" ?
    '    for (const [path, expected] of Object.entries(frozen.sources)) assert.equal(hash(await readFile(new URL("../" + path, import.meta.url))), expected, path);' :
    "    for (const [path, expected] of Object.entries(frozen.reference.sources)) assert.equal(sha(await readFile(join(root, path))), expected, path);";
  const currentGuard = ["ledger-store", "package-migration-writer"].includes(id) ?
    `    await verifyReferenceSources(fileURLToPath(new URL("../", import.meta.url)), "${id}");` :
    `    await verifyReferenceSources(root, "${id}");`;
  restored = replaceOnce(restored, currentGuard, selfGuard + sourceGuard, "source bootstrap");
  assert.equal(digest(restored), reference.harness, `historical normalization, input, observation and replay bodies: ${id}`);
}

export async function verifyReferenceSources(root, id) {
  assert.ok(Object.hasOwn(FROZEN_REFERENCES, id), "registered reference required");
  const reference = FROZEN_REFERENCES[id];
  assert.ok(reference, "registered reference required");
  const manifestBytes = await readFile(join(root, SOURCE_INTEGRITY_PATH));
  const manifest = JSON.parse(manifestBytes);
  // A single canonical spelling rejects duplicate keys and ambiguous encodings.
  assert.equal(manifestBytes.toString("utf8"), JSON.stringify(manifest, null, 2) + "\n", "canonical source-integrity manifest");
  validateSourceIntegrityManifest(manifest);
  // The oldest serialization corpus predates a lock-file pin. Require the
  // same unchanged dependency lock already bound by later corpora.
  assert.equal(digest(await readFile(join(root, "packages/kernel/package-lock.json"))),
    "f7a7d765873730e4fbc69ce85d6464c8c62d46e2dc29f7801491bf7f8e68d37d", "lock-pinned yaml dependency");
  const fixturePath = `packages/portable-core/fixtures/${id}-vectors.json`;
  const fixtureBytes = await readFile(join(root, fixturePath));
  assert.equal(digest(fixtureBytes), reference.sha256, `immutable frozen fixture: ${id}`);
  const frozen = JSON.parse(fixtureBytes);
  assert.equal(frozen.count, reference.count);
  assert.equal(frozen.cases.length, reference.count);
  const metadata = ["ledger-store", "package-migration-writer"].includes(id) ? frozen : frozen.reference;
  if (metadata.normalizationHarnessSha256 !== undefined) {
    assert.equal(metadata.normalizationHarnessSha256, reference.harness);
  }
  for (const [path, expected] of Object.entries(manifest.repairedSources)) {
    assert.equal(digest(await readFile(join(root, path))), expected, `registered repaired source: ${path}`);
  }
  for (const name of Object.keys(FROZEN_REFERENCES)) {
    verifyHistoricalHarnessBody(name, await readFile(join(root, `tools/python-${name}-conformance.test.mjs`), "utf8"));
  }
  for (const [path, historicalHash] of Object.entries(metadata.sources)) {
    const expected = manifest.repairedSources[path] ?? historicalHash;
    assert.equal(digest(await readFile(join(root, path))), expected, `frozen or explicitly repaired source: ${path}`);
  }
  return { fixture: id, frozenCases: reference.count, historicalHarnessBodyMatched: true,
    repairedSourceCount: REPAIRED_SOURCE_PATHS.length };
}
