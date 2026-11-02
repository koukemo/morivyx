import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Python independently passes the complete Unicode 16 NFC corpus and fixed digest", () => {
  const result = spawnSync(process.env.MORIVYX_UNICODE_PYTHON ?? "python3", ["-B", "-m", "unittest", "-v", "test_unicode_nfc"], {
    cwd: fileURLToPath(new URL("../packages/portable-core/", import.meta.url)),
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});

test("Core and portable normalization do not delegate NFC to the host Unicode tables", () => {
  for (const name of ["canonical.js", "decision-markdown.js", "graph-constraints.js", "graph-index.js", "report.js", "schema-definition.js", "schema-lock.js", "semantic-diff.js", "trace-query.js", "validation-phase-7.js", "validator.js", "yaml-authoring-order.js", "yaml-authoring-profile.js", "yaml-null-policy.js", "yaml-set-policy.js", "yaml-writer.js"]) {
    const source = readFileSync(new URL(`../packages/kernel/src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.normalize\??\.?\([^)]*["']NFC["']/);
  }
  const source = readFileSync(new URL("../packages/portable-core/canonical.py", import.meta.url), "utf8");
  assert.doesNotMatch(source, /unicodedata/);
});
