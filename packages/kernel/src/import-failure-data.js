import { types } from "node:util";
import { canonicalJson } from "./canonical.js";

// Rejected inputs and thrown exceptions are not trusted adapters. Inspect only
// ordinary own data; neither getters nor Proxy traps may run here.
export function safeImportRunId(request) {
  if (request === null || typeof request !== "object" || types.isProxy(request) || Array.isArray(request)) {
    return "invalid-run";
  }
  const property = Object.getOwnPropertyDescriptor(request, "runId");
  if (!property || property.enumerable !== true || !Object.hasOwn(property, "value") ||
      typeof property.value !== "string" || property.value.length === 0) return "invalid-run";
  try {
    canonicalJson(property.value);
    return property.value;
  } catch {
    return "invalid-run";
  }
}

export function importErrorCode(error, expectedPrototype, fallback) {
  if (error === null || !["object", "function"].includes(typeof error) || types.isProxy(error)) return fallback;
  let prototype = Object.getPrototypeOf(error);
  while (prototype !== null) {
    if (types.isProxy(prototype)) return fallback;
    if (prototype === expectedPrototype) {
      const property = Object.getOwnPropertyDescriptor(error, "code");
      if (!property || !Object.hasOwn(property, "value") || typeof property.value !== "string" ||
          property.value.length === 0) return fallback;
      try {
        canonicalJson(property.value);
        return property.value;
      } catch {
        return fallback;
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return fallback;
}
