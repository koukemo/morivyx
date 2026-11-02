import { normalizeNfc } from "./unicode-nfc.js";
import { createHash } from "node:crypto";

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function compareUnicode(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0));
  const rightPoints = Array.from(right, (value) => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }

  return leftPoints.length - rightPoints.length;
}

function normalizeTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return value;
  }

  const [, year, month, day, hour, minute, second, rawFraction, zone, sign, offsetHour, offsetMinute] =
    match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] =
    parts;
  const localDate = new Date(0);
  localDate.setUTCFullYear(yearValue, monthValue - 1, dayValue);
  localDate.setUTCHours(hourValue, minuteValue, secondValue, 0);

  if (
    localDate.getUTCFullYear() !== yearValue ||
    localDate.getUTCMonth() !== monthValue - 1 ||
    localDate.getUTCDate() !== dayValue ||
    localDate.getUTCHours() !== hourValue ||
    localDate.getUTCMinutes() !== minuteValue ||
    localDate.getUTCSeconds() !== secondValue
  ) {
    throw new TypeError(`無効な日時です: ${value}`);
  }

  const offsetHourValue = Number(offsetHour ?? 0);
  const offsetMinuteValue = Number(offsetMinute ?? 0);
  if (
    offsetMinuteValue > 59 ||
    offsetHourValue > 14 ||
    (offsetHourValue === 14 && offsetMinuteValue !== 0)
  ) {
    throw new TypeError(`無効な時間帯です: ${value}`);
  }

  const offsetMinutes =
    zone === "Z"
      ? 0
      : (sign === "+" ? 1 : -1) *
        (offsetHourValue * 60 + offsetMinuteValue);
  const utcDate = new Date(localDate.getTime() - offsetMinutes * 60_000);
  const utcYear = utcDate.getUTCFullYear();
  if (utcYear < 0 || utcYear > 9999) {
    throw new TypeError(`UTC変換後の年が4桁の範囲外です: ${value}`);
  }
  const base = utcDate.toISOString().slice(0, 19);
  const fraction = rawFraction?.replace(/0+$/, "") ?? "";

  return `${base}${fraction ? `.${fraction}` : ""}Z`;
}

function normalizeUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        throw new TypeError(
          "canonical form は単独surrogateを含む文字列を受け入れません。",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(
        "canonical form は単独surrogateを含む文字列を受け入れません。",
      );
    }
  }
  return normalizeNfc(value);
}

function logicalArrayItems(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new TypeError(
      "canonical form の一覧は連続した列挙可能なdata propertyだけを受け入れます。",
    );
  }
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        "canonical form の一覧は連続した列挙可能なdata propertyだけを受け入れます。",
      );
    }
    items.push(descriptor.value);
  }
  return items;
}

function recordWithoutField(value, omittedField) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "canonical form は論理値の対応表だけを受け入れます。",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "canonical form は論理値の対応表だけを受け入れます。",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const omittedDescriptor = descriptors[omittedField];
  if (
    omittedDescriptor !== undefined &&
    (omittedDescriptor.enumerable !== true ||
      !Object.hasOwn(omittedDescriptor, "value"))
  ) {
    throw new TypeError(
      "canonical form の対応表は列挙可能な文字列data propertyだけを受け入れます。",
    );
  }
  delete descriptors[omittedField];
  return Object.create(prototype, descriptors);
}

function ownStringProperty(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Graph rootの要素は対応表でなければなりません。");
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string"
  ) {
    throw new TypeError(
      `Graph rootの${field}はown enumerable string data propertyでなければなりません。`,
    );
  }
  return normalizeUnicode(descriptor.value);
}

function serialize(value) {
  const output = [];
  const activeValues = new Set();
  const operations = [{ type: "value", value }];

  while (operations.length > 0) {
    const operation = operations.pop();
    if (operation.type === "text") {
      output.push(operation.value);
      continue;
    }
    if (operation.type === "leave") {
      activeValues.delete(operation.value);
      continue;
    }

    const current = operation.value;
    if (current === null) {
      output.push("null");
      continue;
    }
    if (typeof current === "string") {
      output.push(JSON.stringify(normalizeTimestamp(normalizeUnicode(current))));
      continue;
    }
    if (typeof current === "boolean") {
      output.push(current ? "true" : "false");
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new TypeError("canonical form は安全な整数だけを受け入れます。");
      }
      output.push(String(current));
      continue;
    }
    if (typeof current !== "object") {
      throw new TypeError(
        `canonical form に変換できない値です: ${typeof current}`,
      );
    }
    if (activeValues.has(current)) {
      throw new TypeError("canonical form は循環参照を受け入れません。");
    }
    activeValues.add(current);
    operations.push({ type: "leave", value: current });

    if (Array.isArray(current)) {
      const items = logicalArrayItems(current);
      output.push("[");
      operations.push({ type: "text", value: "]" });
      for (let index = items.length - 1; index >= 0; index -= 1) {
        operations.push({ type: "value", value: items[index] });
        operations.push({ type: "text", value: index === 0 ? "" : "," });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "canonical form は論理値の対応表だけを受け入れます。",
      );
    }
    const entries = [];
    const normalizedKeys = new Set();
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError(
          "canonical form の対応表は列挙可能な文字列data propertyだけを受け入れます。",
        );
      }
      const normalizedKey = normalizeUnicode(key);
      if (normalizedKeys.has(normalizedKey)) {
        throw new TypeError(
          `NFC 正規化後に重複する項目です: ${normalizedKey}`,
        );
      }
      normalizedKeys.add(normalizedKey);
      entries.push([normalizedKey, descriptor.value]);
    }
    entries.sort(([left], [right]) => compareUnicode(left, right));
    output.push("{");
    operations.push({ type: "text", value: "}" });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entryValue] = entries[index];
      operations.push({ type: "value", value: entryValue });
      operations.push({
        type: "text",
        value: `${index === 0 ? "" : ","}${JSON.stringify(key)}:`,
      });
    }
  }
  return output.join("");
}

export function canonicalJson(value) {
  return serialize(value);
}

export function digestValue(prefix, value) {
  const hash = createHash("sha256");
  hash.update(prefix, "ascii");
  hash.update(Buffer.from([0]));
  hash.update(canonicalJson(value), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export function revisionId(element) {
  return digestValue(
    "morivyx:revision:v1",
    recordWithoutField(element, "revision"),
  );
}

export function schemaLockDigest(schemaLock) {
  return digestValue("morivyx:schema-lock:v1", schemaLock);
}

export function schemaDefinitionDigest(schemaDefinition) {
  return digestValue("morivyx:schema:v1", schemaDefinition);
}

export function changeSetDigest(changeSet) {
  return digestValue(
    "morivyx:changeset:v1",
    recordWithoutField(changeSet, "id"),
  );
}

export function migrationDigest(migration) {
  return digestValue(
    "morivyx:migration:v1",
    recordWithoutField(migration, "id"),
  );
}

export function graphRootDigest(elements) {
  const pairs = logicalArrayItems(elements)
    .map((element) => [
      ownStringProperty(element, "id"),
      ownStringProperty(element, "revision"),
    ])
    .sort(([left], [right]) => compareUnicode(left, right));
  return digestValue("morivyx:root:v1", pairs);
}
