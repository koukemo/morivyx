// Explicit expected strings preserve the current authoring profile independently
// of either reader. This is not a claim of complete YAML syntax conformance.
export function yamlFoldingCases() {
  const families = [
    ["one-line", '"a b"', "a b"],
    ["fold", '"a\n@b"', "a b"],
    ["empty-line", '"a\n\n@b"', "a\nb"],
    ["two-empty-lines", '"a\n\n\n@b"', "a\n\nb"],
    ["trim-line-space", '"a  \n@b"', "a b"],
    ["keep-edge-space", '" a\n@b "', " a b "],
    ["escaped-break", '"a\\\n@b"', "ab"],
    ["space-before-escaped-break", '"a  \\\n@b"', "a  b"],
    ["escaped-leading-space", '"a\\\n@\\ b"', "a b"],
    ["literal-backslash", '"a\\\\\n@b"', "a\\ b"],
    ["escaped-newline-and-fold", '"a\\n\n@b"', "a\n b"],
    ["escaped-quote", '"a\\\"\n@b"', 'a" b'],
    ["unicode-escape", '"e\\u0301\n@b"', "é b"],
    ["quoted-hash", '"a#literal\n@b"', "a#literal b"],
    ["single-fold", "'a\n@b'", "a b"],
    ["single-empty-line", "'a\n\n@b'", "a\nb"],
    ["single-apostrophe", "'a''\n@b'", "a' b"],
    ["single-backslash", "'a\\\n@b'", "a\\ b"],
    ["unterminated", '"a\n@b', null],
    ["unknown-escape", '"a\\q\n@b"', null],
    ["raw-tab", '"a\t\n@b"', null],
    ["raw-cr", '"a\r\n@b"', null],
    ["lone-surrogate", '"a\\uD800\n@b"', null],
    ["lone-low-surrogate", '"a\\uDC00\n@b"', null],
    ["reversed-surrogates", '"a\\uDE00\\uD83D\n@b"', null],
    ["separated-surrogates", '"a\\uD83Dx\\uDE00\n@b"', null],
    ["surrogate-pair", '"a\\uD83D\\uDE00\n@b"', "a😀 b"],
    ["raw-astral", '"a😀\n@b"', "a😀 b"],
    ["astral-escape", '"a\\U0001F600\n@b"', "a😀 b"],
    ["adjacent-pairs", '"a\\uD83D\\uDE00\\uD83D\\uDE00\n@b"', "a😀😀 b"],
    ["lone-surrogate-single-line", '"\\uD800"', null],
    ["low-surrogate-single-line", '"\\uDC00"', null],
    ["surrogate-pair-single-line", '"\\uD83D\\uDE00"', "😀"],
    ["astral-escape-single-line", '"\\U0001F600"', "😀"],
    ["high-unit-escape", '"\\U0000D800"', null],
    ["low-unit-escape", '"\\U0000DC00"', null],
    ["dedented", '"a\n@b"', null],
  ];
  const cases = [];
  for (const [name, template, value] of families) {
    for (const context of ["value", "nested-value", "sequence-value", "compact-value", "key", "nested-key", "list-key", "implicit-key"]) {
      const indent = context === "nested-value" || context === "nested-key" || context === "sequence-value" ? 2
        : context === "compact-value" || context === "list-key" ? 4 : 0;
      const token = template.replaceAll("@", " ".repeat(indent + (name === "dedented" ? 0 : 2)));
      const key = context.endsWith("key");
      const accepted = value !== null && !(template.startsWith("'") && !key)
        && !(context === "implicit-key" && token.includes("\n"));
      let source, expected;
      if (context === "value") { source = `value: ${token}\n`; expected = { value }; }
      else if (context === "nested-value") { source = `outer:\n  value: ${token}\n`; expected = { outer: { value } }; }
      else if (context === "sequence-value") { source = `outer:\n  - ${token}\n`; expected = { outer: [value] }; }
      else if (context === "compact-value") { source = `outer:\n  - value: ${token}\n`; expected = { outer: [{ value }] }; }
      else if (context === "key") { source = `? ${token}\n: "value"\n`; expected = { [value]: "value" }; }
      else if (context === "nested-key") { source = `outer:\n  ? ${token}\n  : "value"\n`; expected = { outer: { [value]: "value" } }; }
      else if (context === "list-key") { source = `outer:\n  - ? ${token}\n    : "value"\n`; expected = { outer: [{ [value]: "value" }] }; }
      else { source = `${token}: "value"\n`; expected = { [value]: "value" }; }
      for (const root of [0, 2, 5]) cases.push({ name: `${name}-${context}-${root}`, accepted,
        source: source.split("\n").slice(0, -1).map(line => " ".repeat(root) + line).join("\n") + "\n",
        ...(accepted ? { expected } : {}) });
    }
  }
  return cases;
}
