export function yamlSeparatedValueCases() {
  const rows = [];
  for (const rootIndent of [0, 1, 3]) {
    const pad = " ".repeat(rootIndent), child = pad + "  ", compact = pad + "      ";
    const layouts = [
      ["mapping", rootIndent, `${pad}value:\n`, `${pad}after: "end"\n`, value => ({ value, after: "end" })],
      ["nested-mapping", rootIndent + 2, `${pad}outer:\n${child}value:\n`, `${child}after: "end"\n`, value => ({ outer: { value, after: "end" } })],
      ["sequence", rootIndent + 2, `${pad}items:\n${child}-\n`, `${child}- "end"\n`, value => ({ items: [value, "end"] })],
      ["indentless-sequence", rootIndent, `${pad}items:\n${pad}-\n`, `${pad}- "end"\n${pad}after: "done"\n`, value => ({ items: [value, "end"], after: "done" })],
      ["explicit-key", rootIndent, `${pad}? "value"\n${pad}:\n`, `${pad}after: "end"\n`, value => ({ value, after: "end" })],
      ["compact-mapping", rootIndent + 6, `${pad}items:\n${child}-   value:\n`, `${compact}after: "end"\n`, value => ({ items: [{ value, after: "end" }] })],
      ["compact-sequence", rootIndent + 6, `${pad}items:\n${child}-   -\n`, `${compact}- "end"\n`, value => ({ items: [[value, "end"]] })],
    ];
    for (const [layout, parent, before, after, wrap] of layouts) {
      const add = (name, token, first, accepted, value) => rows.push({
        name: `${layout}-root-${rootIndent}-${name}`, source: before + " ".repeat(first) + token + "\n" + after,
        accepted, ...(accepted ? { expected: wrap(value) } : {}),
      });
      for (const opening of [1, 4]) {
        const first = parent + opening;
        const atoms = [['"one"', "one"], ['"  日本語😀  "', "  日本語😀  "], ["7", 7], ["-7", -7],
          ["true", true], ["false", false], ["null", null], ["[]", []], ["{}", {}]];
        for (const [token, value] of atoms) add(`scalar-${token}-open-${opening}`, token, first, true, value);
        for (const continuation of [1, 3]) {
          const prefix = " ".repeat(parent + continuation);
          for (const [name, token, value] of [
            ["fold", `"first\n${prefix}second"`, "first second"],
            ["empty-line", `"first\n\n${prefix}second"`, "first\nsecond"],
            ["escaped-line", `"first\\\n${prefix}second"`, "firstsecond"],
            ["unicode", `"e\\\n${prefix}\\u0301"`, "é"],
          ]) add(`${name}-open-${opening}-continue-${continuation}`, token, first, true, value);
        }
        for (const [name, token] of [
          ["plain", "unquoted"], ["flow-sequence", "[1]"], ["flow-map", '{"key": "value"}'],
          ["float", "1.5"], ["tag", '!!str "value"'], ["tab", '"bad\tvalue"'],
          ["extra-value", `"one"\n${" ".repeat(first)}"two"`],
          ["implicit-multiline-key", `"first\n${" ".repeat(parent + 1)}second": "bad"`],
          ["shallow-continuation", `"first\n${" ".repeat(parent)}second"`],
        ]) add(`reject-${name}-open-${opening}`, token, first, false);
      }
      add("reject-shallow-opening", '"one"', parent, false);
      rows.push({ name: `${layout}-root-${rootIndent}-reject-missing`, source: before + after, accepted: false });
    }
  }
  return rows;
}
