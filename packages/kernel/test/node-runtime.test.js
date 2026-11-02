import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NODE_MINIMUM_VERSION, assertSupportedNodeVersion } from "../src/node-runtime.js";

test("accepts the minimum release and newer stable runtimes", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion());
  for (const version of ["26.13.0", "26.13.1", "26.14.0", "27.0.0", "100.0.0"]) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
});

test("rejects old, prerelease, malformed, and unsafe runtime versions", () => {
  for (const version of ["22.13.0", "26.0.0", "26.12.99", "26.13.0-rc.1", "27.0.0-nightly",
    "v26.13.0", "026.13.0", "26.013.0", "26.13.00", "26.13", "26.13.0+local", "",
    "9007199254740992.0.0", null, 26]) {
    assert.throws(() => assertSupportedNodeVersion(version), error =>
      error.code === "NODE_VERSION_UNSUPPORTED" && error.message.includes(NODE_MINIMUM_VERSION));
  }
});

test("the CLI minimum matches the installation requirements", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.engines.node, `>=${NODE_MINIMUM_VERSION}`);
  const config = await readFile(new URL("../.npmrc", import.meta.url), "utf8");
  assert.match(config, /^engine-strict=true$/m);
});

test("unsupported CLI runtimes stop before help, arguments, or filesystem operations", () => {
  const cli = new URL("../src/cli.js", import.meta.url).href;
  for (const args of [["--help"], ["--version"], ["inspect", "unread-input"],
    ["reindex", "unread-input"], ["store", "unread-input", "unread-record"],
    ["create-decision", "unread-input", "unread-request", "unwritten-output"]]) {
    const source = `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      for (const name of ['readFile', 'readdir', 'writeFile', 'mkdir', 'rename']) {
        fs[name] = () => { throw new Error('UNEXPECTED_FILESYSTEM_OPERATION'); };
      }
      syncBuiltinESMExports();
      Object.defineProperty(process.versions, 'node', {value:'26.0.0'});
      process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(cli)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { valid: false, issues: [{
      code: "NODE_VERSION_UNSUPPORTED", path: "/runtime/node",
      message: `Morivyx requires Node.js >=${NODE_MINIMUM_VERSION}`,
    }] });
  }
});
