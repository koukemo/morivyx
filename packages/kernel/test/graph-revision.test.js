import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PackageError } from "../src/errors.js";
import { validateGraphRevision } from "../src/graph-revision.js";
import { readGraphPackage } from "../src/package-reader.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const revisionFixture = join(fixture, ".morivyx", "revision.yaml");
const digest = (value) => `sha256:${value.repeat(64)}`;

function revision(overrides = {}) {
  return {
    format: "morivyx.graph-revision/0.1",
    id: "graph:target",
    parentRevision: "graph:base",
    rootDigest: digest("1"),
    schemaLockDigest: digest("2"),
    ...overrides,
  };
}

function expectCode(value, path) {
  assert.throws(
    () => validateGraphRevision(value),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "GRAPH_REVISION_INVALID");
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("accepts the initial fixture and a later GraphRevision", async () => {
  const initial = await readYamlRecord(revisionFixture);
  assert.equal(initial.parentRevision, null);
  assert.equal(validateGraphRevision(initial), initial);
  const later = revision();
  assert.equal(validateGraphRevision(later), later);
});

test("rejects malformed GraphRevision roots and fields", () => {
  const cases = [
    [null, ""],
    [[], ""],
    [{ ...revision(), format: "morivyx.graph-revision/1.0" }, "/format"],
    [{ ...revision(), unknown: "value" }, "/unknown"],
    [{ ...revision(), id: "invalid" }, "/id"],
    [{ ...revision(), parentRevision: "invalid" }, "/parentRevision"],
    [{ ...revision(), parentRevision: "graph:target" }, "/parentRevision"],
    [{ ...revision(), rootDigest: "invalid" }, "/rootDigest"],
    [{ ...revision(), schemaLockDigest: "invalid" }, "/schemaLockDigest"],
  ];
  for (const [record, path] of cases) {
    expectCode(record, path);
  }
});

test("includes revision.yaml before a GraphRevision JSON Pointer", () => {
  const path = "/package/.morivyx/revision.yaml";
  assert.throws(
    () => validateGraphRevision({ ...revision(), id: "invalid" }, path),
    (error) =>
      error.code === "GRAPH_REVISION_INVALID" && error.path === `${path}#/id`,
  );
});

test("rejects structural errors before package digest comparisons", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const path = join(directory, ".morivyx", "revision.yaml");
  const record = await readYamlRecord(path);
  await writeFile(
    path,
    serializeYamlRecord({
      ...record,
      rootDigest: "invalid",
      schemaLockDigest: "invalid",
    }),
    "utf8",
  );

  await assert.rejects(
    readGraphPackage(directory),
    (error) =>
      error.code === "GRAPH_REVISION_INVALID" &&
      error.path === `${path}#/rootDigest`,
  );
});
