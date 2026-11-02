import assert from "node:assert/strict";
import { createNetworkImportTransport } from "../src/network-import-transport.js";

// A fresh process lets each case use Node's real trust configuration at startup.
// No request implementation, TLS verifier, or production origin policy is replaced.
const [url, mode] = process.argv.slice(2);
assert.equal(new URL(url).hostname, "127.0.0.1");
assert.equal(new URL(url).protocol, "https:");
const transport = createNetworkImportTransport();
const controller = new AbortController();
try {
  const pending = transport.fetchImpl(url, { method: "GET", redirect: "manual",
    headers: { authorization: "Bearer SYNTHETIC_HTTPS_FIXTURE" }, signal: controller.signal });
  if (mode === "untrusted" || mode === "wrong-host") {
    await assert.rejects(pending, { code: mode === "untrusted" ? "DEPTH_ZERO_SELF_SIGNED_CERT" : "ERR_TLS_CERT_ALTNAME_INVALID" });
  } else {
    const response = await pending;
    assert.equal(response.url, url);
    assert.equal(response.status, mode === "redirect" ? 302 : 200);
    if (mode === "normal") {
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(response.headers.get("x-fixture"), "owned-https");
      assert.deepEqual(JSON.parse(await response.text()), { value: "日本語の本文" });
    } else if (mode === "redirect") {
      assert.equal(response.headers.get("location"), "/unexpected-redirect-target");
      assert.equal(await response.text(), "redirect fixture");
    } else {
      const failedBody = assert.rejects(response.text());
      if (mode === "abort-body") controller.abort();
      else if (mode === "close-body") await transport.close();
      else assert.equal(mode, "truncated-body");
      await failedBody;
    }
  }
} finally {
  await transport.close();
}
console.log(JSON.stringify({ mode, passed: true }));
