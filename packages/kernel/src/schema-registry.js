import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareUnicode, schemaDefinitionDigest } from "./canonical.js";
import { PackageError } from "./errors.js";
import { validateSchemaDefinition } from "./schema-definition.js";
import { readYamlRecord } from "./yaml-reader.js";

const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

function schemaKey(schemaId, version) {
  return `${schemaId}@${version}`;
}

function issue(code, path) {
  return {
    code,
    phase: 2,
    elementId: "",
    path,
    relatedId: "",
  };
}

async function unlockedSchemaIssues(directory, schemaLock) {
  let entries;
  try {
    entries = await readdir(join(directory, "schemas"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lockedFilenames = new Set(
    schemaLock.schemas.map(
      ({ schemaId, version }) => `${schemaKey(schemaId, version)}.yaml`,
    ),
  );
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".yaml") &&
        !lockedFilenames.has(entry.name),
    )
    .map(({ name }) => name)
    .sort(compareUnicode)
    .map((name) =>
      issue("SCHEMA_LOCK_CONFLICT", `/schemas/${name.replaceAll("~", "~0")}`),
    );
}

export async function resolveSchemaRegistry(directory, schemaLock) {
  const schemas = new Map();
  const issues = await unlockedSchemaIssues(directory, schemaLock);

  for (const locked of schemaLock.schemas) {
    const key = schemaKey(locked.schemaId, locked.version);
    const issuePath = `/schemas/${key}`;
    if (
      !SCHEMA_ID_PATTERN.test(locked.schemaId) ||
      !VERSION_PATTERN.test(locked.version)
    ) {
      issues.push(issue("SCHEMA_LOCK_CONFLICT", issuePath));
      continue;
    }

    const path = join(directory, "schemas", `${key}.yaml`);
    let definition;
    try {
      definition = await readYamlRecord(path);
    } catch (error) {
      issues.push(
        issue(
          error instanceof PackageError && error.code === "PACKAGE_FILE_MISSING"
            ? "SCHEMA_LOCK_MISSING"
            : "SCHEMA_LOCK_CONFLICT",
          issuePath,
        ),
      );
      continue;
    }

    try {
      validateSchemaDefinition(definition, path);
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      issues.push(issue("SCHEMA_LOCK_CONFLICT", issuePath));
      continue;
    }

    if (
      definition.schemaId !== locked.schemaId ||
      definition.version !== locked.version ||
      schemaDefinitionDigest(definition) !== locked.digest
    ) {
      issues.push(issue("SCHEMA_LOCK_CONFLICT", issuePath));
      continue;
    }

    schemas.set(key, definition);
  }

  return { schemas, issues };
}

export { schemaKey };
