export const NODE_MINIMUM_VERSION = "26.13.0";
const minimum = NODE_MINIMUM_VERSION.split(".").map(Number);

export function assertSupportedNodeVersion(version = process.versions.node) {
  const parts = typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    ? version.split(".").map(Number) : null;
  const different = parts?.findIndex((value, index) => value !== minimum[index]);
  if (!parts || !parts.every(Number.isSafeInteger) ||
      (different >= 0 && parts[different] < minimum[different])) {
    const error = new Error(`Morivyx requires Node.js >=${NODE_MINIMUM_VERSION}`);
    error.code = "NODE_VERSION_UNSUPPORTED";
    throw error;
  }
}
