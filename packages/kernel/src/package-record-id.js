import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { compareUnicode } from "./canonical.js";
import { PackageError } from "./errors.js";
import { readYamlRecord } from "./yaml-reader.js";

const PACKAGE_RECORD_LOCATIONS = [
  ["graph-element", ["graph", "entities"]],
  ["graph-element", ["graph", "relations"]],
  ["approval", ["approvals"]],
  ["change-set", ["ledger"]],
  ["migration", ["migrations"]],
  ["report", ["reports"]],
];
const LOCK_ATTEMPTS = 200;
const LOCK_DELAY_MS = 5;

function waitForLock() {
  return new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS));
}

async function acquireRecordIdLock(directory, id) {
  const lockPath = join(
    directory,
    `.record-id-${id.slice("urn:uuid:".length)}.lock`,
  );
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await waitForLock();
    }
  }
  throw new PackageError(
    "PACKAGE_RECORD_BUSY",
    lockPath,
    "同じstable IDのPackage記録を別の処理が保存中です。",
  );
}

export async function withPackageRecordIdLock(directory, id, action) {
  const release = await acquireRecordIdLock(directory, id);
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function ensurePackageRecordDirectory(directory) {
  try {
    await mkdir(directory);
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const information = await lstat(directory);
  if (!information.isDirectory()) {
    throw new PackageError(
      "PACKAGE_RECORD_OUTPUT_INVALID",
      directory,
      "Package記録の保存先はsymbolic linkではないディレクトリにします。",
    );
  }
}

function packageRecords(packageContents) {
  return [
    ["graph-element", packageContents.elements],
    ["approval", packageContents.approvals],
    ["change-set", packageContents.changeSets],
    ["migration", packageContents.migrations],
    [
      "report",
      packageContents.reports.map(({ report }) => report),
    ],
  ];
}

async function yamlRecords(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => join(directory, entry.name))
    .sort(compareUnicode);
  const records = [];
  for (const path of paths) {
    records.push(await readYamlRecord(path));
  }
  return records;
}

async function storedPackageRecords(directory) {
  const records = [];
  for (const [recordType, pathParts] of PACKAGE_RECORD_LOCATIONS) {
    records.push([
      recordType,
      await yamlRecords(join(directory, ...pathParts)),
    ]);
  }
  return records;
}

export async function assertPackageRecordIdAvailable({
  directory,
  packageContents,
  recordType,
  id,
  targetPath,
  alreadyExistsCode,
  alreadyExistsMessage,
}) {
  const records = packageContents
    ? packageRecords(packageContents)
    : await storedPackageRecords(directory);
  const existing = records.find(([, candidates]) =>
    candidates.some((record) => record.id === id),
  );
  if (!existing) {
    return;
  }
  const [existingRecordType] = existing;
  throw new PackageError(
    existingRecordType === recordType ? alreadyExistsCode : "ID_DUPLICATE",
    targetPath,
    existingRecordType === recordType
      ? alreadyExistsMessage
      : "別種のPackage記録が同じstable IDを使用しています。",
  );
}
