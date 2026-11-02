import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical.js";
import { PackageError } from "./errors.js";
import {
  PLUGIN_RUN_REQUEST_FORMAT,
  PLUGIN_RUN_RESULT_FORMAT,
  validatePluginRunRequest,
  validatePluginRunResult,
} from "./plugin-communication.js";

export const REPOSITORY_IMPORTER_PLUGIN_ID = "morivyx.repository-importer.dev";
export const REPOSITORY_IMPORTER_PLUGIN_VERSION = "0.1.0";
export const REPOSITORY_IMPORT_CAPABILITY_ID = "repository.read-file";
export const REPOSITORY_IMPORT_COMPARISON_FORMAT =
  "morivyx.repository-import-comparison/0.1";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isText(value) {
  return typeof value === "string" && value.length > 0;
}

function isLogicalRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function assertInputKeys(input) {
  for (const key of Object.keys(input)) {
    if (!["repositoryRoot", "externalId", "locator"].includes(key)) {
      throw new PackageError(
        "REPOSITORY_IMPORT_REQUEST_INVALID",
        `/input/${key}`,
        `未定義のrepository Importer入力です: ${key}`,
      );
    }
  }
}

function validateRepositoryInput(request) {
  validatePluginRunRequest(request);
  if (
    request.plugin.id !== REPOSITORY_IMPORTER_PLUGIN_ID ||
    request.plugin.version !== REPOSITORY_IMPORTER_PLUGIN_VERSION ||
    request.capability.id !== REPOSITORY_IMPORT_CAPABILITY_ID ||
    request.capability.effect !== "read-only"
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_REQUEST_INVALID",
      "/",
      "repository ImporterのPluginまたはCapabilityが一致しません。",
    );
  }
  const input = request.input;
  assertInputKeys(input);
  if (
    !isText(input.repositoryRoot) ||
    !isText(input.externalId) ||
    !isText(input.locator)
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_REQUEST_INVALID",
      "/input",
      "repositoryRoot、externalId、locatorは空でない文字列でなければなりません。",
    );
  }
  if (
    isAbsolute(input.locator) ||
    input.locator.includes("\\") ||
    input.locator
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_LOCATOR_INVALID",
      "/input/locator",
      "locatorはrepository内の相対POSIX pathでなければなりません。",
    );
  }
}

export function validateRepositoryImportRequest(request) {
  validateRepositoryInput(request);
  return request;
}

function safeRunId(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return "invalid-run";
  }
  const descriptor = Object.getOwnPropertyDescriptor(request, "runId");
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, "value") ||
    !isText(descriptor.value)
  ) {
    return "invalid-run";
  }
  return descriptor.value;
}

function failureResult(request, error) {
  return {
    format: PLUGIN_RUN_RESULT_FORMAT,
    runId: safeRunId(request),
    plugin: {
      id: REPOSITORY_IMPORTER_PLUGIN_ID,
      version: REPOSITORY_IMPORTER_PLUGIN_VERSION,
    },
    capabilityId: REPOSITORY_IMPORT_CAPABILITY_ID,
    status: "failure",
    failure: {
      code:
        error instanceof PackageError
          ? error.code
          : "REPOSITORY_IMPORT_FAILED",
      message:
        error instanceof PackageError
          ? error.message
          : "repositoryを読み取れませんでした。",
    },
  };
}

function isNodeErrorCode(error, code) {
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    error.code === code
  );
}

function targetMissingError() {
  return new PackageError(
    "REPOSITORY_IMPORT_TARGET_MISSING",
    "/input/locator",
    "repository内の対象が存在しません。",
  );
}

function sourceUnavailableError() {
  return new PackageError(
    "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE",
    "/input/repositoryRoot",
    "repositoryの読取元を利用できません。",
  );
}

function validateRepositoryResultIdentity(result) {
  if (
    result.plugin.id !== REPOSITORY_IMPORTER_PLUGIN_ID ||
    result.plugin.version !== REPOSITORY_IMPORTER_PLUGIN_VERSION ||
    result.capabilityId !== REPOSITORY_IMPORT_CAPABILITY_ID
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_RESULT_INVALID",
      "/",
      "repository取込結果のPluginまたはCapabilityが一致しません。",
    );
  }
}

export function validateRepositoryImportResult(result, request = null) {
  validatePluginRunResult(result, request);
  validateRepositoryResultIdentity(result);
  if (result.status !== "success") {
    return result;
  }
  const output = result.output;
  const keys = Object.keys(output);
  const allowed = new Set([
    "kind",
    "externalIdentity",
    "locator",
    "digest",
    "digestRule",
    "retrievedAt",
  ]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new PackageError(
      "REPOSITORY_IMPORT_RESULT_INVALID",
      "/output",
      "repository取込結果に未定義の項目があります。",
    );
  }
  if (
    output.kind !== "repository-file-snapshot" ||
    output.externalIdentity === null ||
    typeof output.externalIdentity !== "object" ||
    Array.isArray(output.externalIdentity) ||
    output.externalIdentity.system !== "repository" ||
    !isText(output.externalIdentity.externalId) ||
    Object.keys(output.externalIdentity).some(
      (key) => !["system", "externalId"].includes(key),
    ) ||
    !isText(output.locator) ||
    !isText(output.digest) ||
    !DIGEST_PATTERN.test(output.digest) ||
    output.digestRule !== "sha256-bytes" ||
    !isText(output.retrievedAt) ||
    !TIMESTAMP_PATTERN.test(output.retrievedAt)
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_RESULT_INVALID",
      "/output",
      "repository取込結果の外部同一性、読取位置、digest、取得時刻が不正です。",
    );
  }
  if (
    request !== null &&
    (output.externalIdentity.externalId !== request.input.externalId ||
      output.locator !== request.input.locator)
  ) {
    throw new PackageError(
      "REPOSITORY_IMPORT_RESULT_MISMATCH",
      "/output",
      "repository取込結果の外部同一性または読取位置がRunRequestと一致しません。",
    );
  }
  return result;
}

function snapshotDescriptor(result) {
  return {
    digest: result.output.digest,
    digestRule: result.output.digestRule,
    retrievedAt: result.output.retrievedAt,
  };
}

function comparisonReport({
  previousResult = null,
  currentResult = null,
  status,
  issues,
}) {
  const previous =
    previousResult?.status === "success" ? snapshotDescriptor(previousResult) : null;
  let current = null;
  if (currentResult?.status === "success") {
    current = { status: "resolved", ...snapshotDescriptor(currentResult) };
  } else if (currentResult?.status === "failure") {
    current = {
      status:
        currentResult.failure.code === "REPOSITORY_IMPORT_TARGET_MISSING"
          ? "missing"
          : currentResult.failure.code === "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE" ||
              currentResult.failure.code === "REPOSITORY_IMPORT_FAILED"
            ? "unavailable"
            : "invalid",
      failureCode: currentResult.failure.code,
    };
  }
  return {
    format: REPOSITORY_IMPORT_COMPARISON_FORMAT,
    externalIdentity:
      previousResult?.status === "success"
        ? { ...previousResult.output.externalIdentity }
        : null,
    locator:
      previousResult?.status === "success" ? previousResult.output.locator : null,
    previous,
    current,
    status,
    issues: issues.map((code) => ({ code })),
  };
}

export function compareRepositoryImportSnapshots(input) {
  if (!isLogicalRecord(input)) {
    return comparisonReport({
      status: "invalid",
      issues: ["REPOSITORY_REIMPORT_INPUT_INVALID"],
    });
  }
  const { previousResult, currentRequest, currentResult } = input;
  try {
    validateRepositoryImportResult(previousResult);
    if (previousResult.status !== "success") {
      return comparisonReport({
        status: "invalid",
        issues: ["REPOSITORY_REIMPORT_PREVIOUS_INVALID"],
      });
    }
    validateRepositoryInput(currentRequest);
    validateRepositoryImportResult(currentResult, currentRequest);
  } catch {
    return comparisonReport({
      status: "invalid",
      issues: ["REPOSITORY_REIMPORT_INPUT_INVALID"],
    });
  }

  if (
    previousResult.output.externalIdentity.externalId !==
      currentRequest.input.externalId ||
    previousResult.output.locator !== currentRequest.input.locator
  ) {
    return comparisonReport({
      previousResult,
      currentResult,
      status: "invalid",
      issues: ["REPOSITORY_REIMPORT_IDENTITY_MISMATCH"],
    });
  }

  if (currentResult.status === "failure") {
    if (currentResult.failure.code === "REPOSITORY_IMPORT_TARGET_MISSING") {
      return comparisonReport({
        previousResult,
        currentResult,
        status: "missing",
        issues: ["REPOSITORY_REIMPORT_TARGET_MISSING"],
      });
    }
    if (
      currentResult.failure.code === "REPOSITORY_IMPORT_SOURCE_UNAVAILABLE" ||
      currentResult.failure.code === "REPOSITORY_IMPORT_FAILED"
    ) {
      return comparisonReport({
        previousResult,
        currentResult,
        status: "unavailable",
        issues: ["REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE"],
      });
    }
    return comparisonReport({
      previousResult,
      currentResult,
      status: "invalid",
      issues: ["REPOSITORY_REIMPORT_CURRENT_INVALID"],
    });
  }

  if (currentResult.output.digest !== previousResult.output.digest) {
    return comparisonReport({
      previousResult,
      currentResult,
      status: "stale",
      issues: ["REPOSITORY_REIMPORT_DIGEST_CHANGED"],
    });
  }
  return comparisonReport({
    previousResult,
    currentResult,
    status: "current",
    issues: [],
  });
}

export async function importRepositoryFile(
  request,
  { now = () => new Date().toISOString() } = {},
) {
  let inputRequest = request;
  try {
    validateRepositoryInput(request);
    inputRequest = structuredClone(request);
    let root;
    try {
      root = await realpath(inputRequest.input.repositoryRoot);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw sourceUnavailableError();
      }
      throw error;
    }
    const requestedPath = resolve(root, ...inputRequest.input.locator.split("/"));
    let target;
    try {
      target = await realpath(requestedPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw targetMissingError();
      }
      throw error;
    }
    const relation = relative(root, target);
    if (
      relation === "" ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    ) {
      throw new PackageError(
        "REPOSITORY_IMPORT_OUTSIDE_ROOT",
        "/input/locator",
        "locatorがrepositoryの外部を参照しています。",
      );
    }
    let content;
    try {
      content = await readFile(target);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw targetMissingError();
      }
      throw error;
    }
    const result = {
      format: PLUGIN_RUN_RESULT_FORMAT,
      runId: inputRequest.runId,
      plugin: {
        id: REPOSITORY_IMPORTER_PLUGIN_ID,
        version: REPOSITORY_IMPORTER_PLUGIN_VERSION,
      },
      capabilityId: REPOSITORY_IMPORT_CAPABILITY_ID,
      status: "success",
      output: {
        kind: "repository-file-snapshot",
        externalIdentity: {
          system: "repository",
          externalId: inputRequest.input.externalId,
        },
        locator: inputRequest.input.locator,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        digestRule: "sha256-bytes",
        retrievedAt: now(),
      },
    };
    return validateRepositoryImportResult(result, inputRequest);
  } catch (error) {
    return failureResult(inputRequest, error);
  }
}

export function repositoryImportRequest({
  runId,
  repositoryRoot,
  externalId,
  locator,
}) {
  return {
    format: PLUGIN_RUN_REQUEST_FORMAT,
    runId,
    plugin: {
      id: REPOSITORY_IMPORTER_PLUGIN_ID,
      version: REPOSITORY_IMPORTER_PLUGIN_VERSION,
    },
    capability: {
      id: REPOSITORY_IMPORT_CAPABILITY_ID,
      effect: "read-only",
    },
    input: {
      repositoryRoot,
      externalId,
      locator,
    },
  };
}
