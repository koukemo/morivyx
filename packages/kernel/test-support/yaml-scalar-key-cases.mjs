// Expectations follow the exact YAML 1.2 Core spellings, not either reader.
function casings(word) {
  return Array.from({ length: 2 ** word.length }, (_, mask) =>
    [...word].map((c, index) => mask & (1 << index) ? c.toUpperCase() : c).join(""));
}

export function yamlScalarKeyCases() {
  const tokens = [];
  for (const word of casings("nan")) for (const sign of ["", "+", "-"]) {
    tokens.push({ token: sign + "." + word, key: sign !== "" || !["nan", "NaN", "NAN"].includes(word), value: false });
  }
  for (const word of casings("inf")) for (const sign of ["", "+", "-"]) {
    tokens.push({ token: sign + "." + word, key: !["inf", "Inf", "INF"].includes(word), value: false });
  }
  for (const token of ["0o0", "0o7", "0o17", "0x0", "0xAf", "0xFF"]) for (const sign of ["", "+", "-"]) {
    tokens.push({ token: sign + token, key: sign !== "", value: false });
  }
  for (const word of ["true", "false", "null"]) for (const token of casings(word)) {
    const typed = [word, word[0].toUpperCase() + word.slice(1), word.toUpperCase()].includes(token);
    tokens.push({ token, key: !typed, value: token === word, scalar: { true: true, false: false, null: null }[word] });
  }
  for (const token of ["0o8", "0O7", "0xG", "0XAf", ".info", ".nana", "NaN", "Infinity", "+Infinity", "-.Infinity"]) {
    tokens.push({ token, key: true, value: false });
  }
  for (const token of ["0", "1", "-1", "9007199254740991", "-9007199254740991"]) {
    tokens.push({ token, key: false, value: true, scalar: Number(token) });
  }
  for (const token of ["+1", "01", "-0", "1.0", ".5", "1e3", "9007199254740992", "-9007199254740992", "~"]) {
    tokens.push({ token, key: false, value: false });
  }
  const prefix = 'format: "morivyx.git-graph/0.1"\nextensions:\n';
  const rows = [];
  for (const item of tokens) {
    const key = item.token, expected = { format: "morivyx.git-graph/0.1", extensions: { [key]: "value" } };
    for (const [style, body, accepted, value] of [
      ["plain", `  ${key}: "value"\n`, item.key, expected],
      ["explicit", `  ? ${key}\n  : "value"\n`, item.key, expected],
      ["sequence", `  rows:\n    - ${key}: "value"\n`, item.key,
        { format: "morivyx.git-graph/0.1", extensions: { rows: [{ [key]: "value" }] } }],
      ["double", `  "${key}": "value"\n`, true, expected],
      ["single", `  '${key}': "value"\n`, true, expected],
      ["explicit-double", `  ? "${key}"\n  : "value"\n`, true, expected],
      ["value", `  field: ${key}\n`, item.value,
        { format: "morivyx.git-graph/0.1", extensions: { field: item.scalar } }],
    ]) rows.push({ name: `${style}/${key}`, source: prefix + body, accepted, ...(accepted ? { expected: value } : {}) });
  }
  return rows;
}
