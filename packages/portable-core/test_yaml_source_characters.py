"""Keep YAML source restrictions separate from escaped logical string values."""

import json
from pathlib import Path
import unittest

from canonical import canonical_json, digest
from yaml_records import read_yaml, write_yaml


class YamlSourceCharacterTests(unittest.TestCase):
    def test_raw_c0_and_plain_key_boundaries(self):
        for point in range(32):
            if point == 10:
                continue
            c = chr(point)
            for source in (f'field: "a{c}b"\n', f'"a{c}b": "value"\n', f'a{c}b: "value"\n'):
                with self.assertRaises(ValueError):
                    read_yaml(source)
        for point in (*range(0x7f, 0x85), *range(0x86, 0xa0), 0xfffe, 0xffff):
            c = chr(point)
            with self.assertRaises(ValueError):
                read_yaml(f'a{c}b: "value"\n')

    def test_quoted_non_c0_and_printable_supplementary_characters(self):
        for point in (*range(0x7f, 0xa0), 0xfffe, 0xffff):
            c = chr(point)
            self.assertEqual(read_yaml(f'"a{c}b": "a{c}b"\n'), {f'a{c}b': f'a{c}b'})
        for point in (0x85, 0xa0, 0x2028, 0x2029, 0x1fffe, 0x10ffff):
            c = chr(point)
            self.assertEqual(read_yaml(f'a{c}b: "a{c}b"\n'), {f'a{c}b': f'a{c}b'})

    def test_writer_preserves_escaped_logical_values_and_revisions(self):
        fixture = Path(__file__).resolve().parent.parent / 'kernel/test/fixtures/graph-package-roundtrip-vector.json'
        sample = json.loads(fixture.read_text())['inputLogicalValue']['elements'][0]
        for point in (*range(32), *range(0x7f, 0xa0), 0xfffe, 0xffff):
            c = chr(point)
            value = {**sample, 'attributes': {f'a{c}b': f'\\a{c}b\\'}}
            source = write_yaml(value)
            self.assertFalse(any((ord(x) < 32 and x != '\n') or 0x7f <= ord(x) <= 0x9f or ord(x) in (0xfffe, 0xffff) for x in source))
            decoded = read_yaml(source)
            self.assertEqual(canonical_json(decoded), canonical_json(value))
            self.assertEqual(digest('revision', decoded), digest('revision', value))


if __name__ == '__main__':
    unittest.main()
