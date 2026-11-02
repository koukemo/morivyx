export function yamlKeyStyleCases() {
  const cases = [];
  for (const style of ["|", "|-", "|+", ">", ">-", ">+", "|2-", "|-2", "|2+", "|+2", ">2-", ">-2"]) {
    for (const context of ["root", "nested", "compact"]) {
      for (const empty of [false, true]) {
        const indent = context === "root" ? 0 : context === "nested" ? 2 : 4;
        const prefix = context === "root" ? "" : context === "nested" ? "outer:\n  " : "outer:\n  - ";
        const source = prefix + "? " + style + "\n" + (empty ? "" : " ".repeat(indent + 2) + "key\n") +
          " ".repeat(indent) + ': "value"\n';
        for (const root of [0, 2, 5]) cases.push({ name: `${style}-${context}-${empty}-${root}`,
          source: source.split("\n").slice(0, -1).map(line => " ".repeat(root) + line).join("\n") + "\n", accepted: false });
      }
    }
  }
  for (const [name, source, expected] of [
    ["plain", 'key: "value"\n', { key: "value" }],
    ["double", '"key": "value"\n', { key: "value" }],
    ["single", "'key': \"value\"\n", { key: "value" }],
    ["explicit-double", '? "key"\n: "value"\n', { key: "value" }],
    ["explicit-single", "? 'key'\n: \"value\"\n", { key: "value" }],
    ["folded-quote", '? "first\n  second"\n: "value"\n', { "first second": "value" }],
    ["escaped-newline", '? "first\\nsecond"\n: "value"\n', { "first\nsecond": "value" }],
    ["literal-indicators", '"|": ">"\n', { "|": ">" }],
  ]) cases.push({ name, source, expected, accepted: true });
  return cases;
}
