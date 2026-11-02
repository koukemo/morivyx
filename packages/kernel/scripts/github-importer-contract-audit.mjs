import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import {
  GITHUB_API_ORIGIN,
  GITHUB_IMPORT_LIMITS,
  githubImportRequest,
  importGitHubFile,
  validateGitHubImportRequest,
  validateGitHubImportResult,
} from "../src/github-importer.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`../test/fixtures/github-importer/${name}.json`, import.meta.url), "utf8",
));
const fixedRequest = await fixture("request");
const fixedResult = await fixture("result");
const ROOT_TREE = "2".repeat(40);
const CHILD_TREE = "3".repeat(40);
const clock = () => "2026-09-08T15:00:00Z";
const permission = {
  apiOrigin: GITHUB_API_ORIGIN,
  owner: fixedRequest.input.owner,
  repository: fixedRequest.input.repository,
  repositoryId: fixedRequest.input.repositoryId,
};
const prefix = `${GITHUB_API_ORIGIN}/repos/${permission.owner}/${permission.repository}`;
const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const jsonResponse = (value, options = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" }, ...options,
});

function scenario({ content = Buffer.alloc(0), nested = false, mode = "100644" } = {}) {
  const sha = blobSha(content);
  const documents = new Map([
    [prefix, { id: 123, full_name: "fixture-owner/fixture-repository" }],
    [`${prefix}/git/commits/${fixedRequest.input.commit}`, {
      sha: fixedRequest.input.commit, tree: { sha: ROOT_TREE },
    }],
    [`${prefix}/git/trees/${ROOT_TREE}`, {
      sha: ROOT_TREE, truncated: false,
      tree: nested ? [{ path: "directory", type: "tree", mode: "040000", sha: CHILD_TREE }] :
        [{ path: "source.txt", type: "blob", mode, sha, size: content.length }],
    }],
    [`${prefix}/git/trees/${CHILD_TREE}`, {
      sha: CHILD_TREE, truncated: false,
      tree: [{ path: "source.txt", type: "blob", mode, sha, size: content.length }],
    }],
    [`${prefix}/git/blobs/${sha}`, {
      sha, encoding: "base64", size: content.length, content: content.toString("base64"),
    }],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(new URL(url).origin, GITHUB_API_ORIGIN);
    assert.equal(new URL(url).search, "");
    assert.ok(documents.has(url), "only fixed repository endpoints may be requested");
    return jsonResponse(documents.get(url));
  };
  return { documents, calls, fetchImpl, sha };
}

const run = (request, s, options = {}) => importGitHubFile(request, {
  permission, fetchImpl: s.fetchImpl, now: clock, ...options,
});
const expectFailure = (result, code) => {
  assert.equal(result.status, "failure");
  assert.equal(Object.hasOwn(result, "output"), false);
  if (code) assert.equal(result.failure.code, code);
  assert.equal(validateGitHubImportResult(result), result);
};

let checks = 0;
async function check(name, operation) {
  try { await operation(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await check("fixed request, result and independent contract", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../../contracts/github-importer@0.1.schema.json", import.meta.url,
  ), "utf8"));
  assert.equal(validateGitHubImportRequest(fixedRequest), fixedRequest);
  assert.equal(validateGitHubImportResult(fixedResult, fixedRequest), fixedResult);
  assert.deepEqual(githubImportRequest({ runId: fixedRequest.runId, ...fixedRequest.input }), fixedRequest);
  assert.deepEqual(Object.keys(fixedRequest.input), schema.$defs.Input.required);
  assert.deepEqual(Object.keys(fixedResult.output), schema.$defs.Snapshot.required);
  assert.deepEqual(fixedResult.output.informationLoss, schema.$defs.Snapshot.properties.informationLoss.const);
  assert.equal(schema.$defs.Snapshot.properties.byteLength.maximum, GITHUB_IMPORT_LIMITS.maxFileBytes);
  assert.deepEqual(await run(fixedRequest, scenario()), fixedResult);
});

await check("nested binary and executable file without content retention", async () => {
  const content = Buffer.from([0, 255, 0xc3, 0x28, 10]);
  const s = scenario({ content, nested: true, mode: "100755" });
  const request = structuredClone(fixedRequest);
  request.input.locator = "directory/source.txt";
  const result = await run(request, s);
  assert.equal(result.status, "success");
  assert.equal(result.output.digest, `sha256:${createHash("sha256").update(content).digest("hex")}`);
  assert.equal(result.output.source.blobSha, blobSha(content));
  assert.equal(result.output.source.mode, "100755");
  assert.equal(result.output.byteLength, content.length);
  assert.equal(s.calls.length, 5);
  assert.equal(Object.hasOwn(result.output, "content"), false);
});

await check("reused response chunks preserve bytes across reads and UTF-8 boundaries", async () => {
  const content = Buffer.from([0, 255, 0xc3, 0x28, 10]);
  const baseline = await run(fixedRequest, scenario({ content }));
  assert.equal(baseline.status, "success");
  for (const kind of ["buffer", "uint8"]) {
    for (const width of [1, 7, 64]) {
      const s = scenario({ content });
      let calls = 0, cancels = 0;
      const bodies = [];
      const result = await run(fixedRequest, s, { fetchImpl: async url => {
        calls++;
        const encoded = Buffer.from(JSON.stringify({ ...s.documents.get(url), note: "日本語😀" }));
        const storage = kind === "buffer" ? Buffer.alloc(width + 8) : new Uint8Array(width + 8);
        let offset = 0;
        const stream = new ReadableStream({ pull(controller) {
          storage.fill(32);
          if (offset === encoded.length) { controller.close(); return; }
          const length = Math.min(width, encoded.length - offset);
          storage.set(encoded.subarray(offset, offset + length), 3);
          controller.enqueue(storage.subarray(3, 3 + length));
          offset += length;
        }, cancel() { cancels++; } }, { highWaterMark: 0 });
        bodies.push(stream);
        return new Response(stream, { headers: { "content-type": "application/json" } });
      } });
      assert.deepEqual(result, baseline, `${kind}/${width}`);
      assert.equal(result.output.digest, `sha256:${createHash("sha256").update(content).digest("hex")}`);
      assert.equal(calls, 4); assert.equal(cancels, 0);
      assert.ok(bodies.every(stream => !stream.locked));
    }
  }
});

await check("later chunk mutation cannot repair an already received wrong identity", async () => {
  const s = scenario();
  const original = s.documents.get(prefix);
  const invalid = Buffer.from(JSON.stringify({ ...original, id: 999 }));
  const replacement = Buffer.from(JSON.stringify(original));
  assert.equal(invalid.length, replacement.length);
  let calls = 0, read = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (read++ === 0) controller.enqueue(invalid);
    else { replacement.copy(invalid); controller.close(); }
  } }, { highWaterMark: 0 });
  expectFailure(await run(fixedRequest, s, { fetchImpl: async () => {
    calls++;
    return new Response(stream, { headers: { "content-type": "application/json" } });
  } }), "GITHUB_IMPORT_IDENTITY_MISMATCH");
  assert.equal(calls, 1); assert.equal(stream.locked, false);
});

await check("permission required and narrowed to exact repository and origin", async () => {
  for (const value of [undefined, null, [], {}, { ...permission, apiOrigin: "https://example.invalid" },
    { ...permission, owner: "another" }, { ...permission, repository: "another" },
    { ...permission, repositoryId: 124 }, { ...permission, wildcard: true }]) {
    const s = scenario();
    expectFailure(await run(fixedRequest, s, { permission: value }), "GITHUB_IMPORT_PERMISSION_DENIED");
    assert.equal(s.calls.length, 0);
  }
});

await check("malformed and mutable-ref inputs never make requests", async () => {
  const bad = [null, undefined, [], {}, { ...fixedRequest, input: [] }];
  for (const [field, values] of Object.entries({
    owner: ["", "../owner", "host/name", "owner?token=secret", ["owner"]],
    repository: ["..", "a/b", "x%2Fy", "x#fragment", null],
    repositoryId: [0, -1, "123", 1.5, Number.MAX_SAFE_INTEGER + 1],
    commit: ["main", "v1", "1".repeat(39), "A".repeat(40), ["1".repeat(40)]],
    locator: ["", "/source.txt", "../source.txt", "a/./b", "a//b", "a\\b", "a\0b", "a/".repeat(16) + "b", "a".repeat(1025)],
  })) for (const value of values) {
    const request = structuredClone(fixedRequest);
    request.input[field] = value;
    bad.push(request);
  }
  for (const request of bad) {
    const s = scenario();
    expectFailure(await run(request, s), "GITHUB_IMPORT_REQUEST_INVALID");
    assert.equal(s.calls.length, 0);
  }
});

await check("accessors are rejected without invocation", async () => {
  let called = false;
  const request = { ...fixedRequest };
  Object.defineProperty(request, "runId", { enumerable: true,
    get() { called = true; throw new Error("private-value"); } });
  const s = scenario();
  expectFailure(await run(request, s), "GITHUB_IMPORT_REQUEST_INVALID");
  assert.equal(called, false);
  assert.equal(s.calls.length, 0);
});

await check("caller mutation cannot change an authorized run", async () => {
  const request = structuredClone(fixedRequest);
  const s = scenario();
  const fetchImpl = async (...args) => {
    request.input.owner = "unauthorized";
    request.input.locator = "other.txt";
    return s.fetchImpl(...args);
  };
  assert.deepEqual(await run(request, s, { fetchImpl }), fixedResult);
});

await check("repository and commit identities must match", async () => {
  for (const [suffix, field, value] of [
    ["", "id", 124], ["", "full_name", "other/repository"],
    [`/git/commits/${fixedRequest.input.commit}`, "sha", "4".repeat(40)],
    [`/git/commits/${fixedRequest.input.commit}`, "tree", {}],
  ]) {
    const s = scenario(); s.documents.get(prefix + suffix)[field] = value;
    expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_IDENTITY_MISMATCH");
  }
});

await check("incomplete and ambiguous trees fail before blob retrieval", async () => {
  for (const change of [
    (t) => { t.truncated = true; }, (t) => { delete t.truncated; },
    (t) => { t.sha = "4".repeat(40); }, (t) => { t.tree = {}; },
    (t) => { t.tree.push({ ...t.tree[0] }); },
    (t) => { t.tree[0].sha = "main"; }, (t) => { t.tree[0].path = "directory/source.txt"; },
  ]) {
    const s = scenario(); change(s.documents.get(`${prefix}/git/trees/${ROOT_TREE}`));
    expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_TREE_INVALID");
    assert.equal(s.calls.length, 3);
  }
});

await check("missing target is not inferred from an HTTP failure", async () => {
  const s = scenario(); s.documents.get(`${prefix}/git/trees/${ROOT_TREE}`).tree = [];
  expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_TARGET_MISSING");
  expectFailure(await run(fixedRequest, scenario(), {
    fetchImpl: async () => jsonResponse({ message: "private missing repository" }, { status: 404 }),
  }), "GITHUB_IMPORT_SOURCE_UNAVAILABLE");
});

await check("links submodules and directories are not ordinary files", async () => {
  for (const [type, mode] of [["blob", "120000"], ["commit", "160000"], ["tree", "040000"], ["blob", "100600"]]) {
    const s = scenario(); Object.assign(s.documents.get(`${prefix}/git/trees/${ROOT_TREE}`).tree[0], { type, mode });
    expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_KIND_UNSUPPORTED");
    assert.equal(s.calls.length, 3);
  }
  const s = scenario({ nested: true }); s.documents.get(`${prefix}/git/trees/${ROOT_TREE}`).tree[0].mode = "120000";
  const request = structuredClone(fixedRequest); request.input.locator = "directory/source.txt";
  expectFailure(await run(request, s), "GITHUB_IMPORT_KIND_UNSUPPORTED");
});

await check("blob encoding size and hash are checked", async () => {
  for (const change of [
    (b) => { b.sha = "4".repeat(40); }, (b) => { b.encoding = "utf-8"; },
    (b) => { b.size = "0"; }, (b) => { b.size = 1; },
    (b) => { b.content = "===="; }, (b) => { b.content = "\t"; },
    (b) => { b.content = [""]; }, (b) => { b.content = "YQ=="; },
  ]) {
    const s = scenario(); change(s.documents.get(`${prefix}/git/blobs/${s.sha}`));
    expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_BLOB_INVALID");
  }
  const s = scenario({ content: Buffer.from("a") });
  s.documents.get(`${prefix}/git/blobs/${s.sha}`).content = "Yg==";
  expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_DIGEST_MISMATCH");
});

await check("canonical base64 permits GitHub line wrapping only", async () => {
  const s = scenario({ content: Buffer.from("ab") });
  const blob = s.documents.get(`${prefix}/git/blobs/${s.sha}`);
  blob.content = "YW\r\nI=\n";
  assert.equal((await run(fixedRequest, s)).status, "success");
  blob.content = "YWJ=";
  expectFailure(await run(fixedRequest, s), "GITHUB_IMPORT_BLOB_INVALID");
});

await check("redirects cannot forward credentials", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    expectFailure(await run(fixedRequest, scenario(), {
      token: "fixture-secret",
      fetchImpl: async (_, options) => {
        calls += 1; assert.equal(options.redirect, "manual");
        return jsonResponse({}, { status, headers: { location: "https://example.invalid/collect" } });
      },
    }), "GITHUB_IMPORT_REDIRECT_DENIED");
    assert.equal(calls, 1);
  }
  const response = jsonResponse({});
  Object.defineProperty(response, "url", { value: "https://example.invalid" });
  expectFailure(await run(fixedRequest, scenario(), { fetchImpl: async () => response }), "GITHUB_IMPORT_REDIRECT_DENIED");
});

await check("HTTP failures malformed JSON and foreign errors omit raw values", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("fixture-secret response body /private/path"); },
    async () => jsonResponse({ message: "fixture-secret" }, { status: 403 }),
    async () => new Response("fixture-secret", { headers: { "content-type": "application/json" } }),
    async () => new Response("fixture-secret", { headers: { "content-type": "text/html" } }),
    async () => jsonResponse([]),
    async () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
  ]) {
    const result = await run(fixedRequest, scenario(), { fetchImpl });
    expectFailure(result); assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(result).includes("/private/path"), false);
  }
});

await check("authentication is explicit and never retained", async () => {
  const s = scenario();
  const result = await run(fixedRequest, s, { token: "fixture-secret" });
  assert.equal(result.status, "success");
  assert.ok(s.calls.every(({ options }) => options.headers.Authorization === "Bearer fixture-secret"));
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  const anonymous = scenario(); await run(fixedRequest, anonymous);
  assert.ok(anonymous.calls.every(({ options }) => !Object.hasOwn(options.headers, "Authorization")));
  for (const token of ["", "a\nb", "a b", null, ["a"], "a".repeat(8193)]) {
    const invalid = scenario();
    expectFailure(await run(fixedRequest, invalid, { token }), "GITHUB_IMPORT_OPTIONS_INVALID");
    assert.equal(invalid.calls.length, 0);
  }
});

await check("limits cannot be relaxed or malformed", async () => {
  for (const limits of [null, [], { extra: 1 }, { timeoutMs: 0 }, { timeoutMs: "1" },
    { maxRequests: 20 }, { maxFileBytes: -1 }, { maxResponseBytes: 1.5 }]) {
    const s = scenario(); expectFailure(await run(fixedRequest, s, { limits }), "GITHUB_IMPORT_LIMITS_INVALID");
    assert.equal(s.calls.length, 0);
  }
});

await check("response bytes total bytes requests and file bytes are bounded", async () => {
  expectFailure(await run(fixedRequest, scenario(), { limits: { maxResponseBytes: 10 } }), "GITHUB_IMPORT_RESPONSE_LIMIT");
  expectFailure(await run(fixedRequest, scenario(), { limits: { maxTotalResponseBytes: 150 } }), "GITHUB_IMPORT_RESPONSE_LIMIT");
  const s = scenario();
  expectFailure(await run(fixedRequest, s, { limits: { maxRequests: 2 } }), "GITHUB_IMPORT_REQUEST_LIMIT");
  assert.equal(s.calls.length, 2);
  const large = scenario({ content: Buffer.from("ab") });
  expectFailure(await run(fixedRequest, large, { limits: { maxFileBytes: 1 } }), "GITHUB_IMPORT_FILE_LIMIT");
  assert.equal(large.calls.length, 3);
  expectFailure(await run(fixedRequest, scenario(), { fetchImpl: async () =>
    jsonResponse({}, { headers: { "content-type": "application/json", "content-length": "9999999" } }),
  }), "GITHUB_IMPORT_RESPONSE_LIMIT");
});

await check("global timeout includes a fetch that ignores cancellation", async () => {
  let signal;
  const started = performance.now();
  expectFailure(await run(fixedRequest, scenario(), { limits: { timeoutMs: 20 },
    fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); },
  }), "GITHUB_IMPORT_TIMEOUT");
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - started < 2000);
});

await check("global timeout includes body reads and stops further requests", async () => {
  for (const finish of [() => undefined, () => Promise.reject(new Error("private cleanup failure")), () => new Promise(() => {})]) {
    let calls = 0, cancels = 0, signal;
    const body = new ReadableStream({ cancel() { cancels++; return finish(); } });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    const started = performance.now();
    const result = await run(fixedRequest, scenario(), { limits: { timeoutMs: 20 },
      fetchImpl: async (_, options) => { calls++; signal = options.signal; return response; } });
    expectFailure(result, "GITHUB_IMPORT_TIMEOUT");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancels, 1);
    assert.equal(body.locked, false);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(calls, 1);
    assert.ok(performance.now() - started < 2000);
    assert.equal(JSON.stringify(result).includes("private cleanup failure"), false);
  }
});

await check("completed response readers release locks and abort listeners without cancellation", async () => {
  const s = scenario(), bodies = []; let cancels = 0, signal;
  const result = await run(fixedRequest, s, { fetchImpl: async (url, options) => {
    signal = options.signal;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(s.documents.get(url)))); controller.close();
    }, cancel() { cancels++; } });
    bodies.push(body); return new Response(body, { headers: { "content-type": "application/json" } });
  } });
  assert.equal(result.status, "success");
  assert.equal(bodies.length, 4);
  assert.equal(cancels, 0);
  assert.ok(bodies.every(body => !body.locked));
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

await check("response byte overflow cancels and unlocks before another request", async () => {
  let calls = 0, cancels = 0, signal;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancels++; } });
  expectFailure(await run(fixedRequest, scenario(), { limits: { maxResponseBytes: 10 },
    fetchImpl: async (_, options) => { calls++; signal = options.signal; return new Response(body, { headers: { "content-type": "application/json" } }); },
  }), "GITHUB_IMPORT_RESPONSE_LIMIT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancels, 1);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal(calls, 1);
});

await check("unread rejected responses are cancelled without replacing their failure", async () => {
  for (const mode of ["complete", "reject", "pending"]) {
    for (const [init, properties, code] of [
      [{ status: 403 }, {}, "SOURCE_UNAVAILABLE"],
      [{ status: 302 }, {}, "REDIRECT_DENIED"],
      [{}, { redirected: true }, "REDIRECT_DENIED"],
      [{}, { url: "https://invalid.example.test" }, "REDIRECT_DENIED"],
      [{ headers: { "content-type": "text/plain" } }, {}, "RESPONSE_INVALID"],
      [{ headers: { "content-type": "application/json", "content-length": "invalid" } }, {}, "RESPONSE_LIMIT"],
      [{ headers: { "content-type": "application/json", "content-length": "2097153" } }, {}, "RESPONSE_LIMIT"],
    ]) {
      let cancels = 0, reads = 0, calls = 0;
      const stream = new ReadableStream({ pull() { reads++; }, cancel() {
        cancels++;
        if (mode === "reject") return Promise.reject(new Error("PRIVATE_PROVIDER"));
        if (mode === "pending") return new Promise(() => {});
      } }, { highWaterMark: 0 });
      const response = new Response(stream, { headers: { "content-type": "application/json" }, ...init });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
      const result = await run(fixedRequest, scenario(), { limits: { timeoutMs: 100 },
        fetchImpl: async () => { calls++; return response; },
      });
      expectFailure(result, `GITHUB_IMPORT_${code}`);
      assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER"), false);
      assert.equal(cancels, 1); assert.equal(reads, 0); assert.equal(calls, 1);
      assert.equal(stream.locked, false);
    }
  }
});

await check("responses arriving after timeout are cancelled before reading", async () => {
  let deliver, cancels = 0, reads = 0, calls = 0;
  const stream = new ReadableStream({ pull() { reads++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const result = await run(fixedRequest, scenario(), { limits: { timeoutMs: 10 },
    fetchImpl: () => { calls++; return new Promise(resolve => { deliver = resolve; }); },
  });
  expectFailure(result, "GITHUB_IMPORT_TIMEOUT");
  deliver(new Response(stream, { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancels, 1); assert.equal(reads, 0); assert.equal(calls, 1);
  assert.equal(stream.locked, false);
});

await check("result identities dates types and information loss are strict", async () => {
  for (const mutate of [
    (r) => { r.output.byteLength = "0"; }, (r) => { r.output.digest = [r.output.digest]; },
    (r) => { r.output.retrievedAt = "2026-02-31T15:00:00Z"; },
    (r) => { r.output.retrievedAt = [r.output.retrievedAt]; },
    (r) => { r.output.externalIdentity.externalId = "another"; },
    (r) => { r.output.source.apiOrigin = "https://example.invalid"; },
    (r) => { r.output.informationLoss = []; }, (r) => { r.output.extra = "value"; },
  ]) {
    const result = structuredClone(fixedResult); mutate(result);
    assert.throws(() => validateGitHubImportResult(result, fixedRequest));
  }
  const mismatch = structuredClone(fixedResult); mismatch.output.source.commit = "4".repeat(40);
  assert.throws(() => validateGitHubImportResult(mismatch, fixedRequest),
    (error) => error.code === "GITHUB_IMPORT_RESULT_MISMATCH");
  expectFailure(await run(fixedRequest, scenario(), { now: () => "2026-02-31T15:00:00Z" }), "GITHUB_IMPORT_RESULT_INVALID");
});

await check("maximum supported file remains readable", async () => {
  const content = Buffer.alloc(GITHUB_IMPORT_LIMITS.maxFileBytes, 65);
  const result = await run(fixedRequest, scenario({ content }));
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.output.byteLength, content.length);
});

await check("machine-readable locator and input bounds agree with implementation", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../../contracts/github-importer@0.1.schema.json", import.meta.url,
  ), "utf8"));
  for (const [key, rule] of Object.entries(schema.$defs.Input.properties)) {
    const samples = key === "locator"
      ? ["file.txt", "a/b", ".hidden", "...", "dir/a b.txt", "日本語.txt", "", "/a", "a/", "a//b",
        ".", "..", "a/./b", "a/../b", "a\\b", "a\nb", "a\0b", "x/".repeat(16) + "x", "a".repeat(1025),
        "😀".repeat(1024), "😀".repeat(1025)]
      : [fixedRequest.input[key], null, [], {}, true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "main", "../", "a/b"];
    for (const value of samples) {
      const validType = rule.type === "integer" ? Number.isSafeInteger(value) : typeof value === "string";
      const schemaAccepts = validType &&
        (rule.minimum === undefined || value >= rule.minimum) &&
        (rule.maximum === undefined || value <= rule.maximum) &&
        (rule.minLength === undefined || [...value].length >= rule.minLength) &&
        (rule.maxLength === undefined || [...value].length <= rule.maxLength) &&
        (rule.pattern === undefined || new RegExp(rule.pattern, "u").test(value));
      const request = structuredClone(fixedRequest); request.input[key] = value;
      let accepted = false;
      try { validateGitHubImportRequest(request); accepted = true; } catch { /* Expected negative fixture. */ }
      assert.equal(accepted, schemaAccepts, `${key}: ${JSON.stringify(value)}`);
    }
  }
});

assert.equal(checks, 28);
console.log(`GitHub importer contract audit passed: ${checks} checks.`);
