#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareUnicode } from "./canonical.js";
import { writeCreatedDecisionPackage } from "./decision-creation.js";
import { writeRevisedDecisionPackage } from "./decision-revision.js";
import { inspectPackage, PackageError } from "./package-reader.js";
import { rebuildPackageIndex } from "./graph-index.js";
import {
  writeApproval,
  writeChangeSet,
  writeMigration,
} from "./ledger-store.js";
import {
  writeAppliedPackage,
  writeMigratedPackage,
} from "./package-writer.js";
import { readReport, validateReport, writeReport } from "./report.js";
import { diffPackages } from "./semantic-diff.js";
import { tracePackage } from "./trace-query.js";
import { validatePackage } from "./validator.js";
import { readYamlRecord } from "./yaml-reader.js";

const [command, ...arguments_] = process.argv.slice(2);
const commands = new Set([
  "inspect",
  "validate",
  "diff",
  "trace",
  "report",
  "reindex",
  "store",
  "apply",
  "create-decision",
  "revise-decision",
  "migrate",
]);
const usage =
  [
    "使用方法:",
    "  morivyx inspect [path]",
    "  morivyx validate [path]",
    "  morivyx reindex [path]",
    "  morivyx diff <base> <target> --evaluated-at <time> [--id <id> [--save]]",
    "  morivyx trace <path> --query <id> --focus <id> --evaluated-at <time> [--id <id> [--save]]",
    "  morivyx report <file>",
    "  morivyx store <package> <record.yaml>",
    "  morivyx apply <base> <changeset.yaml> <revision.yaml> <output> [--candidates <directory>]",
    "  morivyx create-decision <base> <request.yaml> <output>",
    "  morivyx revise-decision <base> <request.yaml> <output>",
    "  morivyx migrate <base> <migration.yaml> <changeset.yaml> <diff.yaml> <revision.yaml> <output> --target-schema <directory> [--candidates <directory>]",
    "  morivyx --help",
    "  morivyx -h",
    "  morivyx --version",
    "  morivyx -v",
  ].join("\n") + "\n";
function validOptions(start, requiredValueOptions, optionalValueOptions, flags) {
  const required = new Set(requiredValueOptions);
  const valueOptions = new Set([
    ...requiredValueOptions,
    ...optionalValueOptions,
  ]);
  const flagOptions = new Set(flags);
  const seen = new Set();
  for (let index = start; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.has(option)) {
      if (seen.has(option)) {
        return false;
      }
      seen.add(option);
      continue;
    }
    if (!valueOptions.has(option) || seen.has(option)) {
      return false;
    }
    const value = arguments_[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      return false;
    }
    seen.add(option);
    index += 1;
  }
  return [...required].every((option) => seen.has(option));
}

function optionValue(option) {
  const index = arguments_.indexOf(option);
  return index === -1 ? undefined : arguments_[index + 1];
}

const evaluatedAt = optionValue("--evaluated-at");
const queryId = optionValue("--query");
const focusId = optionValue("--focus");
const reportId = optionValue("--id");
const candidateDirectory = optionValue("--candidates");
const targetSchemaDirectory = optionValue("--target-schema");
const saveRequested = arguments_.includes("--save");
const simpleCommands = new Set(["inspect", "validate", "reindex"]);
const simpleArgumentsValid =
  !simpleCommands.has(command) ||
  (arguments_.length <= 1 && !arguments_[0]?.startsWith("--"));
const diffArgumentsValid =
  command !== "diff" ||
  (typeof arguments_[0] === "string" &&
    !arguments_[0].startsWith("--") &&
    typeof arguments_[1] === "string" &&
    !arguments_[1].startsWith("--") &&
    validOptions(2, ["--evaluated-at"], ["--id"], ["--save"]) &&
    (!saveRequested || reportId !== undefined));
const traceArgumentsValid =
  command !== "trace" ||
  (typeof arguments_[0] === "string" &&
    !arguments_[0].startsWith("--") &&
    validOptions(
      1,
      ["--query", "--focus", "--evaluated-at"],
      ["--id"],
      ["--save"],
    ) &&
    (!saveRequested || reportId !== undefined));
const reportArgumentsValid =
  command !== "report" ||
  (arguments_.length === 1 &&
    typeof arguments_[0] === "string" &&
    !arguments_[0].startsWith("--"));
const storeArgumentsValid =
  command !== "store" ||
  (arguments_.length === 2 &&
    arguments_.every(
      (argument) =>
        typeof argument === "string" && !argument.startsWith("--"),
    ));
const applyArgumentsValid =
  command !== "apply" ||
  (arguments_.slice(0, 4).length === 4 &&
    arguments_
      .slice(0, 4)
      .every(
        (argument) =>
          typeof argument === "string" && !argument.startsWith("--"),
      ) &&
    validOptions(4, [], ["--candidates"], []));
const createDecisionArgumentsValid =
  command !== "create-decision" ||
  (arguments_.length === 3 &&
    arguments_.every(
      (argument) =>
        typeof argument === "string" && !argument.startsWith("--"),
    ));
const reviseDecisionArgumentsValid =
  command !== "revise-decision" ||
  (arguments_.length === 3 &&
    arguments_.every(
      (argument) =>
        typeof argument === "string" && !argument.startsWith("--"),
    ));
const migrateArgumentsValid =
  command !== "migrate" ||
  (arguments_.slice(0, 6).length === 6 &&
    arguments_
      .slice(0, 6)
      .every(
        (argument) =>
          typeof argument === "string" && !argument.startsWith("--"),
      ) &&
    validOptions(6, ["--target-schema"], ["--candidates"], []));

async function readDirectoryEntries(path, invalidCode, name) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PackageError(
        "PACKAGE_FILE_MISSING",
        path,
        `${name} directoryがありません。`,
      );
    }
    if (error?.code === "ENOTDIR") {
      throw new PackageError(
        invalidCode,
        path,
        `${name}にはdirectoryを指定します。`,
      );
    }
    throw error;
  }
}

async function readYamlDirectory(path, invalidCode, name) {
  const entries = await readDirectoryEntries(path, invalidCode, name);
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => join(path, entry.name))
    .sort(compareUnicode);
  const records = [];
  for (const candidatePath of paths) {
    records.push(await readYamlRecord(candidatePath));
  }
  return records;
}

async function readCandidateElements(path) {
  return path === undefined
    ? []
    : readYamlDirectory(
        path,
        "PACKAGE_CANDIDATE_DIRECTORY_INVALID",
        "candidates",
      );
}

async function readTargetSchemaBundle(path) {
  await readDirectoryEntries(
    path,
    "PACKAGE_TARGET_SCHEMA_DIRECTORY_INVALID",
    "target schema",
  );
  const targetSchemaLock = await readYamlRecord(
    join(path, "schema.lock.yaml"),
  );
  const targetSchemaDefinitions = await readYamlDirectory(
    join(path, "schemas"),
    "PACKAGE_TARGET_SCHEMA_DIRECTORY_INVALID",
    "target schemas",
  );
  return { targetSchemaLock, targetSchemaDefinitions };
}

async function finalizeGeneratedReport(result, path) {
  validateReport(result.report);
  if (!saveRequested) {
    return result;
  }
  const saved = await writeReport(path, result.report);
  if (saved.digest !== result.digest) {
    throw new PackageError(
      "REPORT_DIGEST_MISMATCH",
      saved.path,
      "生成時と保存時のReport digestが一致しません。",
    );
  }
  return { ...result, savedPath: saved.path };
}

async function runCommand() {
  if (command === "create-decision") {
    const request = await readYamlRecord(arguments_[1]);
    return writeCreatedDecisionPackage({
      basePath: arguments_[0],
      request,
      requestPath: arguments_[1],
      outputPath: arguments_[2],
    });
  }
  if (command === "revise-decision") {
    const request = await readYamlRecord(arguments_[1]);
    return writeRevisedDecisionPackage({
      basePath: arguments_[0],
      request,
      requestPath: arguments_[1],
      outputPath: arguments_[2],
    });
  }
  if (command === "migrate") {
    const migration = await readYamlRecord(arguments_[1]);
    const changeSet = await readYamlRecord(arguments_[2]);
    const plannedSemanticDiff = await readYamlRecord(arguments_[3]);
    const resultingRevision = await readYamlRecord(arguments_[4]);
    const candidateElements = await readCandidateElements(candidateDirectory);
    const targetSchemaBundle = await readTargetSchemaBundle(
      targetSchemaDirectory,
    );
    return writeMigratedPackage({
      basePath: arguments_[0],
      outputPath: arguments_[5],
      migration,
      changeSet,
      plannedSemanticDiff,
      candidateElements,
      resultingRevision,
      ...targetSchemaBundle,
    });
  }
  if (command === "apply") {
    const changeSet = await readYamlRecord(arguments_[1]);
    const resultingRevision = await readYamlRecord(arguments_[2]);
    const candidateElements = await readCandidateElements(candidateDirectory);
    return writeAppliedPackage({
      basePath: arguments_[0],
      outputPath: arguments_[3],
      changeSet,
      candidateElements,
      resultingRevision,
    });
  }
  if (command === "diff") {
    const result = await diffPackages(arguments_[0], arguments_[1], {
      evaluatedAt,
      id: reportId,
    });
    return finalizeGeneratedReport(result, arguments_[1]);
  }
  if (command === "trace") {
    const result = await tracePackage(arguments_[0], {
      queryId,
      focusId,
      evaluatedAt,
      id: reportId,
    });
    return finalizeGeneratedReport(result, arguments_[0]);
  }
  if (command === "report") {
    return readReport(arguments_[0]);
  }
  if (command === "store") {
    const record = await readYamlRecord(arguments_[1]);
    let result;
    if (record.format === "morivyx.approval/0.1") {
      result = await writeApproval(arguments_[0], record);
    } else if (record.format === "morivyx.changeset/0.1") {
      result = await writeChangeSet(arguments_[0], record);
    } else if (record.format === "morivyx.migration/0.1") {
      result = await writeMigration(arguments_[0], record);
    } else {
      throw new PackageError(
        "PACKAGE_FORMAT_UNSUPPORTED",
        `${arguments_[1]}#/format`,
        `storeに対応していない記録形式です: ${String(record.format)}`,
      );
    }
    return { ...result, format: record.format, id: record.id };
  }
  const path = arguments_[0] ?? process.cwd();
  if (command === "inspect") {
    return inspectPackage(path);
  }
  return command === "reindex" ? rebuildPackageIndex(path) : validatePackage(path);
}

if (["--help", "-h"].includes(command) && arguments_.length === 0) {
  process.stdout.write(usage);
} else if (["--version", "-v"].includes(command) && arguments_.length === 0) {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  process.stdout.write(`${manifest.version}\n`);
} else if (
  !commands.has(command) ||
  !simpleArgumentsValid ||
  !diffArgumentsValid ||
  !traceArgumentsValid ||
  !reportArgumentsValid ||
  !storeArgumentsValid ||
  !applyArgumentsValid ||
  !createDecisionArgumentsValid ||
  !reviseDecisionArgumentsValid ||
  !migrateArgumentsValid
) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  try {
    const result = await runCommand();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === "validate" && !result.valid) {
      process.exitCode = 1;
    }
  } catch (error) {
    const issue =
      error instanceof PackageError
        ? error.toIssue()
        : {
            code: "INTERNAL_ERROR",
            path: arguments_[0] ?? process.cwd(),
            message: error instanceof Error ? error.message : String(error),
          };
    process.stdout.write(
      `${JSON.stringify({ valid: false, issues: [issue] }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
