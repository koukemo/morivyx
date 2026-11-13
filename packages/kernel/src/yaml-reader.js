import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Composer, Parser, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { PackageError } from "./errors.js";
import {
  decodeYamlSource,
  normalizeYamlLogicalValue,
  validateYamlDocument,
} from "./yaml-authoring-profile.js";

// Use the installed, lock-pinned yaml resolvers without changing their exports,
// prototypes or module cache. Only collection descent is scheduled here.
const yamlRequire = createRequire(createRequire(import.meta.url).resolve("yaml"));
const { composeCollection } = yamlRequire("./compose/compose-collection.js");
const { composeNode, composeEmptyNode } = yamlRequire("./compose/compose-node.js");
const { resolveProps } = yamlRequire("./compose/resolve-props.js");
const collectionToken = (token) => token && ["block-map", "block-seq", "flow-collection"].includes(token.type);

function composeDeepCollection(context, token, props, onError) {
  const completed = new WeakMap();
  const pending = [{ context: { ...context }, token, props }];
  const request = Symbol("collection-request");
  while (pending.length > 0) {
    const frame = pending.at(-1);
    const errors = [];
    const report = (...args) => errors.push(args);
    const callbacks = {
      composeEmptyNode,
      composeNode(childContext, childToken, childProps, childError) {
        if (!collectionToken(childToken)) return composeNode(childContext, childToken, childProps, childError);
        const child = completed.get(childToken);
        if (!child) throw { request, context: { ...childContext }, token: childToken, props: childProps };
        for (const error of child.errors) childError(...error);
        return child.node;
      },
    };
    let node;
    try {
      node = composeCollection(callbacks, { ...frame.context }, frame.token, frame.props, report);
    } catch (error) {
      if (error?.request !== request) throw error;
      pending.push(error);
      continue;
    }
    const { anchor, comment, spaceBefore } = frame.props;
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "") report(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore) node.spaceBefore = true;
    if (comment) node.commentBefore = comment;
    node.srcToken = frame.token;
    completed.set(frame.token, { node, errors });
    pending.pop();
  }
  const result = completed.get(token);
  for (const error of result.errors) onError(...error);
  return result.node;
}

function composeYamlSource(source, options) {
  const tokens = [...new Parser().parse(source)];
  const documentToken = tokens.find((token) => token.type === "document");
  const root = documentToken?.value;
  const pending = root ? [{ token: root, depth: 0 }] : [];
  let deep = false;
  while (pending.length > 0) {
    const { token, depth } = pending.pop();
    // This bounds only the native recursive fast path, never accepted input.
    if (depth > 64) { deep = true; break; }
    if (!collectionToken(token)) continue;
    for (const item of token.items) {
      if (item.key) pending.push({ token: item.key, depth: depth + 1 });
      if (item.value) pending.push({ token: item.value, depth: depth + 1 });
    }
  }
  if (!deep) return parseDocument(source, options);

  // Compose the stream envelope normally and resolve the original collection
  // with explicit frames. Every scalar and collection rule remains yaml's.
  const composer = new Composer(options);
  const envelope = tokens.map((token) => token === documentToken ?
    { ...token, value: { ...root, items: [] } } : token);
  const [document] = composer.compose(envelope, true, source.length);
  const context = { atKey: false, atRoot: true, directives: document.directives,
    options: document.options, schema: document.schema };
  const report = (...args) => composer.onError(...args);
  const props = resolveProps(documentToken.start, { indicator: "doc-start", next: root,
    offset: documentToken.offset, onError: report, parentIndent: 0, startOnNewline: true });
  const node = composeDeepCollection(context, root, props, report);
  // The envelope may have attached a leading stream comment to its root.
  if (document.contents?.commentBefore) node.commentBefore = document.contents.commentBefore;
  document.contents = node;
  document.range[1] = node.range[2];
  document.errors.push(...composer.errors);
  document.warnings.push(...composer.warnings);
  return document;
}

function documentLogicalValue(document) {
  const result = {};
  const pending = [{ node: document.contents, target: result, key: "value" }];
  while (pending.length > 0) {
    const { node, target, key } = pending.pop();
    let value;
    if (isScalar(node)) value = node.value;
    else {
      value = isSeq(node) ? [] : {};
      const entries = isSeq(node) ? node.items.map((item, index) => [index, item]) :
        node.items.map((pair) => [pair.key.value, pair.value]);
      for (const [childKey] of entries) Object.defineProperty(value, childKey, {
        value: undefined, writable: true, configurable: true, enumerable: true,
      });
      for (let index = entries.length - 1; index >= 0; index--) {
        pending.push({ node: entries[index][1], target: value, key: entries[index][0] });
      }
    }
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
  }
  return result.value;
}

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
    document = composeYamlSource(source, {
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
    // The authoring profile has already rejected aliases and non-string keys.
    value = documentLogicalValue(document);
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
