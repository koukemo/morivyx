export function yamlSourceCharacterCases() {
  const points = [
    ...Array.from({ length: 33 }, (_, index) => index),
    ...Array.from({ length: 34 }, (_, index) => index + 0x7f),
    0x1680, 0x180e, 0x2000, 0x200b, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000, 0xfeff, 0xfffe, 0xffff, 0x1fffe, 0x10ffff,
  ];
  return points.flatMap((point) => {
    const character = String.fromCodePoint(point);
    return [
      ["value", `field: "a${character}b"\n`],
      ["quoted-key", `"a${character}b": "value"\n`],
      ["plain-key", `a${character}b: "value"\n`],
      ["before-colon", `field${character}: "value"\n`],
      ["after-colon", `field:${character}"value"\n`],
      ["trailing", `field: "value"${character}\n`],
      ["empty-line", `field: "value"\n${character}\n`],
    ].map(([name, source]) => ({ point, name, source }));
  });
}
