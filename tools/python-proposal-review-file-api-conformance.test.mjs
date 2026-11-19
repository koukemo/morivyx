import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observe } from "./python-proposal-review-file-api-vectors.mjs";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "packages/portable-core/fixtures");
const vectorsPath = join(fixture, "proposal-review-file-api-vectors.json");
const observationsPath = join(fixture, "proposal-review-file-api-observations.json");
const sha = value => createHash("sha256").update(value).digest("hex");
const expectedPins = { vectors: "b3a42a6cda0aa3801d8af21ffe9771175e703b6b934593313702a5825d30bf18", observations: "b9c80166861e612bd63e553f0cb01ce6462b72d77d5c9d1ff3fa19ca2fdc0688" };
const vectorsBytes = await readFile(vectorsPath), observationsBytes = await readFile(observationsPath);
const vectors = JSON.parse(vectorsBytes), expected = JSON.parse(observationsBytes);

test("proposal reference retains all 353 pre-implementation source pins", async () => {
  const paths = [];
  for (const name of await readdir(join(root, "packages/kernel/src"))) if (name.endsWith(".js")) paths.push("packages/kernel/src/" + name);
  const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
  for (const name of await readdir(join(root, "packages/portable-core"))) if (name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name)) paths.push("packages/portable-core/" + name);
  async function dependencyFiles(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = path + "/" + entry.name;
      if (entry.isDirectory()) await dependencyFiles(child);
      else if (entry.isFile()) paths.push(child);
    }
  }
  await dependencyFiles("packages/kernel/node_modules/yaml");
  paths.push("docs/schema/morivyx.core@0.1.yaml", "docs/validation/fixtures/decision-maintenance-base/.morivyx/schema.lock.yaml",
    "docs/validation/fixtures/decision-maintenance-base/.morivyx/revision.yaml", "tools/python-proposal-review-file-api-vectors.mjs");
  const pins = [];
  for (const path of paths.sort()) pins.push({ path, sha256: sha(await readFile(join(root, path))) });
  assert.equal(pins.length, 353);
  assert.equal(sha(JSON.stringify(pins)), "9746dda8f850422efff17df4fc63fda43793be864d88a94ee739894ffc36873c");
});

test("proposal file API preserves the independent, pre-implementation Node oracle", () => {
  assert.equal(sha(vectorsBytes), expectedPins.vectors);
  assert.equal(sha(observationsBytes), expectedPins.observations);
  assert.equal(vectors.cases.length, 139);
  assert.equal(expected.observations.length, 139);
  assert(expected.observations.every(row => row.fileTreeUnchanged));
  assert(expected.observations.every(row => row.events.every(e => ["lstat", "readdir", "readFile"].includes(e.method))));
});

test("published Node replays every frozen proposal observation", async () => {
  assert.deepEqual(await observe(vectors), expected);
});

async function pythonObservations(inputVectors) {
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-proposal-hermetic-"));
  try {
    const core = join(temporary, "core"); await mkdir(core);
    const excluded = new Set(["evidence_archive.py", "evidence_restore.py", "proposal_acceptance.py", "proposal_review.py"]);
    const source = join(root, "packages/portable-core");
    const modules = (await readdir(source)).filter(name => name.endsWith(".py") && !name.startsWith("test_") && !excluded.has(name));
    assert.equal(modules.length, 47);
    for (const name of modules) await copyFile(join(source, name), join(core, name));
    await cp(join(source, "proposal_review_api"), join(core, "proposal_review_api"), { recursive: true, filter: path => !path.includes("__pycache__") });
    const driver = join(temporary, "driver.py"); await copyFile(join(root, "tools/python-proposal-review-file-api-driver.py"), driver);
    const requested = process.env.MORIVYX_PYTHON ?? process.env.MORIVYX_REFERENCE_PYTHON ?? "python3.14";
    const interpreter = spawnSync(requested, ["-B", "-c", "import sys;assert sys.version_info >= (3,14);print(sys.executable)"], { encoding: "utf8" });
    assert.equal(interpreter.status, 0, interpreter.stderr || `Python 3.14 or later required: ${requested}`);
    const executable = interpreter.stdout.trim();
    const result = spawnSync(executable, ["-B", driver], { cwd: temporary, input: JSON.stringify(inputVectors),
      env: { PATH: "/nonexistent", LANG: "C.UTF-8", PYTHONPATH: core, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("Python proposal file API matches all fields with only 47 public modules and its package", async () => {
  assert.deepEqual(await pythonObservations(vectors), expected);
});

export function supplementaryVectors() {
  const cases = [];
  const add = (name, mutate) => { const row = structuredClone(vectors.cases[0]); row.name = name; mutate(row); cases.push(row); };
  add("path-nul", r => { r.input.basePath = "$ROOT/\u0000"; });
  add("package-directory-is-file", r => { r.files = { "base/.morivyx": { bytes: Buffer.from("ordinary file").toString("base64") } }; });
  add("package-parent-is-file", r => { r.files = { base: { bytes: Buffer.from("ordinary file").toString("base64") } }; });
  for (const name of ["schema.lock.yaml", "revision.yaml"]) add(`header-directory-${name}`, r => { r.files["base/.morivyx/" + name] = { directory: true }; });
  const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const report = { ...expected.observations[0].returned.semanticDiff, id: id(70) };
  const addRecord = (row, path, value) => { row.files["base/.morivyx/" + path] = { bytes: Buffer.from(serializeYamlRecord(value)).toString("base64") }; };
  add("stored-semantic-report", r => { addRecord(r, "reports/comparison.yaml", report); });
  add("stored-report-without-id", r => { const value = structuredClone(report); delete value.id; addRecord(r, "reports/comparison.yaml", value); });
  add("candidate-id-report-conflict", r => { addRecord(r, "reports/comparison.yaml", report); r.input.candidateElements[0].id = id(70); });
  add("changeSet-id-report-conflict", r => { addRecord(r, "reports/comparison.yaml", report); r.input.changeSet.id = id(70); });
  for (const field of ["baseRevision", "targetRevision", "schemaLockDigest", "evaluatedAt", "entries"]) {
    add("report-missing-" + field, r => { const value = structuredClone(report); delete value[field]; addRecord(r, "reports/comparison.yaml", value); });
  }
  const approval = { format: "morivyx.approval/0.1", id: id(71), actor: id(9), targetId: id(1), targetRevision: vectors.cases[0].input.candidateElements[0].revision,
    operation: "review", scope: "proposal", approvedAt: "2026-09-09T12:00:00Z", recordedAt: "2026-09-09T12:00:00Z" };
  add("stored-approval", r => { addRecord(r, `approvals/${id(71).slice(9)}.yaml`, approval); });
  for (const field of ["actor", "targetId", "targetRevision", "operation", "scope", "approvedAt", "recordedAt"]) {
    add("approval-missing-" + field, r => { const value = structuredClone(approval); delete value[field]; addRecord(r, `approvals/${id(71).slice(9)}.yaml`, value); });
  }
  for (const field of ["format", "kind", "id", "type", "typeVersion", "revision", "lifecycle", "reviewState", "attributes", "provenance", "extensions"]) {
    for (const value of [null, false, 3, "", [], {}, "unexpected"]) add(`candidate-${field}-${JSON.stringify(value)}`, r => { r.input.candidateElements[0][field] = value; });
  }
  for (const field of ["method", "actor", "recordedAt"]) for (const value of [null, false, 3, "", [], {}, "unexpected"]) {
    add(`change-provenance-${field}-${JSON.stringify(value)}`, r => { r.input.changeSet.provenance[field] = value; });
    add(`candidate-provenance-${field}-${JSON.stringify(value)}`, r => { r.input.candidateElements[0].provenance[field] = value; });
  }
  for (const key of ["schema.lock.yaml", "revision.yaml"]) {
    const path = "base/.morivyx/" + key;
    for (const [name, transform] of [
      ["bom", source => "\ufeff" + source], ["crlf", source => source.replaceAll("\n", "\r\n")],
      ["tab", source => "\t" + source], ["control", source => "\u0000" + source],
      ["double-newline", source => source + "\n"], ["document-marker", source => "---\n" + source],
      ["comment", source => "# comment\n" + source], ["unquoted-value", source => source.replace(/"([^"\n]+)"/, "$1")],
      ["unknown-field", source => source + "unknown: true\n"],
      ["format-invalid", source => source.replace(/format: "[^"]+"/, 'format: "unsupported"')],
    ]) add(`${key}-${name}`, r => { const source = Buffer.from(r.files[path].bytes, "base64").toString(); r.files[path].bytes = Buffer.from(transform(source)).toString("base64"); });
  }
  for (const method of ["readdir", "readFile"]) for (let occurrence = 2; occurrence <= (method === "readdir" ? 9 : 3); occurrence++) {
    for (const code of ["EACCES", "EIO", "ENOENT"]) add(`${method}-${occurrence}-${code}`, r => { r.fault = { method, occurrence, code }; });
  }
  return { format: vectors.format, provenance: "supplementary differential cases authored after implementation; not part of the pre-implementation oracle", cases };
}

test("supplementary differential cases retain complete diagnostics and filesystem order", async t => {
  const supplementary = supplementaryVectors();
  t.diagnostic(`${supplementary.cases.length} post-implementation differential cases; separate from the frozen 139-case oracle`);
  const reference = await observe(supplementary), actual = await pythonObservations(supplementary);
  const differences = reference.observations.flatMap((row, i) => {
    try { assert.deepEqual(actual.observations[i], row); return []; }
    catch { return [{ name: row.name, expected: row.threw ?? row.returned, actual: actual.observations[i].threw ?? actual.observations[i].returned }]; }
  });
  if (differences.length) console.error(JSON.stringify({ supplementaryDifferences: differences }));
  assert.deepEqual(differences, []);
});
