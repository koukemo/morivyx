import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateApproval,
  validateApprovalLedger,
} from "../src/approval.js";
import { PackageError } from "../src/errors.js";
import { writeApproval } from "../src/ledger-store.js";
import { readGraphPackage } from "../src/package-reader.js";
import { writeReport } from "../src/report.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "package-v1");
const approvalFixture = join(
  fixture,
  ".morivyx",
  "approvals",
  "550e8400-e29b-41d4-a716-446655440003.yaml",
);
const stableId = (suffix) =>
  `urn:uuid:550e8400-e29b-41d4-a716-${String(suffix).padStart(12, "0")}`;
const revision = (value) => `sha256:${value.repeat(64)}`;

function approval(overrides = {}) {
  return {
    format: "morivyx.approval/0.1",
    id: stableId(40),
    actor: stableId(1),
    targetId: stableId(2),
    targetRevision: revision("1"),
    operation: "approve",
    scope: "single-revision",
    approvedAt: "2026-08-03T00:00:00Z",
    recordedAt: "2026-08-03T00:01:00Z",
    ...overrides,
  };
}

function expectCode(value, path) {
  assert.throws(
    () => validateApproval(value),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.equal(error.code, "APPROVAL_INVALID");
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("accepts the package fixture, expiry, and a separate revoke record", async () => {
  const fixtureRecord = await readYamlRecord(approvalFixture);
  assert.equal(validateApproval(fixtureRecord), fixtureRecord);

  const granted = approval({ expiresAt: "2026-08-04T09:00:00+09:00" });
  assert.equal(validateApproval(granted), granted);
  const revoked = approval({
    id: stableId(41),
    operation: "revoke",
    revokes: granted.id,
  });
  assert.equal(validateApproval(revoked), revoked);
  assert.equal(validateApprovalLedger([revoked, granted])[0], revoked);
});

test("rejects malformed roots, fields, identifiers, and timestamps", () => {
  const cases = [
    [null, ""],
    [[], ""],
    [{ ...approval(), format: "morivyx.approval/1.0" }, "/format"],
    [{ ...approval(), unknown: "value" }, "/unknown"],
    [{ ...approval(), id: "invalid" }, "/id"],
    [{ ...approval(), actor: "invalid" }, "/actor"],
    [{ ...approval(), targetId: "invalid" }, "/targetId"],
    [{ ...approval(), targetRevision: "invalid" }, "/targetRevision"],
    [{ ...approval(), operation: "" }, "/operation"],
    [{ ...approval(), scope: "" }, "/scope"],
    [{ ...approval(), approvedAt: "invalid" }, "/approvedAt"],
    [
      { ...approval(), recordedAt: "2026-02-30T00:00:00Z" },
      "/recordedAt",
    ],
    [{ ...approval(), expiresAt: "2026-08-03" }, "/expiresAt"],
    [
      { ...approval(), expiresAt: "2026-08-03T00:00:00+14:01" },
      "/expiresAt",
    ],
    [
      { ...approval(), expiresAt: "9999-12-31T23:59:59-14:00" },
      "/expiresAt",
    ],
  ];
  for (const [record, path] of cases) {
    expectCode(record, path);
  }
});

test("requires revokes only for a valid separate revoke target", () => {
  expectCode(approval({ operation: "revoke" }), "/revokes");
  expectCode(
    approval({ operation: "revoke", revokes: "invalid" }),
    "/revokes",
  );
  const self = approval({ operation: "revoke" });
  self.revokes = self.id;
  expectCode(self, "/revokes");
  expectCode(approval({ revokes: stableId(41) }), "/revokes");
});

test("includes the source file before an approval JSON Pointer", () => {
  const path = "/package/.morivyx/approvals/record.yaml";
  assert.throws(
    () => validateApproval({ ...approval(), actor: "invalid" }, path),
    (error) =>
      error.code === "APPROVAL_INVALID" && error.path === `${path}#/actor`,
  );
});

test("rejects an invalid approval ledger reference", async (t) => {
  const granted = approval();
  const revoke = (overrides = {}) =>
    approval({
      id: stableId(41),
      operation: "revoke",
      revokes: granted.id,
      ...overrides,
    });

  await t.test("unknown target", () => {
    assert.throws(
      () =>
        validateApprovalLedger([
          revoke({ revokes: stableId(99) }),
          granted,
        ]),
      (error) =>
        error.code === "APPROVAL_INVALID" &&
        error.path === "/approvals/0/revokes",
    );
  });

  await t.test("revoke target", () => {
    const firstRevoke = revoke();
    const secondRevoke = revoke({
      id: stableId(42),
      revokes: firstRevoke.id,
    });
    assert.throws(
      () => validateApprovalLedger([granted, firstRevoke, secondRevoke]),
      (error) =>
        error.code === "APPROVAL_INVALID" &&
        error.path === "/approvals/2/revokes",
    );
  });

  for (const [name, overrides] of [
    ["target ID", { targetId: stableId(3) }],
    ["target Revision", { targetRevision: revision("2") }],
  ]) {
    await t.test(name, () => {
      assert.throws(
        () => validateApprovalLedger([granted, revoke(overrides)]),
        (error) =>
          error.code === "APPROVAL_INVALID" &&
          error.path === "/approvals/1/revokes",
      );
    });
  }

  await t.test("duplicate approval ID", () => {
    assert.throws(
      () => validateApprovalLedger([granted, structuredClone(granted)]),
      (error) =>
        error.code === "APPROVAL_INVALID" && error.path === "/approvals/1/id",
    );
  });

  await t.test("malformed approval index", () => {
    assert.throws(
      () => validateApprovalLedger([{ ...granted, actor: "invalid" }]),
      (error) =>
        error.code === "APPROVAL_INVALID" &&
        error.path === "/approvals/0/actor",
    );
  });

  await t.test("file path", () => {
    const path = "/package/approvals/revoke.yaml";
    assert.throws(
      () => validateApprovalLedger([revoke({ revokes: stableId(99) })], [path]),
      (error) =>
        error.code === "APPROVAL_INVALID" &&
        error.path === `${path}#/revokes`,
    );
  });

  await t.test("ledger and file path inputs", () => {
    assert.throws(
      () => validateApprovalLedger(null),
      (error) =>
        error.code === "APPROVAL_INVALID" && error.path === "/approvals",
    );
    assert.throws(
      () => validateApprovalLedger([granted], ["one", "two"]),
      (error) =>
        error.code === "APPROVAL_INVALID" && error.path === "/filePaths",
    );
  });
});

test("rejects an invalid approval while reading a package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const path = join(
    directory,
    ".morivyx",
    "approvals",
    "550e8400-e29b-41d4-a716-000000000040.yaml",
  );
  await writeFile(
    path,
    serializeYamlRecord(approval({ targetRevision: "invalid" })),
    "utf8",
  );

  await assert.rejects(
    readGraphPackage(directory),
    (error) =>
      error.code === "APPROVAL_INVALID" &&
      error.path === `${path}#/targetRevision`,
  );
});

test("rejects an unresolved approval revocation while reading a package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const path = join(
    directory,
    ".morivyx",
    "approvals",
    "550e8400-e29b-41d4-a716-000000000040.yaml",
  );
  await writeFile(
    path,
    serializeYamlRecord(
      approval({ operation: "revoke", revokes: stableId(99) }),
    ),
    "utf8",
  );

  await assert.rejects(
    readGraphPackage(directory),
    (error) =>
      error.code === "APPROVAL_INVALID" && error.path === `${path}#/revokes`,
  );
});

test("stores approvals append-only after checking the existing ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });

  const granted = approval();
  const grantResult = await writeApproval(directory, granted);
  assert.equal(grantResult.valid, true);
  assert.equal(
    (await readYamlRecord(grantResult.path)).id,
    granted.id,
  );

  const revoked = approval({
    id: stableId(41),
    operation: "revoke",
    revokes: granted.id,
  });
  const revokeResult = await writeApproval(join(directory, ".morivyx"), revoked);
  assert.equal((await readYamlRecord(revokeResult.path)).revokes, granted.id);
  assert.equal((await readGraphPackage(directory)).approvals.length, 3);

  await assert.rejects(
    writeApproval(directory, revoked),
    (error) =>
      error.code === "APPROVAL_ALREADY_EXISTS" &&
      error.path === revokeResult.path,
  );
});

test("does not store an invalid or colliding approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-reject-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });

  const unresolved = approval({
    operation: "revoke",
    revokes: stableId(99),
  });
  await assert.rejects(
    writeApproval(directory, unresolved),
    (error) =>
      error.code === "APPROVAL_INVALID" &&
      error.path.endsWith("#/revokes"),
  );

  const packageContents = await readGraphPackage(directory);
  const colliding = approval({ id: packageContents.elements[0].id });
  await assert.rejects(
    writeApproval(directory, colliding),
    (error) => error.code === "ID_DUPLICATE",
  );

  const approvalsDirectory = join(directory, ".morivyx", "approvals");
  assert.deepEqual(
    (await readdir(approvalsDirectory)).filter((name) =>
      name.startsWith(".record-"),
    ),
    [],
  );
});

test("rejects an Approval ID already used by a saved Report", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-approval-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  const report = {
    format: "morivyx.semantic-diff/0.1",
    id: stableId(40),
    baseRevision: "graph:stage-1-package-v1",
    targetRevision: "graph:stage-1-package-v1",
    schemaLockDigest: revision("1"),
    evaluatedAt: "2026-08-31T02:30:00Z",
    entries: [],
  };
  const savedReport = await writeReport(directory, report);
  await rename(
    savedReport.path,
    join(dirname(savedReport.path), "arbitrary-name.yaml"),
  );

  await assert.rejects(
    writeApproval(directory, approval({ id: report.id })),
    (error) => error.code === "ID_DUPLICATE",
  );
  const packageContents = await readGraphPackage(directory);
  assert.equal(packageContents.reports.length, 1);
  assert.equal(packageContents.approvals.length, 1);
});
