import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PackageError } from "../src/errors.js";
import { readGraphPackage } from "../src/package-reader.js";
import { validateSchemaLock } from "../src/schema-lock.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const lockFixture = join(fixture, ".morivyx", "schema.lock.yaml");
const digest = (value) => `sha256:${value.repeat(64)}`;

function schemaLock(schemas = []) {
  return {
    format: "morivyx.schema-lock/0.1",
    stableIdScheme: "urn-uuid-v4",
    digestAlgorithm: "sha256",
    schemas,
  };
}

function entry(schemaId = "example.core", version = "0.1", value = "1") {
  return { schemaId, version, digest: digest(value) };
}

function expectCode(value, code, path) {
  assert.throws(
    () => validateSchemaLock(value),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, code);
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("accepts the repository fixture, an empty lock, and sorted entries", async () => {
  const fixtureRecord = await readYamlRecord(lockFixture);
  assert.equal(validateSchemaLock(fixtureRecord), fixtureRecord);
  const empty = schemaLock();
  assert.equal(validateSchemaLock(empty), empty);
  const sorted = schemaLock([
    entry("example.alpha", "0.1", "1"),
    entry("example.alpha", "0.2", "2"),
    entry("example.beta", "0.1", "3"),
  ]);
  assert.equal(validateSchemaLock(sorted), sorted);
});

test("rejects malformed roots and Schema entries with JSON Pointers", () => {
  const cases = [
    [null, "SCHEMA_LOCK_INVALID", ""],
    [[], "SCHEMA_LOCK_INVALID", ""],
    [
      { ...schemaLock(), format: "morivyx.schema-lock/1.0" },
      "PACKAGE_FORMAT_UNSUPPORTED",
      "/format",
    ],
    [{ ...schemaLock(), unknown: true }, "SCHEMA_LOCK_INVALID", "/unknown"],
    [
      { ...schemaLock(), stableIdScheme: "other" },
      "STABLE_ID_SCHEME_UNSUPPORTED",
      "/stableIdScheme",
    ],
    [
      { ...schemaLock(), digestAlgorithm: "other" },
      "DIGEST_ALGORITHM_UNSUPPORTED",
      "/digestAlgorithm",
    ],
    [{ ...schemaLock(), schemas: {} }, "SCHEMA_LOCK_INVALID", "/schemas"],
    [schemaLock([null]), "SCHEMA_LOCK_INVALID", "/schemas/0"],
    [schemaLock([[]]), "SCHEMA_LOCK_INVALID", "/schemas/0"],
    [
      schemaLock([{ ...entry(), unknown: true }]),
      "SCHEMA_LOCK_INVALID",
      "/schemas/0/unknown",
    ],
    [schemaLock([entry("")]), "SCHEMA_LOCK_INVALID", "/schemas/0/schemaId"],
    [
      schemaLock([entry("example.core", "")]),
      "SCHEMA_LOCK_INVALID",
      "/schemas/0/version",
    ],
    [
      schemaLock([{ ...entry(), digest: "invalid" }]),
      "SCHEMA_LOCK_INVALID",
      "/schemas/0/digest",
    ],
  ];
  for (const [record, code, path] of cases) {
    expectCode(record, code, path);
  }
});

test("rejects descending, duplicate, and NFC-equivalent Schema entries", () => {
  for (const schemas of [
    [entry("example.beta"), entry("example.alpha")],
    [entry(), entry()],
    [entry("Cafe\u0301"), entry("Café")],
  ]) {
    expectCode(
      schemaLock(schemas),
      "SCHEMA_LOCK_ORDER_INVALID",
      "/schemas/1",
    );
  }
});

test("includes schema.lock.yaml before a Schema lock JSON Pointer", () => {
  const path = "/package/.morivyx/schema.lock.yaml";
  assert.throws(
    () => validateSchemaLock(schemaLock([{ ...entry(), digest: "bad" }]), path),
    (error) =>
      error.code === "SCHEMA_LOCK_INVALID" &&
      error.path === `${path}#/schemas/0/digest`,
  );
});

test("rejects structural errors before the recorded lock digest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-schema-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const path = join(directory, ".morivyx", "schema.lock.yaml");
  const record = await readYamlRecord(path);
  record.schemas[0].digest = "invalid";
  await writeFile(path, serializeYamlRecord(record), "utf8");

  await assert.rejects(
    readGraphPackage(directory),
    (error) =>
      error.code === "SCHEMA_LOCK_INVALID" &&
      error.path === `${path}#/schemas/0/digest`,
  );
});
