export function yamlSequenceSpacingCases() {
  const rows = [];
  for (const rootIndent of [0, 1, 2, 4]) for (const width of [1, 2, 3, 7]) {
    const pad = " ".repeat(rootIndent), dash = " ".repeat(rootIndent + 2), gap = " ".repeat(width);
    const column = rootIndent + 3 + width, content = " ".repeat(column);
    const prefix = `${pad}items:\n`;
    const add = (name, text, value, accepted = true) => rows.push({
      name: `${name}-indent-${rootIndent}-gap-${width}`, source: prefix + text, accepted,
      ...(accepted ? { expected: { items: value } } : {}),
    });
    for (const [token, value] of [['"one"', "one"], ['"  日本語😀  "', "  日本語😀  "], ["0", 0], ["false", false], ["[]", []], ["{}", {}]]) {
      add(`scalar-${token}`, `${dash}-${gap}${token}\n`, [value]);
    }
    add("compact-map", `${dash}-${gap}first: "one"\n${content}second: "two"\n`, [{ first: "one", second: "two" }]);
    add("compact-sequence", `${dash}-${gap}-${gap}"one"\n${content}-${gap} "two"\n`, [["one", "two"]]);
    add("compact-explicit-key", `${dash}-${gap}? "first"\n${content}: "one"\n`, [{ first: "one" }]);
    add("compact-map-with-sequence", `${dash}-${gap}children:\n${content}  -${gap}"one"\n${content}tag: "two"\n`, [{ children: ["one"], tag: "two" }]);
    add("varying-sibling-gaps", `${dash}-${gap}"one"\n${dash}- ${gap}"two"\n`, ["one", "two"]);
    add("folded-value", `${dash}-${gap}"first\n${dash} second"\n`, ["first second"]);
    for (const offset of [-1, 1]) {
      const wrong = " ".repeat(column + offset);
      add(`wrong-map-indent-${offset}`, `${dash}-${gap}first: "one"\n${wrong}second: "two"\n`, undefined, false);
      add(`wrong-explicit-indent-${offset}`, `${dash}-${gap}? "first"\n${wrong}: "one"\n`, undefined, false);
    }
    add("missing-value", `${dash}-${gap}\n`, undefined, false);
    add("unquoted-value", `${dash}-${gap}unquoted\n`, undefined, false);
    if (width === 1) add("tab-separator", `${dash}-\t"one"\n`, undefined, false);
  }
  return rows;
}
