import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeYamlRecord } from "../../src/yaml-writer.js";
import { readYamlRecord } from "../../src/yaml-reader.js";

const { cases } = JSON.parse(await readFile(new URL("./yaml-depth-runtime-vectors.json", import.meta.url)));
const vector = cases.find(({ id }) => id === process.argv[2]);
assert.ok(vector);
const operation = process.argv[3];
assert.ok(["read", "write"].includes(operation));
assert.ok(!process.execArgv.some((arg) => /stack|jit|opt/.test(arg)));

// Build logical input and source independently, directly from block YAML syntax.
// No serializer, parser, Python implementation or prior deep call is the oracle.
const leaf = vector.leaf ?? "value";
const extensionKey = vector.extensionKey ?? "example.test/deep";
let value = leaf;
const kinds = Array.from({ length: vector.depth }, (_, i) =>
  vector.shape === "sequence" || (vector.shape === "mixed" && i % 2 === 0) ? "sequence" : "map");
for (let i = kinds.length - 1; i >= 0; i--) value = kinds[i] === "map" ? { probe: value } : [value];
const record = { format: "morivyx.git-graph/0.1", extensions: { [extensionKey]: value } };
const lines = ['format: "morivyx.git-graph/0.1"', "extensions:", `  ${extensionKey}:`];
let prefix = "    ";
for (let i = 0; i < kinds.length; i++) {
  const text = kinds[i] === "map" ? "probe:" : "-";
  if (i === kinds.length - 1) lines.push(`${prefix}${text} ${JSON.stringify(leaf)}`);
  else if (kinds[i] === "map") { lines.push(prefix + text); prefix += "  "; }
  else { prefix += "- "; }
  // A compact sequence prefix is used only for its immediately nested node.
  if (i < kinds.length - 1 && kinds[i] === "map") prefix = prefix.replaceAll("-", " ");
}
const source = lines.join("\n") + "\n";
const directory = await mkdtemp(join(tmpdir(), "morivyx-yaml-depth-runtime-"));
try {
  if (operation === "write") assert.equal(serializeYamlRecord(record), source);
  else {
    const path = join(directory, "record.yaml");
    await writeFile(path, source);
    const actual = await readYamlRecord(path);
    let entry = actual.extensions[extensionKey];
    for (const kind of kinds) entry = kind === "map" ? entry.probe : entry[0];
    assert.equal(entry, leaf);
    assert.deepEqual(Object.keys(actual), ["format", "extensions"]);
  }
  console.log(JSON.stringify({ id: vector.id, operation, depth: vector.depth, runtime: process.version,
    execArgv: process.execArgv, freshProcess: true, bytes: Buffer.byteLength(source), accepted: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
