import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, schemaDefinitionDigest } from "../src/canonical.js";
import { normalizeNfc, UNICODE_NFC_VERSION } from "../src/unicode-nfc.js";
import { readYamlRecord } from "../src/yaml-reader.js";
import { serializeYamlRecord } from "../src/yaml-writer.js";

const fixture = readFileSync(new URL("./fixtures/unicode-normalization-16.txt", import.meta.url), "utf8");
const decode = (source) => source.split(" ").map((point) => String.fromCodePoint(parseInt(point, 16))).join("");
const rows = fixture.split("\n").filter((line) => line && !/^[#@]/.test(line)).map((line) => line.split(";").map(decode));
const regression = "a\u0315\u05c8\u0300";

test("Unicode 16 NFC satisfies every official five-column conformance row", () => {
  assert.equal(UNICODE_NFC_VERSION, "16.0.0");
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "c31999696cce2be0611ab5ac4335f451612740b921b2a59a9f139071d8cb654d");
  assert.equal(rows.length, 19965);
  for (const [c1, c2, c3, c4, c5] of rows) {
    assert.equal(normalizeNfc(c1), c2);
    assert.equal(normalizeNfc(c2), c2);
    assert.equal(normalizeNfc(c3), c2);
    assert.equal(normalizeNfc(c4), c4);
    assert.equal(normalizeNfc(c5), c4);
  }
});

test("Unicode 16 NFC leaves every singleton omitted from official Part1 unchanged", () => {
  const listed = new Set();
  let part;
  for (const line of fixture.split("\n")) {
    if (line.startsWith("@")) part = line;
    else if (part === "@Part1" && line && !line.startsWith("#")) listed.add(parseInt(line.split(";")[0], 16));
  }
  assert.ok(listed.size > 1000);
  for (let point = 0; point <= 0x10ffff; point += 1) {
    if ((point >= 0xd800 && point <= 0xdfff) || listed.has(point)) continue;
    const value = String.fromCodePoint(point);
    assert.equal(normalizeNfc(value), value, `U+${point.toString(16)}`);
  }
});

test("canonical keys, values, bytes and digests preserve Unicode 16 behavior", () => {
  assert.throws(() => normalizeNfc(42), TypeError);
  const value = { [regression]: regression };
  const expected = `{"${regression}":"${regression}"}`;
  assert.equal(canonicalJson(value), expected);
  assert.equal(Buffer.byteLength(expected), 21);
  assert.equal(schemaDefinitionDigest(value), "sha256:e67d7eb81d14544f62a52312c13f78a02c4e883e8638e321b656dc34d592505d");
  assert.throws(() => canonicalJson({ "e\u0301": 1, "é": 2 }), /重複/);
  assert.throws(() => canonicalJson("\ud800"), /surrogate/);
});

test("normalization preserves later unassigned scalars and handles long combining runs", () => {
  for (const value of [regression, "a\u0315\u1acf\u0300", "a\u0315\u{1e6e3}\u0300", "\u{10ffff}"]) {
    assert.equal(normalizeNfc(value), value);
  }
  assert.equal(normalizeNfc("a" + "\u0315".repeat(20000) + "\u0300"), "à" + "\u0315".repeat(20000));
  assert.equal(normalizeNfc("\uac01"), "\uac01");
  assert.equal(normalizeNfc("\u1100\u1161\u11a8"), "\uac01");
});

test("YAML writing and reading use the same pinned normalization for keys and values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morivyx-unicode-"));
  try {
    const record = {
      format: "morivyx.decision-revision-request/0.1",
      decisionId: "urn:uuid:00000000-0000-4000-8000-000000000001",
      attributes: { question: regression, rationale: "e\u0301" },
      changeSetId: "urn:uuid:00000000-0000-4000-8000-000000000002",
      resultingRevision: "graph:test",
      actor: "urn:uuid:00000000-0000-4000-8000-000000000003",
      recordedAt: "2026-11-02T00:00:00Z",
      extensions: { "unicode:test": { [regression]: regression } },
    };
    const source = serializeYamlRecord(record);
    const path = join(directory, "request.yaml");
    await writeFile(path, source);
    const read = await readYamlRecord(path);
    assert.equal(read.attributes.question, regression);
    assert.equal(read.attributes.rationale, "é");
    assert.equal(read.extensions["unicode:test"][regression], regression);
    assert.equal(canonicalJson(read), canonicalJson(record));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
