"""Independent NFC checks against Unicode's published normalization vectors."""

import hashlib
from pathlib import Path
import unittest

from canonical import canonical_json, digest
from unicode_nfc import normalize_nfc, UNICODE_NFC_VERSION

FIXTURE = Path(__file__).resolve().parent.parent / "kernel/test/fixtures/unicode-normalization-16.txt"


class UnicodeNfcTests(unittest.TestCase):
    def test_official_rows(self):
        data = FIXTURE.read_bytes()
        self.assertEqual(UNICODE_NFC_VERSION, "16.0.0")
        self.assertEqual(hashlib.sha256(data).hexdigest(), "c31999696cce2be0611ab5ac4335f451612740b921b2a59a9f139071d8cb654d")
        count = 0
        for line in data.decode().splitlines():
            if not line or line.startswith(("#", "@")):
                continue
            c1, c2, c3, c4, c5 = ("".join(chr(int(p, 16)) for p in column.split()) for column in line.split(";"))
            for value, expected in ((c1, c2), (c2, c2), (c3, c2), (c4, c4), (c5, c4)):
                self.assertEqual(normalize_nfc(value), expected)
            count += 1
        self.assertEqual(count, 19965)

    def test_unlisted_singletons(self):
        part, listed = None, set()
        for line in FIXTURE.read_text().splitlines():
            if line.startswith("@"):
                part = line
            elif part == "@Part1" and line and not line.startswith("#"):
                listed.add(int(line.split(";")[0], 16))
        self.assertGreater(len(listed), 1000)
        for point in range(0x110000):
            if 0xD800 <= point <= 0xDFFF or point in listed:
                continue
            self.assertEqual(normalize_nfc(chr(point)), chr(point))

    def test_fixed_digest_and_invalid_scalars(self):
        with self.assertRaises(TypeError):
            normalize_nfc(42)
        text = "a\u0315\u05c8\u0300"
        result = digest("schema", {text: text})
        self.assertEqual(result["canonicalJson"], '{"' + text + '":"' + text + '"}')
        self.assertEqual(result["canonicalByteLength"], 21)
        self.assertEqual(result["digest"], "sha256:e67d7eb81d14544f62a52312c13f78a02c4e883e8638e321b656dc34d592505d")
        with self.assertRaises(ValueError):
            canonical_json("\ud800")
        with self.assertRaises(ValueError):
            canonical_json({"é": 1, "e\u0301": 2})

    def test_long_combining_run_and_hangul(self):
        self.assertEqual(normalize_nfc("a" + "\u0315" * 20000 + "\u0300"), "à" + "\u0315" * 20000)
        self.assertEqual(normalize_nfc("\u1100\u1161\u11a8"), "\uac01")


if __name__ == "__main__":
    unittest.main()
