import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareRepositoryImportSnapshots,
  importRepositoryFile,
  repositoryImportRequest,
} from "../src/repository-importer.js";
import {
  REPOSITORY_REIMPORT_ASSESSMENT_FORMAT,
  assessRepositoryReimport,
} from "../src/repository-reimport-assessment.js";

const comparison = (status) => ({
  format: "morivyx.repository-import-comparison/0.1",
  status,
});
const baseline = { id: "artifact:managed", revision: "rev:baseline" };
const unchanged = { ...baseline };
const changed = { id: baseline.id, revision: "rev:changed" };

let checks = 0;
function check(name, operation) {
  try {
    operation();
    checks += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function status(externalStatus, currentTarget = unchanged) {
  return assessRepositoryReimport({
    comparison: comparison(externalStatus),
    baselineTarget: baseline,
    currentTarget,
  });
}

check("unchanged", () => {
  const result = status("current");
  assert.equal(result.format, REPOSITORY_REIMPORT_ASSESSMENT_FORMAT);
  assert.equal(result.status, "unchanged");
  assert.equal(result.localStatus, "baseline");
  assert.deepEqual(result.issues, []);
});

check("local changed", () => {
  const result = status("current", changed);
  assert.equal(result.status, "local-changed");
  assert.equal(result.localStatus, "changed");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_LOCAL_CHANGED" }]);
});

check("external changed", () => {
  const result = status("stale");
  assert.equal(result.status, "external-changed");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_EXTERNAL_CHANGED" }]);
});

check("conflict", () => {
  const result = status("stale", changed);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_CONFLICT" }]);
});

check("external missing", () => {
  const result = status("missing");
  assert.equal(result.status, "external-missing");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_EXTERNAL_MISSING" }]);
});

check("missing conflict", () => {
  const result = status("missing", changed);
  assert.equal(result.status, "missing-conflict");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_MISSING_CONFLICT" }]);
});

check("source unavailable", () => {
  const result = status("unavailable", changed);
  assert.equal(result.status, "blocked-unavailable");
  assert.equal(result.localStatus, "changed");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE" }]);
});

check("external invalid", () => {
  const result = status("invalid");
  assert.equal(result.status, "blocked-invalid");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_EXTERNAL_INVALID" }]);
});

check("target id mismatch", () => {
  const result = assessRepositoryReimport({
    comparison: comparison("stale"),
    baselineTarget: baseline,
    currentTarget: { id: "artifact:other", revision: "rev:changed" },
  });
  assert.equal(result.status, "blocked-invalid");
  assert.deepEqual(result.issues, [{ code: "REPOSITORY_REIMPORT_TARGET_ID_MISMATCH" }]);
});

check("invalid target state and input immutability", () => {
  const inputComparison = comparison("stale");
  const inputBaseline = { ...baseline };
  const inputCurrent = { ...changed };
  const frozenComparison = JSON.stringify(inputComparison);
  const frozenBaseline = JSON.stringify(inputBaseline);
  const frozenCurrent = JSON.stringify(inputCurrent);
  const valid = assessRepositoryReimport({
    comparison: inputComparison,
    baselineTarget: inputBaseline,
    currentTarget: inputCurrent,
  });
  assert.equal(valid.status, "conflict");
  assert.equal(JSON.stringify(inputComparison), frozenComparison);
  assert.equal(JSON.stringify(inputBaseline), frozenBaseline);
  assert.equal(JSON.stringify(inputCurrent), frozenCurrent);

  const invalid = assessRepositoryReimport({
    comparison: inputComparison,
    baselineTarget: { id: baseline.id },
    currentTarget: inputCurrent,
  });
  assert.equal(invalid.status, "blocked-invalid");
  assert.deepEqual(invalid.issues, [
    { code: "REPOSITORY_REIMPORT_TARGET_STATE_INVALID" },
  ]);
});

function validInput() {
  return {
    comparison: comparison("current"),
    baselineTarget: { ...baseline },
    currentTarget: { ...unchanged },
  };
}

function assertInvalidInput(input) {
  assert.deepEqual(assessRepositoryReimport(input), {
    format: REPOSITORY_REIMPORT_ASSESSMENT_FORMAT,
    externalStatus: null,
    baselineTarget: null,
    currentTarget: null,
    localStatus: null,
    status: "blocked-invalid",
    issues: [{ code: "REPOSITORY_REIMPORT_ASSESSMENT_INPUT_INVALID" }],
  });
}

check("invalid input roots", () => {
  for (const value of [
    undefined, null, [], true, 123, "text", 1n, Symbol("input"), () => {},
  ]) {
    assertInvalidInput(value);
  }
});

check("nonlogical records", () => {
  const cycle = validInput();
  cycle.self = cycle;
  const hidden = validInput();
  Object.defineProperty(hidden, "hidden", { value: 1 });
  const sparse = validInput();
  sparse.extra = new Array(2);
  const cases = [
    new Date(),
    new Map(),
    Object.create(validInput()),
    cycle,
    hidden,
    sparse,
    { ...validInput(), extra: NaN },
    { ...validInput(), extra: Infinity },
    { ...validInput(), extra: 1n },
    { ...validInput(), [Symbol("extra")]: true },
  ];
  for (const value of cases) assertInvalidInput(value);
});

check("accessors are not executed", () => {
  for (const [container, key] of [
    [null, "comparison"],
    ["comparison", "format"],
    ["comparison", "status"],
    ["baselineTarget", "id"],
    ["baselineTarget", "revision"],
    ["currentTarget", "id"],
    ["currentTarget", "revision"],
  ]) {
    const input = validInput();
    let reads = 0;
    Object.defineProperty(container === null ? input : input[container], key, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("accessor executed");
      },
    });
    assertInvalidInput(input);
    assert.equal(reads, 0, `${container}.${key}`);
  }
});

check("malformed target descriptors", () => {
  for (const side of ["baselineTarget", "currentTarget"]) {
    for (const target of [
      null, [], {}, { id: baseline.id }, { revision: baseline.revision },
      { ...baseline, id: [baseline.id] },
      { ...baseline, revision: [baseline.revision] },
      { ...baseline, id: "" },
      { ...baseline, revision: "" },
      { ...baseline, extra: true },
    ]) {
      const input = validInput();
      input[side] = target;
      const result = assessRepositoryReimport(input);
      assert.equal(result.status, "blocked-invalid");
      assert.deepEqual(result.issues, [
        { code: "REPOSITORY_REIMPORT_TARGET_STATE_INVALID" },
      ]);
    }
  }
});

check("immutable all-status matrix", () => {
  for (const [external, expected] of [
    ["current", ["unchanged", "local-changed"]],
    ["stale", ["external-changed", "conflict"]],
    ["missing", ["external-missing", "missing-conflict"]],
    ["unavailable", ["blocked-unavailable", "blocked-unavailable"]],
    ["invalid", ["blocked-invalid", "blocked-invalid"]],
  ]) {
    for (const [index, current] of [unchanged, changed].entries()) {
      const input = Object.freeze({
        comparison: Object.freeze(comparison(external)),
        baselineTarget: Object.freeze({ ...baseline }),
        currentTarget: Object.freeze({ ...current }),
      });
      const before = JSON.stringify(input);
      const first = assessRepositoryReimport(input);
      assert.equal(first.status, expected[index]);
      assert.deepEqual(first, assessRepositoryReimport(input));
      assert.equal(JSON.stringify(input), before);
    }
  }
});

check("output target descriptors are detached", () => {
  const input = validInput();
  const result = assessRepositoryReimport(input);
  assert.notEqual(result.baselineTarget, input.baselineTarget);
  assert.notEqual(result.currentTarget, input.currentTarget);
  result.baselineTarget.revision = "rev:output-only";
  result.currentTarget.id = "artifact:output-only";
  assert.deepEqual(input, validInput());
});

check("null prototype records", () => {
  const input = validInput();
  for (const key of Object.keys(input)) {
    input[key] = Object.assign(Object.create(null), input[key]);
  }
  const result = assessRepositoryReimport(
    Object.assign(Object.create(null), input),
  );
  assert.equal(result.status, "unchanged");
});

const repository = await mkdtemp(join(tmpdir(), "morivyx-assessment-"));
try {
  const file = join(repository, "source.txt");
  const request = repositoryImportRequest({
    runId: "assessment-integration",
    repositoryRoot: repository,
    externalId: "assessment-fixture",
    locator: "source.txt",
  });
  const now = () => "2026-09-08T05:00:00Z";
  await writeFile(file, "baseline\n", "utf8");
  const previousResult = await importRepositoryFile(request, { now });
  const compare = (currentResult) => compareRepositoryImportSnapshots({
    previousResult,
    currentRequest: request,
    currentResult,
  });
  const unchangedComparison = compare(
    await importRepositoryFile(request, { now }),
  );
  await writeFile(file, "external change\n", "utf8");
  const changedComparison = compare(await importRepositoryFile(request, { now }));
  const beforeAssessment = await readFile(file, "utf8");
  const input = {
    comparison: changedComparison,
    baselineTarget: Object.freeze({ ...baseline }),
    currentTarget: Object.freeze({ ...changed }),
  };
  const conflict = assessRepositoryReimport(input);
  const afterAssessment = await readFile(file, "utf8");
  await rm(file);
  const missingComparison = compare(await importRepositoryFile(request, { now }));
  check("real importer comparison integration", () => {
    assert.equal(
      assessRepositoryReimport({ ...input, comparison: unchangedComparison }).status,
      "local-changed",
    );
    assert.equal(conflict.status, "conflict");
    assert.equal(
      assessRepositoryReimport({ ...input, comparison: missingComparison }).status,
      "missing-conflict",
    );
    assert.equal(afterAssessment, beforeAssessment);
    assert.deepEqual(conflict, assessRepositoryReimport(input));
  });
} finally {
  await rm(repository, { recursive: true, force: true });
}

assert.equal(checks, 18);
console.log(`Repository reimport assessment contract audit passed: ${checks} checks.`);
