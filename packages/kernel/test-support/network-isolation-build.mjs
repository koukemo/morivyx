import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const dockerPath = "/usr/bin/docker";
export const runCommand = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", timeout: 60000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"], ...options,
}).trim();
export const dockerCommand = (root, args) => runCommand(dockerPath,
  ["--host", "unix:///var/run/docker.sock", "--config", join(root, "docker-config"), ...args],
  { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
export async function fileTree(root) {
  const entries = [];
  for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isDirectory()) for (const [path, digest] of await fileTree(join(root, item.name))) entries.push([`${item.name}/${path}`, digest]);
    else {
      assert.equal(item.isFile(), true, "runtime package contains a non-regular file");
      entries.push([item.name, createHash("sha256").update(await readFile(join(root, item.name))).digest("hex")]);
    }
  }
  return entries;
}

// Build only from the installed Node runtime, its local shared libraries, the packed Kernel,
// and the already installed dependency. No base-image pull, build network, or ambient host directory copy.
export async function prepareRuntime(root) {
  assert.equal(process.platform, "linux", "runtime construction requires Linux");
  const build = join(root, "build"), runtime = join(build, "runtime"), app = join(runtime, "app");
  await mkdir(join(root, "docker-config"), { mode: 0o700 });
  await mkdir(app, { recursive: true, mode: 0o755 });
  await mkdir(join(runtime, "usr/bin"), { recursive: true, mode: 0o755 });
  await copyFile(process.execPath, join(runtime, "usr/bin/node"));
  const linked = runCommand("ldd", [process.execPath]);
  const libraries = [...new Set(linked.match(/\/[^\s()]+/g) ?? [])];
  assert.ok(libraries.length > 0 && !linked.includes("not found"), "all Node shared libraries must be available");
  for (const path of libraries) {
    const destination = join(runtime, path.slice(1)); await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(path, destination);
  }
  const kernel = fileURLToPath(new URL("../", import.meta.url));
  const packed = JSON.parse(runCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: kernel }));
  assert.equal(packed.length, 1); const name = packed[0].filename;
  assert.equal(basename(name), name); assert.match(name, /^[A-Za-z0-9._-]+\.tgz$/);
  const archive = join(root, name), packageBytes = await readFile(archive);
  assert.ok(packageBytes.length <= 16777216);
  runCommand("tar", ["-xzf", archive, "-C", app]);
  await mkdir(join(app, "node_modules"));
  await cp(join(kernel, "node_modules/yaml"), join(app, "node_modules/yaml"), { recursive: true });
  await mkdir(join(runtime, "audit"));
  await copyFile(new URL("./network-isolation-probe.mjs", import.meta.url), join(runtime, "audit/probe.mjs"));
  const sourceTree = await fileTree(join(app, "package"));
  const dependencyTree = await fileTree(join(app, "node_modules/yaml"));
  const sourceDigest = createHash("sha256").update(JSON.stringify(sourceTree)).digest("hex");
  const dependencyDigest = createHash("sha256").update(JSON.stringify(dependencyTree)).digest("hex");
  return { build, packageBytes, sourceTree, dependencyTree, sourceDigest, dependencyDigest, libraries: libraries.length };
}

export async function buildRuntimeImage(prepared, root, tag, mode, images) {
  assert.ok(["normal", "inspect", "linger", "output"].includes(mode));
  const entrypoint = mode === "normal" ? ["/usr/bin/node", "/app/package/src/network-import-stdio.js"] :
    ["/usr/bin/node", "/audit/probe.mjs", mode];
  const dockerfile = join(prepared.build, `Dockerfile.${mode}`);
  await writeFile(dockerfile, `FROM scratch\nCOPY runtime /\nUSER 65534:65534\nENTRYPOINT ${JSON.stringify(entrypoint)}\n`);
  dockerCommand(root, ["build", "--pull=false", "--network=none", "--label", `morivyx.audit=${tag}`, "--tag", tag, "--file", dockerfile, prepared.build]);
  images.push(tag);
  const imageId = dockerCommand(root, ["image", "inspect", tag, "--format", "{{.Id}}"]);
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/);
  // Copy from a never-started container: the image's entrypoint cannot manufacture verification output.
  const container = dockerCommand(root, ["container", "create", "--network=none", "--read-only", imageId]);
  assert.match(container, /^[0-9a-f]{64}$/);
  const verified = join(root, `verified-${mode}`), dependencies = join(root, `dependencies-${mode}`);
  try {
    dockerCommand(root, ["container", "cp", `${container}:/app/package`, verified]);
    dockerCommand(root, ["container", "cp", `${container}:/app/node_modules/yaml`, dependencies]);
    assert.deepEqual(await fileTree(verified), prepared.sourceTree, "installed package differs from packed source");
    assert.deepEqual(await fileTree(dependencies), prepared.dependencyTree, "installed dependency differs from verified host dependency");
    const actual = JSON.parse(dockerCommand(root, ["image", "inspect", imageId, "--format", "{{json .Config.Entrypoint}}"]));
    assert.deepEqual(actual, entrypoint);
  } finally {
    dockerCommand(root, ["container", "rm", "--force", "--volumes", container]);
    await rm(verified, { recursive: true, force: true }); await rm(dependencies, { recursive: true, force: true });
  }
  return { imageId, entrypoint };
}
