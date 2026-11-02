import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { PackageError } from "./errors.js";
import {
  decodeYamlSource,
  normalizeYamlLogicalValue,
  validateYamlDocument,
} from "./yaml-authoring-profile.js";

export async function readYamlRecord(path, required = true) {
  let source;
  try {
    source = decodeYamlSource(await readFile(path), path);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) {
      return undefined;
    }
    if (error?.code === "ENOENT") {
      throw new PackageError(
        "PACKAGE_FILE_MISSING",
        path,
        "Graph package の必須ファイルがありません。",
      );
    }
    throw error;
  }

  let document;
  try {
    document = parseDocument(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (document.errors.length > 0) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      document.errors[0].message,
    );
  }
  validateYamlDocument(document, path);

  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      "記録の根は対応表でなければなりません。",
    );
  }
  try {
    return normalizeYamlLogicalValue(value);
  } catch (error) {
    throw new PackageError(
      "PACKAGE_AUTHORING_PROFILE_INVALID",
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}
