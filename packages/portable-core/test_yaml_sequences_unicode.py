import copy
import json
import unittest

from canonical import canonical_json
from package_records import read_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from test_graph_validation import entity
from test_package_core_validation import files_for
from test_report_records import reports
from test_yaml_authoring import cases as authoring_cases
from test_yaml_root_indentation import package_cases as root_packages, shifted
from yaml_authoring import read_authoring_yaml
from yaml_records import MAX_BYTES, MAX_DEPTH, read_yaml, write_yaml


def rendered(value, indent=0, indentless=True):
    prefix = " " * indent
    if type(value) is dict and value:
        lines = []
        for key, entry in value.items():
            start = prefix + json.dumps(key, ensure_ascii=True) + ":"
            if type(entry) in (dict, list) and entry:
                lines.append(start)
                lines.extend(rendered(entry, indent if indentless and type(entry) is list else indent + 2, indentless))
            else:
                lines.append(start + " " + json.dumps(entry, ensure_ascii=True))
        return lines
    if type(value) is list and value:
        lines = []
        for entry in value:
            if type(entry) in (dict, list) and entry:
                lines.append(prefix + "-")
                lines.extend(rendered(entry, indent + 2, indentless))
            else:
                lines.append(prefix + "- " + json.dumps(entry, ensure_ascii=True))
        return lines
    return [prefix + json.dumps(value, ensure_ascii=True)]


def source(value, width=0, indentless=True):
    return "\n".join(rendered(value, width, indentless)) + "\n"


def cases():
    out = []
    for original in authoring_cases():
        record = read_yaml(original["source"])
        for width in (0, 2, 4):
            out.append({**original, "name": "layout-" + str(width) + "-" + original["name"], "source": source(record, width),
                        "width": width, "policyCase": True, "format": record.get("format")})
    for value in [{"a": ["x", "y"], "b": "next"}, {"a": [{"b": ["x"], "c": "next"}], "d": "end"},
                  {"a": [["x", "y"], ["z"]], "b": "next"}, {"é": "😀", "😀": "𝔸"},
                  {"a": ["😀", "𝔸", "é"], "b": {"x": [[], {}, ["last"]]}}]:
        for width in (0, 1, 4):
            out.append({"name": "nested-" + str(len(out)), "source": source(value, width), "accepted": True, "policyCase": False,
                        "width": width, "format": None, "expected": value})
    for token in [r"\uD83D\uDE00", r"\U0000D83D\U0000DE00", r"\uD83D\U0000DE00", r"\U0000D83D\uDE00",
                  r"\uD800\uDC00", r"\uDBFF\uDFFF", r"\uD83D\uDE00\uD83D\uDE00", r"\uD835\uDD38"]:
        out.append({"name": "paired-" + str(len(out)), "source": 'a: "' + token + '"\n', "accepted": True, "policyCase": False,
                    "width": 0, "format": None})
    for token in [r"\uD800", r"\uDC00", r"\uD800\u0041", r"\uDC00\uD800", r"\uD800\uD800\uDC00",
                  r"\uD800x\uDC00", r"\U0000DFFF", r"\U00110000"]:
        out.append({"name": "unpaired-" + str(len(out)), "source": 'a: "' + token + '"\n', "accepted": False, "policyCase": False,
                    "width": 0, "format": None})
    for text in ['a:\n-\nb: "next"\n', 'a:\n- "x"\n  b: "bad"\n', 'a:\n- [1]\n', 'a:\n- &anchor "x"\n',
                 'a:\n- *alias\n', 'a:\n- !tag "x"\n', 'a:\n- |\n  "x"\n', 'a:\n- plain\n',
                 'a:\n- "x" # comment\n', 'a: "\\uD83D\\uDE00"\na: "duplicate"\n',
                 '"\\uD83D\\uDE00": "x"\n"😀": "duplicate"\n']:
        out.append({"name": "forbidden-" + str(len(out)), "source": text, "accepted": False, "policyCase": False,
                    "width": 0, "format": None})
    return out


def package_cases():
    fixtures = [value for value in root_packages() if value["width"] == 0]
    unicode_element = entity(1, attributes={"actorKind": "synthetic", "displayName": "😀"},
                             extensions={"example/unicode": {"\ue000": "private", "😀": "𝔸"}})
    fixtures.append({"name": "unicode-core", "baselineFiles": files_for([unicode_element])})
    out = []
    for value in fixtures:
        for width in (0, 2, 4):
            files = {path: source(read_yaml(text), width) for path, text in value["baselineFiles"].items()}
            out.append({"name": value["name"] + "-" + str(width), "width": width,
                        "baselineFiles": value["baselineFiles"], "files": files})
    return out


class SequenceUnicodeTests(unittest.TestCase):
    def test_policy_and_logical_values(self):
        for case in cases():
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    value = read_authoring_yaml(case["source"])
                    if "expected" in case:
                        self.assertEqual(value, case["expected"])
                else:
                    with self.assertRaises(ValueError) as caught:
                        read_authoring_yaml(case["source"])
                    if case["policyCase"]:
                        self.assertEqual((caught.exception.code, caught.exception.path), (case["code"], case["path"]))

    def test_sequence_end_returns_to_parent_mapping(self):
        text = 'a:\n- b:\n  - "😀"\n  c: "next"\n- b: []\nd: "end"\n'
        expected = {"a": [{"b": ["😀"], "c": "next"}, {"b": []}], "d": "end"}
        for width in (0, 2, 8):
            self.assertEqual(read_yaml(shifted(text, width)), expected)

    def test_unicode_pairs_match_direct_scalar_values(self):
        for token in (r"\uD83D\uDE00", r"\U0000D83D\U0000DE00", r"\uD83D\U0000DE00"):
            self.assertEqual(read_yaml('a: "' + token + '"\n'), {"a": "😀"})
        self.assertEqual(read_yaml('"\\uD83D\\uDE00": "\\uD835\\uDD38"\n'), {"😀": "𝔸"})

    def test_encoding_depth_size_and_mapping_root_guards(self):
        for text in ['- "x"\n', 'a:\n- "x"\n\n', '\ufeffa:\n- "x"\n', 'a:\n-\t"x"\n', 'a:\r\n- "x"\r\n']:
            with self.assertRaises(ValueError):
                read_yaml(text)
        with self.assertRaises(ValueError):
            read_yaml(b'x' * (MAX_BYTES + 1))
        value = "end"
        for _ in range(MAX_DEPTH + 2):
            value = {"x": [value]}
        with self.assertRaises(ValueError):
            read_yaml(source(value))

    def test_checked_packages_schema_binding_and_source_preservation(self):
        for case in package_cases():
            before = copy.deepcopy(case)
            original = read_package_files(case["baselineFiles"])
            actual = read_package_files(case["files"])
            original.pop("schemaSources")
            actual.pop("schemaSources")
            self.assertEqual(canonical_json(actual), canonical_json(original))
            self.assertEqual(validate_package_files(case["files"]), validate_package_files(case["baselineFiles"]))
            self.assertEqual(case, before)

    def test_reports_and_writer_format_are_unchanged(self):
        for report in reports():
            baseline = serialize_report_yaml(report)
            parsed = read_yaml(baseline)
            for width in (0, 2, 4):
                input_source = source(parsed, width)
                self.assertEqual(read_report_source(input_source), read_report_source(baseline))
                self.assertEqual(write_yaml(read_yaml(input_source)), baseline)


if __name__ == '__main__':
    unittest.main()
