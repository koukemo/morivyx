import { normalizeNfc } from "./unicode-nfc.js";
import { isAlias, isMap, isPair, isScalar, isSeq } from "yaml";
import { PackageError } from "./errors.js";
import { validateYamlAuthoringOrder } from "./yaml-authoring-order.js";
import { validateYamlNullPolicy } from "./yaml-null-policy.js";
import { validateYamlSetPolicy } from "./yaml-set-policy.js";

const INTEGER_PATTERN = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;
const DOCUMENT_MARKER_PATTERN = /^(?:%.*|---(?:[ \t]|$)|\.\.\.(?:[ \t]|$))/m;

function invalid(path, message) {
  throw new PackageError("PACKAGE_AUTHORING_PROFILE_INVALID", path, message);
}

function pointerChild(path, value) {
  const segment = String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${segment}`;
}

export function decodeYamlSource(bytes, path) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    invalid(path, "YAML に BOM を付けられません。");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid(path, "YAML が正しい UTF-8 ではありません。");
  }
  if (source.includes("\r")) {
    invalid(path, "YAML の改行は LF だけを使います。");
  }
  if (source.includes("\t")) {
    invalid(path, "YAML にタブを使えません。");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(source)) {
    invalid(path, "YAML に生の制御文字を使えません。二重引用符内のエスケープで表します。");
  }
  if (!source.endsWith("\n") || /\n *\n$/.test(source)) {
    invalid(path, "YAML の末尾改行は一件だけにします。");
  }
  if (DOCUMENT_MARKER_PATTERN.test(source)) {
    invalid(path, "YAML の指示行と文書境界表記を使えません。");
  }
  return source;
}

function validateComments(node, path) {
  if (node?.comment || node?.commentBefore) {
    invalid(path, "YAML にコメントを保存できません。");
  }
}

function validateScalar(node, path, key = false) {
  validateComments(node, path);
  if (node.anchor || node.tag) {
    invalid(path, "YAML の anchor または custom tag を使えません。");
  }
  if (typeof node.value === "string" && !node.value.isWellFormed()) {
    invalid(path, "YAML の文字列に対にならない UTF-16 の文字コードを使えません。");
  }
  if (key) {
    if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") {
      invalid(path, "YAML の項目名にも block scalar を使えません。");
    }
    if (typeof node.value !== "string") {
      invalid(path, "YAML の項目名は文字列でなければなりません。");
    }
    if (node.type === "PLAIN" && /[\x7f-\x84\x86-\x9f\ufffe\uffff]/u.test(node.value)) {
      invalid(path, "印字できない項目名は二重引用符内のエスケープで表します。");
    }
    return;
  }

  if (typeof node.value === "string") {
    if (node.type !== "QUOTE_DOUBLE") {
      invalid(path, "YAML の文字列値は二重引用符で囲みます。");
    }
    return;
  }
  if (typeof node.value === "number") {
    if (
      !INTEGER_PATTERN.test(node.source) ||
      !Number.isSafeInteger(node.value) ||
      Object.is(node.value, -0)
    ) {
      invalid(path, "YAML の整数表記または範囲が不正です。");
    }
    return;
  }
  if (typeof node.value === "boolean") {
    if (node.source !== "true" && node.source !== "false") {
      invalid(path, "YAML の真偽値は小文字で書きます。");
    }
    return;
  }
  if (node.value === null) {
    if (node.source !== "null") {
      invalid(path, "YAML の null は小文字で明記します。");
    }
    return;
  }
  invalid(path, "Git authoring profile が許可しない YAML 値です。");
}

function validateNode(node, path) {
  validateComments(node, path);
  if (!node) {
    invalid(path, "YAML の値を省略できません。");
  }
  if (isAlias(node)) {
    invalid(path, "YAML の alias を使えません。");
  }
  if (node.anchor || node.tag) {
    invalid(path, "YAML の anchor または custom tag を使えません。");
  }
  if (isScalar(node)) {
    validateScalar(node, path);
    return;
  }
  if (isSeq(node)) {
    if (node.flow && node.items.length > 0) {
      invalid(path, "YAML の flow style を使えません。");
    }
    node.items.forEach((item, index) =>
      validateNode(item, pointerChild(path, index)),
    );
    return;
  }
  if (isMap(node)) {
    if (node.flow && node.items.length > 0) {
      invalid(path, "YAML の flow style を使えません。");
    }
    for (const item of node.srcToken?.items ?? []) {
      const keyIndicator = item.start?.find((token) => token.type === "explicit-key-ind");
      const valueIndicator = item.sep?.find((token) => token.type === "map-value-ind");
      if (keyIndicator && valueIndicator && keyIndicator.indent !== valueIndicator.indent) {
        invalid(path, "明示した項目名の ? と値の : は同じ字下げ位置にします。");
      }
    }
    const normalizedKeys = new Set();
    for (const pair of node.items) {
      if (!isPair(pair) || !isScalar(pair.key)) {
        invalid(path, "YAML の項目名は scalar 文字列にします。");
      }
      validateScalar(pair.key, path, true);
      const key = normalizeNfc(pair.key.value);
      if (key === "<<") {
        invalid(path, "YAML の merge key を使えません。");
      }
      if (normalizedKeys.has(key)) {
        invalid(path, `NFC 正規化後に重複する項目です: ${key}`);
      }
      normalizedKeys.add(key);
      validateComments(pair, pointerChild(path, key));
      validateNode(pair.value, pointerChild(path, key));
    }
    return;
  }
  invalid(path, "Git authoring profile が許可しない YAML node です。");
}

export function validateYamlDocument(document, path) {
  try {
    validateComments(document, "");
    validateNode(document.contents, "");
    validateYamlAuthoringOrder(document);
    validateYamlNullPolicy(document);
    validateYamlSetPolicy(document);
  } catch (error) {
    if (
      error instanceof PackageError &&
      (error.code === "PACKAGE_AUTHORING_PROFILE_INVALID" ||
        error.code === "PACKAGE_AUTHORING_ORDER_INVALID" ||
        error.code === "PACKAGE_NULL_INVALID" ||
        error.code === "PACKAGE_SET_ORDER_INVALID")
    ) {
      throw new PackageError(
        error.code,
        error.path ? `${path}#${error.path}` : path,
        error.message,
      );
    }
    throw error;
  }
}

export function normalizeYamlLogicalValue(value) {
  if (typeof value === "string") {
    return normalizeNfc(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeYamlLogicalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized = {};
  const keys = new Set();
  for (const [rawKey, entry] of Object.entries(value)) {
    const key = normalizeNfc(rawKey);
    if (keys.has(key)) {
      throw new TypeError(`NFC 正規化後に重複する項目です: ${key}`);
    }
    keys.add(key);
    Object.defineProperty(normalized, key, {
      value: normalizeYamlLogicalValue(entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}
