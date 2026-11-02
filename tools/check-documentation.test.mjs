import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditDocumentation, inlineDestinations } from "./check-documentation.mjs";

const document = text => `---\ntype: Tutorial\n---\n\n${text}\n`;
// This checker inspects PNG headers only; these bytes are not a rendered image.
function pngHeader(width = 1200, height = 2400) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
async function fixture(callback) {
  const temporary = await mkdtemp(join(tmpdir(), "morivyx-documentation-check-"));
  const root = join(temporary, "repository");
  await mkdir(join(root, "docs/diagrams"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const save = async (path, text) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const track = () => execFileSync("git", ["add", "."], { cwd: root });
  try {
    await save("README.md", document("[文書](docs/guide.md)\n![図](docs/diagrams/flow.png)"));
    await save("docs/guide.md", document("# 読取\n[入口](../README.md)"));
    await save("docs/diagrams/flow.mmd", "flowchart TB\n A-->B\n");
    await save("docs/diagrams/flow.png", pngHeader());
    track();
    await callback({ root, temporary, save, track });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const codes = result => result.findings.map(finding => finding.code);

test("tracked documents and diagram headers pass without needing a committed HEAD", async () => {
  await fixture(async ({ root }) => {
    const result = auditDocumentation(root);
    assert.equal(result.valid, true);
    assert.equal(result.markdownFiles, 2);
    assert.equal(result.typedMarkdown, 2);
    assert.equal(result.relativeReferences, 3);
    assert.equal(result.diagramSources, 1);
    assert.equal(result.pngHeaders, 1);
  });
});

test("code examples are skipped and inline destinations handle titles, parentheses and spaces", () => {
  const text = [
    "[a](docs/file(a).md)", '[b](<docs/with spaces.md> "title")',
    "[c](docs/file\\(a\\).md 'title')", "[d](docs/a.md (title))",
    "`[inline](missing.md)`", "``[double](missing.md)``",
    "```sh", "[fenced](missing.md)", "```",
    "~~~", "![tilde](missing.png)", "~~~", "    [indented](missing.md)",
    "plain ](not-a-link.md)", "\\[escaped](not-a-link.md)",
    "``a ` [nested](missing.md) ` b``",
    "[not-a-link]`span`(missing.md)",
  ].join("\n");
  assert.deepEqual(inlineDestinations(text), ["docs/file(a).md", "docs/with spaces.md", "docs/file(a).md", "docs/a.md"]);
  assert.throws(() => inlineDestinations("[bad](<unfinished.md)"), /MARKDOWN_LINK_INVALID/);
  assert.throws(() => inlineDestinations('[bad](a.md "unfinished)'), /MARKDOWN_LINK_INVALID/);
});

test("reserved index and log files do not require ordinary frontmatter", async () => {
  await fixture(async ({ root, save, track }) => {
    await save("docs/index.md", "# Index\n[guide](guide.md)\n");
    await save("docs/log.md", "# Log\n");
    track();
    const result = auditDocumentation(root);
    assert.equal(result.valid, true);
    assert.equal(result.markdownFiles, 4);
    assert.equal(result.typedMarkdown, 2);
  });
});

test("malformed, duplicate, missing and non-string frontmatter types fail", async () => {
  await fixture(async ({ root, save }) => {
    for (const header of ["type: [", "type: Tutorial\ntype: Reference", 'type: ""', "type: 42", "title: Missing", "- Tutorial"]) {
      await save("docs/guide.md", `---\n${header}\n---\n# Guide\n`);
      const result = auditDocumentation(root);
      assert.equal(result.valid, false, header);
      assert(codes(result).includes("MARKDOWN_FRONTMATTER_INVALID"), header);
    }
    await save("docs/guide.md", "# No frontmatter\n");
    assert(codes(auditDocumentation(root)).includes("MARKDOWN_FRONTMATTER_INVALID"));
  });
});

test("an existing but untracked target fails and a tracked missing target also fails", async () => {
  await fixture(async ({ root, save, track }) => {
    await save("docs/local.md", document("# Local"));
    await save("README.md", document("[local](docs/local.md)"));
    assert(codes(auditDocumentation(root)).includes("REFERENCE_NOT_TRACKED"));
    track();
    assert.equal(auditDocumentation(root).valid, true);
    await rm(join(root, "docs/local.md"));
    assert(codes(auditDocumentation(root)).includes("REFERENCE_UNAVAILABLE"));
  });
});

test("relative paths cannot escape the repository, including encoded paths and tracked symlinks", async () => {
  await fixture(async ({ root, temporary, save, track }) => {
    await writeFile(join(temporary, "outside.txt"), "synthetic outside file\n");
    for (const target of ["../outside.txt", "%2e%2e/outside.txt", join(temporary, "outside.txt")]) {
      await save("README.md", document(`[outside](${target})`));
      assert(codes(auditDocumentation(root)).includes("REFERENCE_OUTSIDE_REPOSITORY"), target);
    }
    await symlink(join(temporary, "outside.txt"), join(root, "outside-link.txt"));
    await save("README.md", document("[outside](outside-link.txt)"));
    track();
    assert(codes(auditDocumentation(root)).includes("REFERENCE_OUTSIDE_REPOSITORY"));
  });
});

test("encoded local paths and tracked directory targets pass, while fragments and external URLs are reported as skipped", async () => {
  await fixture(async ({ root, save, track }) => {
    await save("docs/with spaces.md", document("# Space"));
    await save("README.md", document('[space](docs/with%20spaces.md)\n[root](.)\n[dir](docs/)\n[anchor](docs/guide.md#not-checked)\n[self](#not-checked)\n[web](https://example.invalid/missing)'));
    track();
    const result = auditDocumentation(root);
    assert.equal(result.valid, true, JSON.stringify(result.findings));
    assert.equal(result.fragmentsSkipped, 2);
    assert.equal(result.externalReferencesSkipped, 1);
  });
});

test("a source without a tracked PNG and a PNG without a tracked source both fail", async () => {
  await fixture(async ({ root, save, track }) => {
    await save("docs/diagrams/extra.mmd", "flowchart TB\n A-->B\n");
    track();
    assert(codes(auditDocumentation(root)).includes("DIAGRAM_PNG_NOT_TRACKED"));
    await save("docs/diagrams/extra.png", pngHeader());
    track();
    assert.equal(auditDocumentation(root).valid, true);
    await rm(join(root, "docs/diagrams/extra.mmd"));
    assert(codes(auditDocumentation(root)).includes("DIAGRAM_SOURCE_UNAVAILABLE"));
    execFileSync("git", ["rm", "--cached", "--", "docs/diagrams/extra.mmd"], { cwd: root });
    assert(codes(auditDocumentation(root)).includes("DIAGRAM_SOURCE_NOT_TRACKED"));
  });
});

test("PNG signature, header length and both dimension boundaries are checked", async () => {
  await fixture(async ({ root, save }) => {
    for (const bytes of [Buffer.from("not a PNG"), Buffer.alloc(33), pngHeader().subarray(0, 24)]) {
      await save("docs/diagrams/flow.png", bytes);
      assert(codes(auditDocumentation(root)).includes("PNG_HEADER_INVALID"));
    }
    for (const [width, height] of [[1199, 2400], [2400, 1199], [0, 2400]]) {
      await save("docs/diagrams/flow.png", pngHeader(width, height));
      assert(codes(auditDocumentation(root)).includes("DIAGRAM_TOO_SMALL"));
    }
    await save("docs/diagrams/flow.png", pngHeader(1200, 1200));
    assert.equal(auditDocumentation(root).valid, true);
  });
});
