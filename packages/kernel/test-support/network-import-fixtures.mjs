import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkDigest, networkJsonDigest } from "../src/network-import-input.js";

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const figma = await json("../test/fixtures/figma-importer/request.json");
const github = await json("../test/fixtures/github-importer/request.json");
const response = await json("../test/fixtures/figma-importer/response.json");
const template = await json("../test/fixtures/figma-importer/manifest.json");
export const FIXTURE_TOKEN = "HOST_ONLY_FIXTURE_CREDENTIAL";
export const FIXTURE_TIME = "2026-09-09T07:00:00.000Z";
const clone = structuredClone;
export function fixturePolicy(manifest) {
  const { id, version, packageDigest } = manifest.identity;
  const capability = manifest.capabilities[0];
  return { format: "morivyx.plugin-host-policy/0.1", plugin: { id, version, packageDigest },
    capability: { id: capability.id, effect: capability.effect, permissions: clone(capability.permissions), resources: clone(capability.resources) } };
}
export function networkFixture({ provider, packageBytes, imageId, changed = false }) {
  const isGitHub = provider === "github";
  if (!isGitHub && provider !== "figma") throw new Error("FIXTURE_PROVIDER_INVALID");
  const request = clone(isGitHub ? github : figma), host = clone(template);
  request.runId = `run:network-live-${provider}-${changed ? "updated" : "initial"}`;
  if (changed) {
    if (isGitHub) request.input.commit = "3".repeat(40); else request.input.version = "1002";
  }
  Object.assign(host.identity, request.plugin, { packageDigest: networkDigest(packageBytes) });
  const capability = host.capabilities[0]; capability.id = request.capability.id;
  capability.inputFormat = isGitHub ? "morivyx.github-read-input/0.1" : "morivyx.figma-node-input/0.1";
  capability.outputFormat = isGitHub ? "morivyx.github-file-snapshot/0.1" : "morivyx.figma-node-snapshot/0.1";
  capability.permissions.network = [`https://api.${provider}.com`]; capability.permissions.secrets = [`${provider}-read-token`];
  const manifest = clone(host);
  manifest.capabilities[0].permissions.network = []; manifest.capabilities[0].permissions.secrets = [];
  manifest.capabilities[0].permissions.fileRead = ["network-import-input"];
  const input = { request, acquisition: { manifest: host, policy: fixturePolicy(host), permission: isGitHub ?
    { apiOrigin: "https://api.github.com", owner: request.input.owner, repository: request.input.repository, repositoryId: request.input.repositoryId } :
    { apiOrigin: "https://api.figma.com", fileKey: request.input.fileKey },
  credential: isGitHub ? { token: FIXTURE_TOKEN } : { kind: "oauth", token: FIXTURE_TOKEN } },
  execution: { manifest, policy: fixturePolicy(manifest), imageId, artifacts: { package: Buffer.from(packageBytes) } } };
  const runtimeBinding = { imageId, packageDigest: manifest.identity.packageDigest, manifestDigest: networkJsonDigest(manifest) };
  const documents = new Map();
  if (isGitHub) {
    const bytes = Buffer.from(changed ? "PRIVATE_SOURCE_UPDATED\n" : "PRIVATE_SOURCE_INITIAL\n"), tree = "2".repeat(40);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const prefix = "/repos/fixture-owner/fixture-repository";
    documents.set(prefix, { id: 123, full_name: "fixture-owner/fixture-repository" });
    documents.set(`${prefix}/git/commits/${request.input.commit}`, { sha: request.input.commit, tree: { sha: tree } });
    documents.set(`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false,
      tree: [{ path: "source.txt", type: "blob", mode: "100644", sha: blob, size: bytes.length }] });
    documents.set(`${prefix}/git/blobs/${blob}`, { sha: blob, size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
  } else {
    const value = clone(response); value.version = request.input.version;
    if (changed) value.nodes["1:2"].document.absoluteBoundingBox.width = 123;
    documents.set(`/v1/files/fixtureFile/nodes?ids=1%3A2&version=${request.input.version}`, value);
  }
  return { input, runtimeBinding, documents, provider };
}
