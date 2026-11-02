import copy
import json
from pathlib import Path
import unittest

from canonical import canonical_json
from yaml_records import MAX_BYTES, MAX_DEPTH, read_yaml, write_yaml


FIXTURES = Path(__file__).resolve().parents[1] / "kernel/test/fixtures"


def logical_records(value):
    records = [value["schemaLock"], value["revision"]]
    for field in ["elements", "approvals", "changeSets", "migrations"]:
        records.extend(value[field])
    records.extend(entry["report"] for entry in value["reports"])
    return records


class YamlRecordTests(unittest.TestCase):
    def test_plain_keys_use_exact_core_spelling(self):
        accepted = [".nAn", ".Nan", ".nAN", ".iNF", "+.iNf", "-.iNf", "+0o7", "-0o7", "+0xAf", "-0xAf", "+.nan", "-.NaN"]
        rejected = [".nan", ".NaN", ".NAN", ".inf", ".Inf", ".INF", "+.Inf", "-.INF", "0o7", "0xAf", "true", "False", "null", "1.0"]
        for token in accepted + rejected:
            with self.subTest(token=token):
                source = 'format: "morivyx.git-graph/0.1"\nextensions:\n  ' + token + ': "value"\n'
                if token in accepted:
                    value = read_yaml(source)
                    self.assertEqual(value["extensions"], {token: "value"})
                    self.assertEqual(read_yaml(write_yaml(value)), value)
                else:
                    with self.assertRaises(ValueError):
                        read_yaml(source)
                quoted = 'format: "morivyx.git-graph/0.1"\nextensions:\n  "' + token + '": "value"\n'
                self.assertEqual(read_yaml(quoted)["extensions"], {token: "value"})

    def test_nonempty_package_fixed_input_and_output(self):
        vector = json.loads((FIXTURES / "graph-package-roundtrip-vector.json").read_text())
        inputs = logical_records(vector["inputLogicalValue"])
        outputs = logical_records(vector["outputLogicalValue"])
        formats = set()
        for index, relative in enumerate(vector["inputFiles"]):
            with self.subTest(path=relative):
                source = (FIXTURES / vector["inputRoot"] / relative).read_bytes()
                value = read_yaml(source)
                self.assertEqual(value, inputs[index])
                before = copy.deepcopy(value)
                written = write_yaml(value)
                expected = (FIXTURES / vector["expectedOutputFiles"][relative]).read_text()
                self.assertEqual(written, expected)
                self.assertEqual(read_yaml(written), outputs[index])
                self.assertEqual(value, before)
                formats.add(value["format"])
        self.assertEqual(len(formats), 7)

    def test_unknown_extensions_and_yaml_escapes(self):
        source = ('format: "morivyx.git-graph/0.1"\nextensions:\n'
                  '  "unknown/key":\n'
                  '    "a:b": "\\0\\a\\v\\e\\N\\_\\L\\P\\x41\\u00e9\\U0001f600"\n'
                  '    list:\n      - [ ]\n      - { }\n'
                  '      - - "second"\n        - "first"\n'
                  '    nullValue: null\n')
        value = read_yaml(source)
        self.assertEqual(value["extensions"]["unknown/key"]["a:b"],
                         "\0\a\v\x1b\x85\xa0\u2028\u2029Aé😀")
        self.assertEqual(value["extensions"]["unknown/key"]["list"], [[], {}, ["second", "first"]])
        self.assertEqual(read_yaml(write_yaml(value)), value)

    def test_unicode_dates_and_key_order(self):
        source = ('"format": "morivyx.git-graph/0.1"\nextensions:\n'
                  '  "e\\u0301":\n'
                  '    z: "2026-01-01T01:00:00.12000+01:00"\n'
                  '    a: "e\\u0301"\n')
        value = read_yaml(source)
        self.assertEqual(value["extensions"]["é"]["z"], "2026-01-01T01:00:00.12000+01:00")
        text = write_yaml(value)
        self.assertIn('a: "é"\n', text)
        self.assertIn('z: "2026-01-01T00:00:00.12Z"\n', text)
        self.assertLess(text.index("a:"), text.index("z:"))
        self.assertEqual(canonical_json(read_yaml(text)), canonical_json(value))

    def test_forbidden_scalars_and_metadata(self):
        for scalar in ['plain', "'single'", "01", "+1", "-0", "1.0", "1e2", ".nan", ".inf",
                       "NaN", "Infinity", "True", "NULL", "~", "*alias", "&anchor 1", "!tag 1",
                       "[1]", "{a: 1}", "|", ">", '"value" # comment', "9007199254740992"]:
            with self.subTest(scalar=scalar), self.assertRaises(ValueError):
                read_yaml("x: " + scalar + "\n")
        for source in ['# comment\nx: 1\n', '%YAML 1.2\nx: 1\n', '---\nx: 1\n',
                       'x: 1\n...\n', '"<<": {}\n', 'true: 1\n', 'True: 1\n', 'NULL: 1\n', 'x:\n',
                       'x: 1\n  y: 2\n', '- "root-list"\n',
                       'x: "multi\nline"\n', 'x: "\\q"\n', 'x: "\\uD800"\n']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                read_yaml(source)

    def test_sequence_separation_width_and_compact_indentation(self):
        for width in [1, 2, 3, 7]:
            gap = " " * width
            column = " " * (3 + width)
            cases = [
                (f'items:\n  -{gap}"  text  "\n', {"items": ["  text  "]}),
                (f'items:\n  -{gap}0\n  -{gap}false\n  -{gap}[]\n', {"items": [0, False, []]}),
                (f'items:\n  -{gap}first: "one"\n{column}second: "two"\n', {"items": [{"first": "one", "second": "two"}]}),
                (f'items:\n  -{gap}-{gap}"one"\n{column}-{gap}"two"\n', {"items": [["one", "two"]]}),
                (f'items:\n  -{gap}? "first"\n{column}: "one"\n', {"items": [{"first": "one"}]}),
            ]
            for source, expected in cases:
                with self.subTest(width=width, source=source):
                    self.assertEqual(read_yaml(source), expected)

    def test_sequence_spacing_does_not_relax_invalid_input_or_depth(self):
        for source in [
            'items:\n  -   first: "one"\n    second: "two"\n',
            'items:\n  -   ? "first"\n     : "one"\n',
            'items:\n  -   \n', 'items:\n  -   unquoted\n',
            'items:\n  -\t"one"\n',
            'items:\n  ' + '-   ' * (MAX_DEPTH + 2) + '"end"\n',
        ]:
            with self.subTest(source=source[:100]), self.assertRaises(ValueError):
                read_yaml(source)

    def test_separated_values_and_parent_relative_quoted_continuations(self):
        cases = [
            ('value:\n  "one"\nafter: "end"\n', {"value": "one", "after": "end"}),
            ('values:\n  -\n    7\n  -\n    false\n  -\n    []\n  -\n    {}\n', {"values": [7, False, [], {}]}),
            ('value:\n    "first\n second"\n', {"value": "first second"}),
            ('outer:\n  value:\n      "first\n   second"\n', {"outer": {"value": "first second"}}),
            ('values:\n  -\n      "first\\\n   second"\n', {"values": ["firstsecond"]}),
            ('values:\n  -   -\n       "one"\n', {"values": [["one"]]}),
            ('? "value"\n:\n    "first\n second"\n', {"value": "first second"}),
            ('values:\n  -   value:\n          "first\n       second"\n', {"values": [{"value": "first second"}]}),
        ]
        for source, expected in cases:
            with self.subTest(source=source):
                self.assertEqual(read_yaml(source), expected)

    def test_separated_values_keep_scalar_boundaries_and_rejection_guards(self):
        for source in [
            'value:\n"one"\n', 'value:\n  "one"\n  "two"\n',
            'value:\n  "first\nsecond"\n',
            'value:\n  "first\n   second": "bad"\n',
            'value:\n  unquoted\n', 'value:\n  [1]\n', 'value:\n  1.5\n',
            'value:\n  !!str "bad"\n', 'value:\n  "bad\tvalue"\n',
            "".join(" " * (i * 2) + "x:\n" for i in range(MAX_DEPTH + 2)) + " " * ((MAX_DEPTH + 3) * 2) + '"end"\n',
        ]:
            with self.subTest(source=source[:100]), self.assertRaises(ValueError):
                read_yaml(source)

    def test_input_encoding_and_bounds(self):
        for source in [b"x: \xff\n", b"\xef\xbb\xbfx: 1\n", b"x: 1\r\n",
                       b"x:\t1\n", b"x: 1", b"x: 1\n\n", b"x: 1\n \n", b"x: \x00\n",
                       b"x: 'bad\x01key'\n", b"x" * (MAX_BYTES + 1)]:
            with self.subTest(length=len(source)), self.assertRaises(ValueError):
                read_yaml(source)
        source = "".join(" " * (i * 2) + "x:\n" for i in range(MAX_DEPTH + 2))
        source += " " * ((MAX_DEPTH + 2) * 2) + "end: 1\n"
        with self.assertRaises(ValueError):
            read_yaml(source)
        with self.assertRaises(ValueError):
            read_yaml("x:\n  " + "- " * (MAX_DEPTH + 2) + '"end"\n')

    def test_duplicate_keys_and_writer_rejections(self):
        for source in ['x: 1\nx: 2\n', '"é": 1\n"e\\u0301": 2\n']:
            with self.assertRaises(ValueError):
                read_yaml(source)
        for value in [[], {"format": "unknown"}, {"format": "morivyx.approval/0.1", "x": None},
                      {"format": "morivyx.git-graph/0.1", "extensions": None},
                      {"format": "morivyx.git-graph/0.1", "x": -0.0},
                      {"format": "morivyx.git-graph/0.1", "extensions": {"example.test/x": {"<<": 1}}},
                      {"format": "morivyx.git-graph/0.1", "é": 1, "e\u0301": 2}]:
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                write_yaml(value)
        cyclic = {"format": "morivyx.git-graph/0.1"}
        cyclic["extensions"] = cyclic
        with self.assertRaises(ValueError):
            write_yaml(cyclic)


if __name__ == "__main__":
    unittest.main()
