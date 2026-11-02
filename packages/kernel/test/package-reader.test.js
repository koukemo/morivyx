import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
  canonicalJson,
  changeSetDigest,
  graphRootDigest,
  migrationDigest,
  revisionId,
} from "../src/canonical.js";
import {
  inspectPackage,
  PackageError,
  readGraphPackage,
} from "../src/package-reader.js";
import { serializeReportYaml } from "../src/report.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function copyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-kernel-"));
  temporaryDirectories.add(directory);
  await cp(fixture, directory, { recursive: true });
  return directory;
}

function fixtureChangeSetYaml() {
  return (
    'format: "morivyx.changeset/0.1"\n' +
    'id: "urn:uuid:550e8400-e29b-41d4-a716-446655440005"\n' +
    'baseRevision: "graph:stage-1-package-v1"\n' +
    'resultingRevision: "graph:stage-1-package-v2"\n' +
    `resultingRootDigest: "sha256:${"1".repeat(64)}"\n` +
    `schemaLockDigest: "sha256:${"2".repeat(64)}"\n` +
    'operations:\n  - op: "create"\n' +
    '    targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004"\n' +
    `    afterRevision: "sha256:${"3".repeat(64)}"\n` +
    'provenance:\n  method: "generated"\n' +
    '  actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001"\n' +
    '  recordedAt: "2026-07-31T05:00:00Z"\n' +
    'recordedAt: "2026-07-31T05:00:00Z"\n'
  );
}

function fixtureMigrationChangeSetYaml() {
  return (
    'format: "morivyx.changeset/0.1"\n' +
    'id: "urn:uuid:550e8400-e29b-41d4-a716-446655440012"\n' +
    'baseRevision: "graph:stage-1-package-v1"\n' +
    'resultingRevision: "graph:stage-1-migration-v1"\n' +
    `resultingRootDigest: "sha256:${"3".repeat(64)}"\n` +
    `schemaLockDigest: "sha256:${"8".repeat(64)}"\n` +
    'operations:\n  - op: "create"\n' +
    '    targetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440004"\n' +
    `    afterRevision: "sha256:${"4".repeat(64)}"\n` +
    'provenance:\n  method: "generated"\n' +
    '  actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001"\n' +
    '  recordedAt: "2026-08-03T00:00:00Z"\n' +
    'recordedAt: "2026-08-03T00:00:00Z"\n'
  );
}

function fixtureMigrationYaml() {
  return (
    'format: "morivyx.migration/0.1"\n' +
    'id: "urn:uuid:550e8400-e29b-41d4-a716-446655440014"\n' +
    'baseRevision: "graph:stage-1-package-v1"\n' +
    `sourceSchemaLockDigest: "sha256:${"7".repeat(64)}"\n` +
    `targetSchemaLockDigest: "sha256:${"8".repeat(64)}"\n` +
    `rulesDigest: "sha256:${"1".repeat(64)}"\n` +
    `mappingDigest: "sha256:${"2".repeat(64)}"\n` +
    `plannedSemanticDiffDigest: "sha256:${"5".repeat(64)}"\n` +
    'changeSetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440012"\n' +
    'resultingRevision: "graph:stage-1-migration-v1"\n' +
    `resultingRootDigest: "sha256:${"3".repeat(64)}"\n` +
    'provenance:\n  method: "generated"\n' +
    '  actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001"\n' +
    '  recordedAt: "2026-08-03T00:00:00Z"\n' +
    'recordedAt: "2026-08-03T00:00:00Z"\n'
  );
}

function fixtureTraceReport(
  id = "urn:uuid:550e8400-e29b-41d4-a716-446655440010",
) {
  return {
    format: "morivyx.trace-report/0.1",
    id,
    queryId: "governing-decision",
    graphRevision: "graph:stage-1-package-v1",
    schemaLockDigest:
      "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
    focusId: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
    evaluatedAt: "2026-08-02T00:00:00Z",
    status: "partial",
    paths: [],
    missing: ["governs"],
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, code);
    return true;
  });
}

test("canonical form normalizes keys, Unicode, and timestamps", () => {
  assert.equal(
    canonicalJson({ z: "e\u0301", a: "2026-07-28T10:12:14+09:00" }),
    '{"a":"2026-07-28T01:12:14Z","z":"é"}',
  );
  assert.equal(
    canonicalJson("2026-07-28T10:12:14.1200+09:00"),
    '"2026-07-28T01:12:14.12Z"',
  );
  assert.equal(
    canonicalJson("2026-07-28T01:12:14.000Z"),
    '"2026-07-28T01:12:14Z"',
  );
  assert.throws(
    () => canonicalJson({ "e\u0301": "first", é: "second" }),
    /NFC 正規化後に重複する項目です: é/,
  );
  assert.equal(canonicalJson("0099-01-01T00:00:00Z"), '"0099-01-01T00:00:00Z"');
  assert.throws(
    () => canonicalJson("2026-07-28T10:12:14+14:01"),
    /無効な時間帯/,
  );
  for (const value of [
    "9999-12-31T23:59:59-14:00",
    "0000-01-01T00:00:00+14:00",
  ]) {
    assert.throws(() => canonicalJson(value), /UTC変換後の年が4桁の範囲外/);
  }
  assert.equal(
    canonicalJson("9999-12-31T09:59:59-14:00"),
    '"9999-12-31T23:59:59Z"',
  );
  assert.equal(
    canonicalJson("0000-01-01T14:00:00+14:00"),
    '"0000-01-01T00:00:00Z"',
  );
});

test("canonical form rejects objects outside the logical value model", () => {
  class CustomValue {
    constructor() {
      this.value = "visible";
    }
  }

  for (const value of [
    new Date("2026-01-01T00:00:00Z"),
    new Map([["value", "hidden"]]),
    new Set(["hidden"]),
    new CustomValue(),
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /canonical form は論理値の対応表だけを受け入れます/,
    );
  }

  const nullPrototypeValue = Object.assign(Object.create(null), {
    value: "accepted",
  });
  assert.equal(canonicalJson(nullPrototypeValue), '{"value":"accepted"}');
});

test("canonical form rejects properties outside a logical mapping", () => {
  const hiddenValue = {};
  Object.defineProperty(hiddenValue, "value", {
    value: "hidden",
    enumerable: false,
  });
  let getterReads = 0;
  const accessorValue = {
    get value() {
      getterReads += 1;
      return "visible";
    },
  };

  for (const value of [
    { [Symbol("value")]: "hidden" },
    hiddenValue,
    accessorValue,
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /列挙可能な文字列data propertyだけを受け入れます/,
    );
  }
  assert.equal(getterReads, 0);

  const frozenValue = Object.freeze({ value: "accepted" });
  assert.equal(canonicalJson(frozenValue), '{"value":"accepted"}');
});

test("canonical form accepts only dense logical arrays", () => {
  const extraProperty = ["visible"];
  extraProperty.hidden = "lost";
  const symbolProperty = ["visible"];
  symbolProperty[Symbol("hidden")] = "lost";
  const hiddenIndex = [];
  Object.defineProperty(hiddenIndex, "0", {
    value: "hidden",
    enumerable: false,
  });
  hiddenIndex.length = 1;
  let getterReads = 0;
  const accessorIndex = [];
  Object.defineProperty(accessorIndex, "0", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "visible";
    },
  });
  accessorIndex.length = 1;

  for (const value of [
    Array(2),
    ["first", , "third"],
    extraProperty,
    symbolProperty,
    hiddenIndex,
    accessorIndex,
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /一覧は連続した列挙可能なdata propertyだけを受け入れます/,
    );
  }
  assert.equal(getterReads, 0);

  assert.equal(canonicalJson(Object.freeze(["accepted"])), '["accepted"]');
});

test("canonical form rejects cycles but allows shared values", () => {
  const circularObject = {};
  circularObject.self = circularObject;
  const circularArray = [];
  circularArray.push(circularArray);
  const indirectObject = { child: [] };
  indirectObject.child.push(indirectObject);

  for (const value of [circularObject, circularArray, indirectObject]) {
    assert.throws(
      () => canonicalJson(value),
      /canonical form は循環参照を受け入れません/,
    );
  }

  const shared = { value: "accepted" };
  assert.equal(
    canonicalJson([shared, shared]),
    '[{"value":"accepted"},{"value":"accepted"}]',
  );
});

test("canonical form handles deeply nested logical values iteratively", () => {
  const depth = 5_000;
  let value = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = index % 2 === 0 ? { value } : [value];
  }

  const serialized = canonicalJson(value);
  assert.match(serialized, /^\[/);
  assert.match(serialized, /"leaf"/);
  assert.equal((serialized.match(/[\[{]/g) ?? []).length, depth);

  const root = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    cursor.value = {};
    cursor = cursor.value;
  }
  cursor.value = root;
  assert.throws(() => canonicalJson(root), /循環参照/);
});

test("canonical form accepts only Unicode scalar strings", () => {
  for (const value of [
    "\ud800",
    "\udc00",
    { value: "before\ud800after" },
    { ["before\udc00after"]: "value" },
  ]) {
    assert.throws(
      () => canonicalJson(value),
      /canonical form は単独surrogateを含む文字列を受け入れません/,
    );
  }

  assert.equal(canonicalJson({ "😀": "𠮷" }), '{"😀":"𠮷"}');
});

test("digest helpers reject accessors without executing them", () => {
  let getterReads = 0;
  const accessor = () => ({
    enumerable: true,
    get() {
      getterReads += 1;
      return "changing";
    },
  });
  const revisionRecord = { value: "stable" };
  Object.defineProperty(revisionRecord, "revision", accessor());
  const revisionContent = { revision: "ignored" };
  Object.defineProperty(revisionContent, "value", accessor());
  const changeSet = { value: "stable" };
  Object.defineProperty(changeSet, "id", accessor());
  const migration = { value: "stable" };
  Object.defineProperty(migration, "id", accessor());
  const hiddenId = { value: "stable" };
  Object.defineProperty(hiddenId, "id", {
    value: "ignored",
    enumerable: false,
  });
  const rootElement = {};
  Object.defineProperty(rootElement, "id", accessor());
  Object.defineProperty(rootElement, "revision", accessor());

  for (const action of [
    () => revisionId(revisionRecord),
    () => revisionId(revisionContent),
    () => changeSetDigest(changeSet),
    () => migrationDigest(migration),
    () => changeSetDigest(hiddenId),
    () => migrationDigest({ id: "ignored", [Symbol("value")]: "hidden" }),
    () => graphRootDigest([rootElement]),
    () => revisionId(null),
    () => changeSetDigest([]),
    () => migrationDigest(new Date()),
    () => graphRootDigest([null]),
    () => graphRootDigest([new Date()]),
    () => graphRootDigest(Array(1)),
  ]) {
    assert.throws(action, TypeError);
  }
  assert.equal(getterReads, 0);

  const frozenElement = Object.freeze({ id: "element", revision: "revision" });
  assert.equal(
    graphRootDigest(Object.freeze([frozenElement])),
    graphRootDigest([{ revision: "revision", id: "element" }]),
  );
});

test("reads the Graph package validation vector", async () => {
  const result = await inspectPackage(fixture);

  assert.equal(result.valid, true);
  assert.equal(result.graphRevision, "graph:stage-1-package-v1");
  assert.equal(result.elementCount, 2);
  assert.equal(result.approvalCount, 1);
  assert.equal(result.reportCount, 0);
  assert.equal(
    result.schemaLockDigest.calculated,
    "sha256:a1ff6841d890e7a0646941f052a8c1b698820a8af05d55f828baf4c7bb9ed842",
  );
  assert.equal(
    result.rootDigest.calculated,
    "sha256:089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
  );
});

test("reads saved Reports without changing the root digest", async () => {
  const directory = await copyFixture();
  const reportsDirectory = join(directory, ".morivyx", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const first = fixtureTraceReport(
    "urn:uuid:550e8400-e29b-41d4-a716-446655440010",
  );
  const second = fixtureTraceReport(
    "urn:uuid:550e8400-e29b-41d4-a716-446655440011",
  );
  await Promise.all([
    writeFile(join(reportsDirectory, "z.yaml"), serializeReportYaml(first)),
    writeFile(join(reportsDirectory, "a.yaml"), serializeReportYaml(second)),
  ]);

  const contents = await readGraphPackage(directory);
  const inspection = await inspectPackage(directory);
  assert.deepEqual(
    contents.reports.map(({ report }) => report.id),
    [second.id, first.id],
  );
  assert.equal(inspection.reportCount, 2);
  assert.equal(
    inspection.rootDigest.calculated,
    "sha256:089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
  );
});

test("rejects an invalid saved Report during package reading", async () => {
  const directory = await copyFixture();
  const reportsDirectory = join(directory, ".morivyx", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const source = serializeReportYaml(fixtureTraceReport()).replace(
    'queryId: "governing-decision"',
    'queryId: "unknown"',
  );
  await writeFile(join(reportsDirectory, "invalid.yaml"), source);

  await expectCode(
    () => inspectPackage(directory),
    "REPORT_STRUCTURE_INVALID",
  );
});

test("requires a stable ID on a saved Report", async () => {
  const directory = await copyFixture();
  const reportsDirectory = join(directory, ".morivyx", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const report = fixtureTraceReport();
  delete report.id;
  const path = join(reportsDirectory, "derived-name.yaml");
  await writeFile(path, serializeReportYaml(report));

  await assert.rejects(
    () => inspectPackage(directory),
    (error) =>
      error instanceof PackageError &&
      error.code === "REPORT_ID_REQUIRED" &&
      error.path === `${path}#/id`,
  );
  assert.doesNotThrow(() => serializeReportYaml(report));
});

test("rejects a Report ID duplicated by a canonical record", async () => {
  const directory = await copyFixture();
  const reportsDirectory = join(directory, ".morivyx", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const duplicate = fixtureTraceReport(
    "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
  );
  await writeFile(
    join(reportsDirectory, "derived-name.yaml"),
    serializeReportYaml(duplicate),
  );

  await expectCode(() => inspectPackage(directory), "ID_DUPLICATE");
});

test("keeps approvals outside the root digest", async () => {
  const directory = await copyFixture();
  const approval = join(
    directory,
    ".morivyx",
    "approvals",
    "550e8400-e29b-41d4-a716-446655440004.yaml",
  );
  await writeFile(
    approval,
    `format: "morivyx.approval/0.1"\nid: "urn:uuid:550e8400-e29b-41d4-a716-446655440004"\nactor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001"\ntargetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440002"\ntargetRevision: "sha256:2b56691b87622570d4d69c26a56cfd3cb9e01e8c83c434c88f9d4284ba94e3c6"\noperation: "activate"\nscope: "single-revision"\napprovedAt: "2026-07-30T04:00:00Z"\nrecordedAt: "2026-07-30T04:01:00Z"\n`,
  );

  const result = await inspectPackage(directory);
  assert.equal(result.approvalCount, 2);
  assert.equal(
    result.rootDigest.calculated,
    "sha256:089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
  );
});

test("reads ChangeSets without changing the root digest", async () => {
  const directory = await copyFixture();
  const ledger = join(directory, ".morivyx", "ledger");
  await mkdir(ledger, { recursive: true });
  await writeFile(
    join(ledger, "550e8400-e29b-41d4-a716-446655440005.yaml"),
    fixtureChangeSetYaml(),
  );

  const result = await inspectPackage(directory);
  assert.equal(result.changeSetCount, 1);
  assert.equal(
    result.rootDigest.calculated,
    "sha256:089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
  );
});

test("rejects a ChangeSet filename that does not match its stable ID", async () => {
  const directory = await copyFixture();
  const ledger = join(directory, ".morivyx", "ledger");
  await mkdir(ledger, { recursive: true });
  await writeFile(
    join(ledger, "550e8400-e29b-41d4-a716-446655440099.yaml"),
    fixtureChangeSetYaml(),
  );

  await expectCode(
    () => inspectPackage(directory),
    "PACKAGE_FILENAME_ID_MISMATCH",
  );
});

test("reads a Migration and matching ChangeSet outside the root digest", async () => {
  const directory = await copyFixture();
  const ledger = join(directory, ".morivyx", "ledger");
  const migrations = join(directory, ".morivyx", "migrations");
  await Promise.all([
    mkdir(ledger, { recursive: true }),
    mkdir(migrations, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(ledger, "550e8400-e29b-41d4-a716-446655440012.yaml"),
      fixtureMigrationChangeSetYaml(),
    ),
    writeFile(
      join(migrations, "550e8400-e29b-41d4-a716-446655440014.yaml"),
      fixtureMigrationYaml(),
    ),
  ]);

  const result = await inspectPackage(directory);
  assert.equal(result.changeSetCount, 1);
  assert.equal(result.migrationCount, 1);
  assert.equal(
    result.rootDigest.calculated,
    "sha256:089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
  );
});

test("rejects a Migration whose generated ChangeSet is missing", async () => {
  const directory = await copyFixture();
  const migrations = join(directory, ".morivyx", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(
    join(migrations, "550e8400-e29b-41d4-a716-446655440014.yaml"),
    fixtureMigrationYaml(),
  );

  await expectCode(
    () => inspectPackage(directory),
    "MIGRATION_CHANGESET_MISSING",
  );
});

test("reads relations and includes them in the root digest", async () => {
  const directory = await copyFixture();
  const relationDirectory = join(directory, ".morivyx", "graph", "relations");
  await mkdir(relationDirectory, { recursive: true });
  const relation = {
    format: "morivyx.git-graph/0.1",
    kind: "relation",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
    type: "core.observes",
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: {
      source: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      predicate: "observes",
      target: "urn:uuid:550e8400-e29b-41d4-a716-446655440002",
    },
    provenance: {
      method: "asserted",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-07-30T05:00:00Z",
    },
  };
  relation.revision = revisionId(relation);
  const relationPath = join(
    relationDirectory,
    "550e8400-e29b-41d4-a716-446655440004.yaml",
  );
  const relationYaml = `format: "${relation.format}"\nkind: "${relation.kind}"\nid: "${relation.id}"\ntype: "${relation.type}"\ntypeVersion: "${relation.typeVersion}"\nrevision: "${relation.revision}"\nlifecycle: "${relation.lifecycle}"\nreviewState: "${relation.reviewState}"\nattributes:\n  predicate: "${relation.attributes.predicate}"\n  source: "${relation.attributes.source}"\n  target: "${relation.attributes.target}"\nprovenance:\n  method: "${relation.provenance.method}"\n  actor: "${relation.provenance.actor}"\n  recordedAt: "${relation.provenance.recordedAt}"\n`;
  await writeFile(relationPath, relationYaml);

  const base = await inspectPackage(fixture);
  const calculatedRoot = graphRootDigest([...base.elements, relation]);
  const revisionPath = join(directory, ".morivyx", "revision.yaml");
  const revision = await readFile(revisionPath, "utf8");
  await writeFile(
    revisionPath,
    revision.replace(base.rootDigest.recorded, calculatedRoot),
  );

  const result = await inspectPackage(directory);
  assert.equal(result.elementCount, 3);
  assert.equal(result.rootDigest.calculated, calculatedRoot);
  assert.equal(result.elements.at(-1).kind, "relation");
});

test("rejects a filename that does not match the stable ID", async () => {
  const directory = await copyFixture();
  const entityDirectory = join(directory, ".morivyx", "graph", "entities");
  await rename(
    join(entityDirectory, "550e8400-e29b-41d4-a716-446655440002.yaml"),
    join(entityDirectory, "550e8400-e29b-41d4-a716-446655440099.yaml"),
  );

  await expectCode(
    () => inspectPackage(directory),
    "PACKAGE_FILENAME_ID_MISMATCH",
  );
});

test("rejects a non-version 4 stable ID before checking its filename", async () => {
  const directory = await copyFixture();
  const entityPath = join(
    directory,
    ".morivyx",
    "graph",
    "entities",
    "550e8400-e29b-41d4-a716-446655440002.yaml",
  );
  const source = await readFile(entityPath, "utf8");
  await writeFile(
    entityPath,
    source.replace(
      'id: "urn:uuid:550e8400-e29b-41d4-a716-446655440002"',
      'id: "urn:uuid:550e8400-e29b-31d4-a716-446655440002"',
    ),
  );

  await expectCode(() => inspectPackage(directory), "GRAPH_ELEMENT_INVALID");
});

test("rejects a GraphElement stored under the wrong kind directory", async () => {
  const directory = await copyFixture();
  const graphDirectory = join(directory, ".morivyx", "graph");
  const filename = "550e8400-e29b-41d4-a716-446655440002.yaml";
  await mkdir(join(graphDirectory, "relations"), { recursive: true });
  await rename(
    join(graphDirectory, "entities", filename),
    join(graphDirectory, "relations", filename),
  );

  await expectCode(
    () => inspectPackage(directory),
    "GRAPH_ELEMENT_KIND_MISMATCH",
  );
});

test("rejects duplicate stable IDs across entities and relations", async () => {
  const directory = await copyFixture();
  const relationDirectory = join(directory, ".morivyx", "graph", "relations");
  await mkdir(relationDirectory, { recursive: true });
  const duplicate = {
    format: "morivyx.git-graph/0.1",
    kind: "relation",
    id: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
    type: "core.observes",
    typeVersion: "0.1",
    lifecycle: "active",
    reviewState: "unreviewed",
    attributes: {
      source: "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
      predicate: "observes",
      target: "urn:uuid:550e8400-e29b-41d4-a716-446655440002",
    },
    provenance: {
      method: "asserted",
      actor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
      recordedAt: "2026-07-30T05:00:00Z",
    },
  };
  duplicate.revision = revisionId(duplicate);
  await writeFile(
    join(relationDirectory, "550e8400-e29b-41d4-a716-446655440000.yaml"),
    `format: "${duplicate.format}"\nkind: "${duplicate.kind}"\nid: "${duplicate.id}"\ntype: "${duplicate.type}"\ntypeVersion: "${duplicate.typeVersion}"\nrevision: "${duplicate.revision}"\nlifecycle: "${duplicate.lifecycle}"\nreviewState: "${duplicate.reviewState}"\nattributes:\n  predicate: "${duplicate.attributes.predicate}"\n  source: "${duplicate.attributes.source}"\n  target: "${duplicate.attributes.target}"\nprovenance:\n  method: "${duplicate.provenance.method}"\n  actor: "${duplicate.provenance.actor}"\n  recordedAt: "${duplicate.provenance.recordedAt}"\n`,
  );

  await expectCode(() => inspectPackage(directory), "ID_DUPLICATE");
});

test("rejects a stable ID duplicated by an approval", async () => {
  const directory = await copyFixture();
  const path = join(
    directory,
    ".morivyx",
    "approvals",
    "550e8400-e29b-41d4-a716-446655440000.yaml",
  );
  await writeFile(
    path,
    `format: "morivyx.approval/0.1"\nid: "urn:uuid:550e8400-e29b-41d4-a716-446655440000"\nactor: "urn:uuid:550e8400-e29b-41d4-a716-446655440001"\ntargetId: "urn:uuid:550e8400-e29b-41d4-a716-446655440002"\ntargetRevision: "sha256:2b56691b87622570d4d69c26a56cfd3cb9e01e8c83c434c88f9d4284ba94e3c6"\noperation: "activate"\nscope: "single-revision"\napprovedAt: "2026-07-30T04:00:00Z"\nrecordedAt: "2026-07-30T04:01:00Z"\n`,
  );

  await expectCode(() => inspectPackage(directory), "ID_DUPLICATE");
});

test("reports aliases as invalid YAML", async () => {
  const directory = await copyFixture();
  const path = join(directory, ".morivyx", "schema.lock.yaml");
  await writeFile(
    path,
    `format: "morivyx.schema-lock/0.1"\nstableIdScheme: &scheme "urn-uuid-v4"\ndigestAlgorithm: *scheme\nschemas: []\n`,
  );

  await expectCode(
    () => inspectPackage(directory),
    "PACKAGE_AUTHORING_PROFILE_INVALID",
  );
});

test("rejects unsupported and invalid Schema lock values", async (t) => {
  await t.test("stable ID scheme", async () => {
    const directory = await copyFixture();
    const path = join(directory, ".morivyx", "schema.lock.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace("urn-uuid-v4", "other"));
    await expectCode(
      () => inspectPackage(directory),
      "STABLE_ID_SCHEME_UNSUPPORTED",
    );
  });

  await t.test("Schema entry", async () => {
    const directory = await copyFixture();
    const path = join(directory, ".morivyx", "schema.lock.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace(
        '  - schemaId: "morivyx.core"\n    version: "0.1"\n    digest:',
        "  - null\n  - digest:",
      ),
    );
    await expectCode(() => inspectPackage(directory), "PACKAGE_NULL_INVALID");
  });
});

test("rejects element, schema lock, and root digest mismatches", async (t) => {
  await t.test("element Revision ID", async () => {
    const directory = await copyFixture();
    const path = join(
      directory,
      ".morivyx",
      "graph",
      "entities",
      "550e8400-e29b-41d4-a716-446655440002.yaml",
    );
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace('"second"', '"changed"'));
    await expectCode(() => inspectPackage(directory), "REVISION_ID_MISMATCH");
  });

  await t.test("Schema lock digest", async () => {
    const directory = await copyFixture();
    const path = join(directory, ".morivyx", "schema.lock.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace('version: "0.1"', 'version: "0.2"'));
    await expectCode(
      () => inspectPackage(directory),
      "SCHEMA_LOCK_DIGEST_MISMATCH",
    );
  });

  await t.test("root digest", async () => {
    const directory = await copyFixture();
    const path = join(directory, ".morivyx", "revision.yaml");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace(
        "089d6b8fe74452ded675f333b8deac5dd500caa4b2ec8a660fab92e7f2855cb5",
        "0000000000000000000000000000000000000000000000000000000000000000",
      ),
    );
    await expectCode(() => inspectPackage(directory), "ROOT_DIGEST_MISMATCH");
  });
});

test("runs informational and inspection commands", async () => {
  const cli = join(testDirectory, "..", "src", "cli.js");
  const manifest = JSON.parse(
    await readFile(join(testDirectory, "..", "package.json"), "utf8"),
  );
  const helpEntries = [
    "inspect [path]",
    "validate [path]",
    "reindex [path]",
    "diff <base> <target>",
    "trace <path>",
    "report <file>",
    "store <package> <record.yaml>",
    "apply <base> <changeset.yaml> <revision.yaml> <output>",
    "create-decision <base> <request.yaml> <output>",
    "revise-decision <base> <request.yaml> <output>",
    "migrate <base> <migration.yaml>",
    "--help",
    "-h",
    "--version",
    "-v",
  ];
  let helpSource;
  for (const option of ["--help", "-h"]) {
    const result = spawnSync(process.execPath, [cli, option], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^使用方法:\n/);
    for (const entry of helpEntries) {
      assert.ok(result.stdout.includes(entry), `help is missing ${entry}`);
    }
    assert.equal(result.stderr, "");
    helpSource ??= result.stdout;
    assert.equal(result.stdout, helpSource);
  }
  for (const option of ["--version", "-v"]) {
    const result = spawnSync(process.execPath, [cli, option], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${manifest.version}\n`);
    assert.equal(result.stderr, "");
  }

  const invalidHelp = spawnSync(process.execPath, [cli, "--help", "extra"], {
    encoding: "utf8",
  });
  assert.equal(invalidHelp.status, 2);
  assert.equal(invalidHelp.stdout, "");
  assert.equal(invalidHelp.stderr, helpSource);

  const result = spawnSync(
    process.execPath,
    [cli, "inspect", fixture],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.elementCount, 2);
});

test("prints a coded JSON issue when command inspection fails", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(testDirectory, "..", "src", "cli.js"),
      "inspect",
      join(fixture, "missing"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, false);
  assert.equal(output.issues[0].code, "PACKAGE_FILE_MISSING");
});

test("rejects an unsafe Graph Package metadata root", async (t) => {
  await t.test("symbolic link", async () => {
    const directory = await copyFixture();
    const metadata = join(directory, ".morivyx");
    const externalMetadata = join(directory, "external-metadata");
    await rename(metadata, externalMetadata);
    await symlink(externalMetadata, metadata, "dir");

    await assert.rejects(readGraphPackage(directory), (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "PACKAGE_PATH_INVALID");
      assert.equal(error.path, metadata);
      return true;
    });
  });

  await t.test("regular file", async () => {
    const directory = await copyFixture();
    const metadata = join(directory, ".morivyx");
    await rm(metadata, { recursive: true, force: true });
    await writeFile(metadata, "not a metadata directory\n");

    await assert.rejects(readGraphPackage(directory), (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "PACKAGE_PATH_INVALID");
      assert.equal(error.path, metadata);
      return true;
    });
  });
});

test("rejects symbolic links in the Graph Package metadata tree", async () => {
  const directory = await copyFixture();
  const schemas = join(directory, ".morivyx", "schemas");
  const externalSchemas = join(directory, "external-schemas");
  await mkdir(externalSchemas);
  await symlink(externalSchemas, schemas, "dir");

  await assert.rejects(readGraphPackage(directory), (error) => {
    assert.ok(error instanceof PackageError);
    assert.equal(error.code, "PACKAGE_PATH_INVALID");
    assert.equal(error.path, schemas);
    return true;
  });
});

test("reports invalid Graph Package record groups in declared order", async (t) => {
  const recordGroups = [
    ["Entity", ["graph", "entities"]],
    ["Relation", ["graph", "relations"]],
    ["Approval", ["approvals"]],
    ["ChangeSet", ["ledger"]],
    ["Migration", ["migrations"]],
    ["Report", ["reports"]],
  ];

  for (const [index, [name]] of recordGroups.entries()) {
    await t.test(name, async () => {
      const directory = await copyFixture();
      const invalidPaths = [];

      for (const [, pathParts] of recordGroups.slice(index)) {
        const recordDirectory = join(directory, ".morivyx", ...pathParts);
        await mkdir(recordDirectory, { recursive: true });
        const invalidPath = join(recordDirectory, "zz-invalid.yaml");
        await writeFile(invalidPath, 'format: "morivyx.invalid/0.1"\n');
        invalidPaths.push(invalidPath);
      }

      await assert.rejects(readGraphPackage(directory), (error) => {
        assert.ok(error instanceof PackageError);
        assert.equal(error.path, `${invalidPaths[0]}#/format`);
        return true;
      });
    });
  }
});
