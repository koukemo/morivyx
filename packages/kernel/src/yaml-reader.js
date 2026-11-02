import { readFile } from "node:fs/promises";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { PackageError } from "./errors.js";
import {
  decodeYamlSource,
  normalizeYamlLogicalValue,
  validateYamlDocument,
} from "./yaml-authoring-profile.js";

function keyLengthErrors(document, source) {
  const reported = new Set();
  for (const error of document.errors) {
    if (error.code === "KEY_OVER_1024_CHARS") reported.add(`${error.pos[0]}:${error.pos[1]}`);
  }
  if (reported.size === 0) return document.errors;
  // yaml counts UTF-16 offsets. YAML's implicit-key limit counts source
  // Unicode characters, including quotes, escapes and separation spaces.
  const validRanges = new Set();
  const pending = [document.contents];
  while (pending.length > 0) {
    const node = pending.pop();
    if (isSeq(node)) {
      for (const item of node.items) pending.push(item);
    } else if (isMap(node)) {
      const tokens = new Map();
      if (node.srcToken?.type === "block-map") {
        for (const item of node.srcToken.items) {
          if (item.key) tokens.set(item.key.offset, item);
        }
      }
      for (const pair of node.items) {
        pending.push(pair?.key, pair?.value);
        const key = pair?.key;
        const range = key?.range;
        const item = tokens.get(range?.[0]);
        if (!isScalar(key) || typeof key.value !== "string" || key.anchor || key.tag || !item || !range ||
            !["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"].includes(key.type) ||
            item.start?.some((token) => token.type === "explicit-key-ind")) continue;
        const position = `${range[0]}:${range[1]}`;
        if (!reported.has(position)) continue;
        const colon = item.sep?.find((token) => token.type === "map-value-ind");
        if (!colon || colon.offset < range[1]) continue;
        const spelling = source.slice(range[0], colon.offset);
        if (spelling.includes("\n")) continue;
        let length = 0;
        for (const character of spelling) {
          if (++length > 1024) break;
        }
        if (length <= 1024) validRanges.add(position);
      }
    }
  }
  return document.errors.filter((error) => error.code !== "KEY_OVER_1024_CHARS" ||
    !validRanges.has(`${error.pos[0]}:${error.pos[1]}`));
}

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
      keepSourceTokens: true,
    });
  } catch (error) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const errors = keyLengthErrors(document, source);
  if (errors.length > 0) {
    throw new PackageError(
      "PACKAGE_YAML_INVALID",
      path,
      errors[0].message,
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
