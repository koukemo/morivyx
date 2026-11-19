import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { prepareDecisionCreation } from "../packages/kernel/src/decision-creation.js";
import { readGraphPackage } from "../packages/kernel/src/package-reader.js";
import { prepareProposalReview } from "../packages/kernel/src/proposal-review.js";
import { graphRootDigest, revisionId } from "../packages/kernel/src/canonical.js";
import { serializeYamlRecord } from "../packages/kernel/src/yaml-writer.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = n => `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-09T12:00:00Z";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export async function tree(directory) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const entry of (await fs.readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) { result[key] = { directory: true }; await visit(join(path, entry.name), key + "/"); }
      else if (entry.isSymbolicLink()) result[key] = { link: await fs.readlink(join(path, entry.name)) };
      else result[key] = { bytes: (await fs.readFile(join(path, entry.name))).toString("base64") };
    }
  }
  await visit(directory);
  return result;
}

export async function materialize(directory, files) {
  for (const [path, value] of Object.entries(files)) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."));
    const target = join(directory, path);
    if (value.directory) await fs.mkdir(target, { recursive: true });
    else { await fs.mkdir(dirname(target), { recursive: true });
      if (value.link) await fs.symlink(value.link, target);
      else await fs.writeFile(target, Buffer.from(value.bytes, "base64")); }
  }
}

export async function createVectors() {
  const temporary = await fs.mkdtemp(join(tmpdir(), "morivyx-proposal-oracle-input-"));
  try {
    const basePath = join(temporary, "base");
    await fs.cp(join(root, "docs/validation/fixtures/decision-maintenance-base"), basePath, { recursive: true });
    await fs.mkdir(join(basePath, ".morivyx/schemas"), { recursive: true });
    await fs.copyFile(join(root, "docs/schema/morivyx.core@0.1.yaml"), join(basePath, ".morivyx/schemas/morivyx.core@0.1.yaml"));
    const base = await readGraphPackage(basePath);
    const prepared = prepareDecisionCreation(base, {
      format: "morivyx.decision-creation-request/0.1", decisionId: id(1), changeSetId: id(2), actor: id(9), recordedAt: at,
      resultingRevision: "graph:proposal-created", attributes: { question: "保存前に比較するか", rationale: "誤った提案を正本へ入れない", consequences: ["承認は別途必要"] },
    });
    const input = { basePath: "$ROOT/base", changeSet: prepared.changeSet, candidateElements: [prepared.candidateElement], resultingRevision: prepared.resultingRevision, evaluatedAt: at };
    const files = await tree(temporary), cases = [];
    const add = (name, mutate = () => {}, extra = {}) => {
      const row = { name, input: structuredClone(input), files: structuredClone(files), ...extra };
      mutate(row); cases.push(row); return row;
    };
    const record = (row, path, value) => { row.files[path] = { bytes: Buffer.from(serializeYamlRecord(value)).toString("base64") }; };
    const sync = row => { const x = row.input; for (const e of x.candidateElements) e.revision = revisionId(e);
      x.changeSet.operations[0].afterRevision = x.candidateElements[0].revision;
      x.changeSet.resultingRootDigest = graphRootDigest(x.candidateElements);
      x.resultingRevision.rootDigest = x.changeSet.resultingRootDigest; };
    add("create"); add("own-input-at-call", () => {}, { mode: "mutate-after-call" });
    add("result-aliases-and-isolation", () => {}, { mode: "mutate-result" });
    for (const value of [null, [], {}, false, 0, "text"]) add("input-" + JSON.stringify(value), r => { r.input = value; });
    for (const mode of ["undefined", "bigint", "accessor", "cycle", "nonfinite", "symbol", "function"]) add("input-" + mode, () => {}, { mode });
    for (const value of [null, [], {}, false, 0, ""]) add("basePath-" + JSON.stringify(value), r => { r.input.basePath = value; });
    add("basePath-absent", r => { delete r.input.basePath; });
    for (const key of ["outputPath", "approve", "__proto__", "constructor", "authorization", "persisted"]) add("unknown-" + key, r => { Object.defineProperty(r.input, key, { value: true, enumerable: true, writable: true, configurable: true }); });
    add("basePath-dot-morivyx", r => { r.input.basePath += "/.morivyx"; });
    add("basePath-missing", r => { r.input.basePath = "$ROOT/missing"; });
    add("basePath-whitespace", r => { r.input.basePath = "$ROOT/ "; });
    for (const field of ["changeSet", "candidateElements", "resultingRevision", "evaluatedAt"]) {
      add(field + "-absent", r => { delete r.input[field]; });
      for (const value of [null, false, 0, "", {}, []]) add(field + "-" + JSON.stringify(value), r => { r.input[field] = value; });
    }
    for (const field of Object.keys(input.changeSet)) add("changeSet-drop-" + field, r => { delete r.input.changeSet[field]; });
    for (const field of Object.keys(input.resultingRevision)) add("revision-drop-" + field, r => { delete r.input.resultingRevision[field]; });
    for (const field of Object.keys(input.candidateElements[0])) add("candidate-drop-" + field, r => { delete r.input.candidateElements[0][field]; });
    add("stale-base", r => { r.input.changeSet.baseRevision = "graph:old"; });
    add("candidate-digest-tamper", r => { r.input.candidateElements[0].attributes.rationale = "変更"; });
    add("result-digest-tamper", r => { r.input.resultingRevision.rootDigest = "sha256:" + "0".repeat(64); });
    add("candidate-id-equals-changeSet", r => { r.input.changeSet.id = r.input.candidateElements[0].id; });
    add("candidate-null", r => { r.input.candidateElements = [null]; });
    add("candidate-duplicate", r => { r.input.candidateElements.push(structuredClone(r.input.candidateElements[0])); });
    add("candidate-schema-invalid", r => { delete r.input.candidateElements[0].attributes.question; sync(r); });
    add("candidate-unknown-type", r => { r.input.candidateElements[0].type = "morivyx.unknown"; sync(r); });
    add("candidate-invalid-review-state", r => { r.input.candidateElements[0].reviewState = "approved"; sync(r); });
    for (const value of ["", "invalid", "2026-02-30T00:00:00Z", 0, false, {}, []]) add("evaluation-" + JSON.stringify(value), r => { r.input.evaluatedAt = value; });
    for (const value of [null, false, 0, "bad", {}, [], [{ op: "unknown", targetId: id(1) }]]) add("operations-" + JSON.stringify(value), r => { r.input.changeSet.operations = value; });
    const stored = add("stored-pending", r => { record(r, `base/.morivyx/ledger/${id(2).slice(9)}.yaml`, r.input.changeSet); });
    add("stored-id-content-conflict", r => { r.files = structuredClone(stored.files); r.input.changeSet.provenance.actor = id(99); });
    add("candidate-id-ledger-conflict", r => { r.files = structuredClone(stored.files); r.input.candidateElements[0].id = id(2); r.input.changeSet.id = id(30); });
    add("revoke-pending", r => { r.files = structuredClone(stored.files); const x = r.input;
      x.changeSet.id = id(20); x.changeSet.operations = [{ op: "revoke", targetId: id(2) }]; x.candidateElements = [];
      x.changeSet.resultingRootDigest = graphRootDigest([]); x.resultingRevision.rootDigest = x.changeSet.resultingRootDigest; });
    const first = prepared.candidateElement;
    const baseWithElement = row => {
      record(row, `base/.morivyx/graph/entities/${first.id.slice(9)}.yaml`, first);
      record(row, "base/.morivyx/revision.yaml", { ...base.revision, rootDigest: graphRootDigest([first]) });
    };
    add("revise-replace-retire-timeline", r => { baseWithElement(r);
      const second = structuredClone(first); second.attributes.rationale = "二番目"; second.revision = revisionId(second);
      const replacement = structuredClone(second); replacement.id = id(3); replacement.attributes.rationale = "置換先"; replacement.revision = revisionId(replacement);
      r.input.changeSet.operations = [
        { op: "revise", targetId: first.id, beforeRevision: first.revision, afterRevision: second.revision },
        { op: "replace", targetId: first.id, beforeRevision: second.revision, replacementId: replacement.id, afterRevision: replacement.revision },
        { op: "retire", targetId: replacement.id, beforeRevision: replacement.revision },
      ]; r.input.candidateElements = [second, replacement]; r.input.changeSet.resultingRootDigest = graphRootDigest([]); r.input.resultingRevision.rootDigest = graphRootDigest([]);
    });
    add("changeSet-id-element-conflict", r => { baseWithElement(r); r.input.changeSet.id = first.id; });
    add("base-schema-invalid", r => { const element = structuredClone(first); delete element.attributes.question; element.revision = revisionId(element);
      record(r, `base/.morivyx/graph/entities/${first.id.slice(9)}.yaml`, element);
      record(r, "base/.morivyx/revision.yaml", { ...base.revision, rootDigest: graphRootDigest([element]) }); });
    for (const path of ["schema.lock.yaml", "revision.yaml", "schemas/morivyx.core@0.1.yaml"]) {
      add("missing-" + path, r => { delete r.files["base/.morivyx/" + path]; });
      add("bad-yaml-" + path, r => { r.files["base/.morivyx/" + path] = { bytes: Buffer.from("[invalid").toString("base64") }; });
      add("nonmapping-" + path, r => { r.files["base/.morivyx/" + path] = { bytes: Buffer.from("[]\n").toString("base64") }; });
    }
    add("unlocked-schema", r => { r.files["base/.morivyx/schemas/z~extra.yaml"] = { bytes: Buffer.from("invalid").toString("base64") }; });
    add("ignored-schema-extension", r => { r.files["base/.morivyx/schemas/ignored.txt"] = { bytes: Buffer.from("invalid").toString("base64") }; });
    add("schema-byte-change", r => { const key = "base/.morivyx/schemas/morivyx.core@0.1.yaml"; const s = Buffer.from(r.files[key].bytes, "base64").toString(); r.files[key].bytes = Buffer.from(s.replace("morivyx.core", "morivyx.other")).toString("base64"); });
    add("symbolic-link-in-package", r => { r.files["base/.morivyx/link"] = { link: "revision.yaml" }; });
    for (const method of ["lstat", "readdir", "readFile"]) for (const code of ["EACCES", "EIO", "ENOENT"]) {
      add(`io-${method}-${code}-first`, () => {}, { fault: { method, occurrence: 1, code } });
    }
    // A second readdir hit for schemas exercises registry errors after the safety walk.
    for (const code of ["EACCES", "EIO", "ENOENT"]) add(`registry-readdir-${code}`, () => {}, { fault: { method: "readdir", suffix: "/schemas", occurrence: 2, code } });
    return { format: "morivyx.proposal-review-file-api-vectors/1", provenance: "public fixture and synthetic inputs; original Node observations precede Python implementation", cases };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

function normalize(value, temporary) {
  if (typeof value === "string") return value.replaceAll(temporary, "$ROOT");
  if (Array.isArray(value)) return value.map(v => normalize(v, temporary));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, temporary)]));
  return value;
}

export async function observeCase(row) {
  const temporary = await fs.mkdtemp(join(tmpdir(), "morivyx-proposal-oracle-"));
  const originals = {}, events = [];
  try {
    await materialize(temporary, row.files);
    const before = await tree(temporary);
    let input = JSON.parse(JSON.stringify(row.input).replaceAll("$ROOT", temporary));
    let getterInvoked = false;
    if (row.mode === "undefined") input = undefined;
    if (row.mode === "bigint") input.changeSet = 1n;
    if (row.mode === "nonfinite") input.changeSet = Infinity;
    if (row.mode === "symbol") input.changeSet = Symbol("invalid");
    if (row.mode === "function") input.changeSet = () => {};
    if (row.mode === "cycle") input.changeSet = input;
    if (row.mode === "accessor") input = { get basePath() { getterInvoked = true; return "unused"; } };
    const untouched = ["mutate-after-call", "mutate-result"].includes(row.mode) || !row.mode ? structuredClone(input) : null;
    let matching = 0;
    for (const method of ["lstat", "readdir", "readFile", "writeFile", "mkdir", "rename", "rm", "unlink", "open"]) {
      originals[method] = fs[method];
      fs[method] = async (...args) => {
        const path = String(args[0]); events.push({ method, path: path.replaceAll(temporary, "$ROOT") });
        if (row.fault?.method === method && (!row.fault.suffix || path.endsWith(row.fault.suffix)) && ++matching === row.fault.occurrence) {
          const error = Object.assign(new Error(`synthetic ${row.fault.code}`), { code: row.fault.code, path, syscall: method }); throw error;
        }
        return originals[method](...args);
      };
    }
    syncBuiltinESMExports();
    let outcome, aliases = null;
    try {
      const pending = prepareProposalReview(input);
      if (row.mode === "mutate-after-call") { input.changeSet.provenance.actor = id(99); input.candidateElements[0].attributes.rationale = "呼出し後の変更"; }
      const result = await pending;
      outcome = { returned: result };
      if (row.mode === "mutate-result") {
        aliases = { operation: result.comparison[0].operation === result.changeSet.operations[0], inputOperation: result.changeSet.operations[0] === input.changeSet.operations[0], inputAfter: result.comparison[0].after === input.candidateElements[0] };
        outcome = { returned: structuredClone(result) };
        result.changeSet.provenance.actor = id(99); result.comparison[0].after.attributes.rationale = "返却値の変更";
      }
    } catch (error) {
      outcome = { threw: Object.fromEntries(["name", "code", "path", "message", "errno", "syscall"].filter(key => error[key] !== undefined).map(key => [key, error[key]])) };
    } finally { for (const [method, original] of Object.entries(originals)) fs[method] = original; syncBuiltinESMExports(); }
    const after = await tree(temporary);
    return normalize({ name: row.name, ...outcome, events, fileTreeUnchanged: JSON.stringify(before) === JSON.stringify(after), getterInvoked, inputUnchanged: untouched === null || row.mode === "mutate-after-call" ? null : JSON.stringify(untouched) === JSON.stringify(input), aliases }, temporary);
  } finally { for (const [method, original] of Object.entries(originals)) fs[method] = original; syncBuiltinESMExports(); await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function observe(vectors) {
  const observations = [];
  for (const row of vectors.cases) observations.push(await observeCase(row));
  return { format: "morivyx.proposal-review-file-api-observations/1", observations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]; assert(output, "Pass an output directory; this command never overwrites an existing oracle.");
  await fs.mkdir(output, { recursive: true });
  const vectors = await createVectors(), observations = await observe(vectors);
  const written = {};
  for (const [name, value] of [["vectors.json", vectors], ["node-observations.json", observations]]) {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await fs.writeFile(join(output, name), bytes, { flag: "wx" }); written[name] = sha(bytes);
  }
  console.log(JSON.stringify({ cases: vectors.cases.length, observations: observations.observations.length, sha256: written }, null, 2));
}
