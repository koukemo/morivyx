import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { isMap, parseDocument } = createRequire(new URL("../packages/kernel/package.json", import.meta.url))("yaml");
const unescape = text => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
function escapedAt(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === "\\") count++;
  return count % 2 === 1;
}

function withoutInlineCode(text) {
  const runs = [...text.matchAll(/`+/g)];
  let cursor = 0;
  let result = "";
  for (let index = 0; index < runs.length; index++) {
    if (escapedAt(text, runs[index].index)) continue;
    const closing = runs.findIndex((run, other) => other > index && run[0].length === runs[index][0].length);
    if (closing === -1) continue;
    result += text.slice(cursor, runs[index].index) + " ";
    cursor = runs[closing].index + runs[closing][0].length;
    index = closing;
  }
  return result + text.slice(cursor);
}

// Inspect inline Markdown destinations, not a complete Markdown rendering.
function prose(text) {
  let fence = null;
  const lines = text.split(/\r?\n/).map(line => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`).test(line)) fence = null;
      return "";
    }
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      fence = { character: match[1][0], length: match[1].length };
      return "";
    }
    if (/^(?: {4}|\t)/.test(line)) return "";
    return line;
  });
  return withoutInlineCode(lines.join("\n"));
}

export function inlineDestinations(text) {
  const input = prose(text);
  const destinations = [];
  let from = 0;
  while (true) {
    const start = input.indexOf("](", from);
    if (start === -1) return destinations;
    const opening = input.lastIndexOf("[", start);
    const previous = from;
    from = start + 2;
    if (opening < previous || escapedAt(input, opening) || escapedAt(input, start)) continue;
    let cursor = from;
    while (/\s/.test(input[cursor] ?? "") && cursor < input.length) cursor++;
    let target = "";
    if (input[cursor] === "<") {
      cursor++;
      const begin = cursor;
      while (cursor < input.length && input[cursor] !== ">") cursor++;
      if (cursor === input.length) throw new Error("MARKDOWN_LINK_INVALID");
      target = input.slice(begin, cursor++);
    } else {
      let depth = 0;
      while (cursor < input.length) {
        const character = input[cursor];
        if (character === "\\" && cursor + 1 < input.length) {
          target += input.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if ((character === ")" && depth === 0) || /\s/.test(character)) break;
        if (character === "(") depth++;
        if (character === ")") depth--;
        target += character;
        cursor++;
      }
      if (depth !== 0) throw new Error("MARKDOWN_LINK_INVALID");
    }
    while (cursor < input.length && /\s/.test(input[cursor])) cursor++;
    if (["\"", "'", "("].includes(input[cursor])) {
      const closing = input[cursor] === "(" ? ")" : input[cursor];
      cursor++;
      while (cursor < input.length && input[cursor] !== closing) {
        cursor += input[cursor] === "\\" ? 2 : 1;
      }
      if (input[cursor++] !== closing) throw new Error("MARKDOWN_LINK_INVALID");
      while (cursor < input.length && /\s/.test(input[cursor])) cursor++;
    }
    if (input[cursor] !== ")") throw new Error("MARKDOWN_LINK_INVALID");
    destinations.push(unescape(target));
    from = cursor + 1;
  }
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

export function auditDocumentation(directory) {
  const root = realpathSync(directory);
  const paths = [...new Set(execFileSync("git", ["ls-files", "-z"], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).split("\0").filter(Boolean))];
  const tracked = new Set(paths);
  const trackedTarget = path => path === "" || tracked.has(path) || paths.some(value => value.startsWith(`${path}/`));
  const findings = [];
  const result = { valid: false, markdownFiles: 0, typedMarkdown: 0, relativeReferences: 0,
    externalReferencesSkipped: 0, fragmentsSkipped: 0, diagramSources: 0, pngHeaders: 0, findings };
  const report = (path, code, target) => findings.push({ path, code, ...(target === undefined ? {} : { target }) });
  for (const path of paths.filter(value => /\.md$/i.test(value))) {
    result.markdownFiles++;
    let text;
    try {
      if (!inside(root, realpathSync(resolve(root, path)))) throw new Error();
      text = readFileSync(resolve(root, path), "utf8");
    } catch {
      report(path, "MARKDOWN_FILE_UNAVAILABLE");
      continue;
    }
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!/(?:^|\/)(?:index|log)\.md$/.test(path)) {
      try {
        if (!header) throw new Error();
        const document = parseDocument(header[1], { prettyErrors: false, uniqueKeys: true });
        const type = document.get("type");
        if (document.errors.length || document.warnings.length || !isMap(document.contents)
          || typeof type !== "string" || !type.trim()) throw new Error();
        result.typedMarkdown++;
      } catch {
        report(path, "MARKDOWN_FRONTMATTER_INVALID");
      }
    }
    let destinations;
    try {
      destinations = inlineDestinations(header ? text.slice(header[0].length) : text);
    } catch {
      report(path, "MARKDOWN_LINK_INVALID");
      continue;
    }
    for (const destination of destinations) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("//")) {
        result.externalReferencesSkipped++;
        continue;
      }
      if (destination.includes("#")) result.fragmentsSkipped++;
      const rawPath = destination.split(/[?#]/, 1)[0];
      if (!rawPath) continue;
      result.relativeReferences++;
      let target;
      try {
        target = decodeURIComponent(rawPath);
        const absolute = resolve(dirname(resolve(root, path)), target);
        if (isAbsolute(target) || !inside(root, absolute)) {
          report(path, "REFERENCE_OUTSIDE_REPOSITORY", destination);
          continue;
        }
        const relativePath = relative(root, absolute).split(sep).join("/");
        if (!trackedTarget(relativePath)) {
          report(path, "REFERENCE_NOT_TRACKED", destination);
          continue;
        }
        if (!inside(root, realpathSync(absolute))) {
          report(path, "REFERENCE_OUTSIDE_REPOSITORY", destination);
          continue;
        }
        const information = statSync(absolute);
        if (!information.isFile() && !information.isDirectory()) throw new Error();
      } catch {
        report(path, "REFERENCE_UNAVAILABLE", destination);
      }
    }
  }
  for (const path of paths.filter(value => value.startsWith("docs/diagrams/"))) {
    if (/\.(?:mmd|puml)$/.test(path)) {
      result.diagramSources++;
      try {
        if (!inside(root, realpathSync(resolve(root, path))) || !statSync(resolve(root, path)).isFile()) throw new Error();
      } catch {
        report(path, "DIAGRAM_SOURCE_UNAVAILABLE");
      }
      const png = path.replace(/\.(?:mmd|puml)$/, ".png");
      if (!tracked.has(png)) report(path, "DIAGRAM_PNG_NOT_TRACKED", png);
    }
    if (!path.endsWith(".png")) continue;
    result.pngHeaders++;
    if (![".mmd", ".puml"].some(extension => tracked.has(path.slice(0, -4) + extension))) {
      report(path, "DIAGRAM_SOURCE_NOT_TRACKED");
    }
    try {
      if (!inside(root, realpathSync(resolve(root, path)))) throw new Error();
      const bytes = readFileSync(resolve(root, path));
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error();
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (Math.min(width, height) < 1200) report(path, "DIAGRAM_TOO_SMALL");
    } catch {
      report(path, "PNG_HEADER_INVALID");
    }
  }
  result.valid = findings.length === 0;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = auditDocumentation(fileURLToPath(new URL("../", import.meta.url)));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch {
    console.error("DOCUMENTATION_CHECK_FAILED: Gitと導入済みの依存を確認してください。");
    process.exitCode = 1;
  }
}
