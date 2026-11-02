import copy
import unittest

from canonical import canonical_json
from package_records import read_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from schema_validation import ValidationError
from test_package_export import cases as export_cases
from test_report_records import reports
from test_yaml_authoring import cases as authoring_cases
from test_yaml_records import logical_records
from yaml_authoring import read_authoring_yaml
from yaml_records import MAX_BYTES, MAX_DEPTH, read_yaml, write_yaml


WIDTHS = (0, 1, 2, 4, 8)


def shifted(source, width):
    return "\n".join(" " * width + line if line else line for line in source.split("\n"))


def cases():
    out = []
    for original in authoring_cases():
        format_id = read_yaml(original["source"]).get("format") if original["accepted"] else None
        for width in WIDTHS:
            out.append({**original, "name": "indent-" + str(width) + "-" + original["name"], "width": width,
                        "format": format_id, "source": shifted(original["source"], width), "policyCase": True})
    for width in WIDTHS:
        for value in ("{}", "{ }", "{   }"):
            out.append({"name": "empty-" + str(len(out)), "source": shifted(value + "\n", width), "width": width,
                        "format": None, "accepted": True, "policyCase": False})
        nested = 'a:\n   -\n      "é": "e\\u0301"\n'
        for leading in ("", "\n"):
            out.append({"name": "nested-" + str(len(out)), "source": leading + shifted(nested, width), "width": width,
                        "format": None, "accepted": True, "policyCase": False})
    forbidden = ['a: 1\n a: 2\n', 'a: 1\nb: 2\n a: 3\n', '- "root-list"\n', '[ ]\n',
                 'a: [1]\n', 'a: {b: 1}\n', 'a: &anchor 1\n', 'a: *alias\n', 'a: !tag 1\n',
                 'a: |\n  "value"\n', 'a: >\n  "value"\n', 'a: plain\n', 'a: 1 # comment\n',
                 '# comment\na: 1\n', '---\na: 1\n', '%YAML 1.2\na: 1\n', 'a: 1\n...\n',
                 'a: 1\na: 2\n', '"é": 1\n"e\\u0301": 2\n', '"<<": {}\n', 'a: 01\n', 'a: -0\n',
                 'a: 1.0\n', 'a: 1e2\n', 'a: True\n', 'a: NULL\n', 'a: 9007199254740992\n']
    for source in forbidden:
        for width in WIDTHS:
            out.append({"name": "forbidden-" + str(len(out)), "source": shifted(source, width), "width": width,
                        "format": None, "accepted": False, "policyCase": False,
                        "productComparable": source not in ('- "root-list"\n', '[ ]\n')})
    out.extend([{"name": "inconsistent-root-dedent", "source": '  a: 1\nb: 2\n', "width": 2, "format": None, "accepted": False, "policyCase": False},
                {"name": "inconsistent-root-between", "source": '  a: 1\n b: 2\n', "width": 2, "format": None, "accepted": False, "policyCase": False}])
    return out


def package_cases():
    fixtures = [value for value in export_cases() if value["name"] in ("valid-core", "all-records-and-reports")]
    return [{"name": value["name"] + "-" + str(width), "width": width, "baselineFiles": value["files"],
             "files": {path: shifted(source, width) for path, source in value["files"].items()}} for value in fixtures for width in WIDTHS]


class RootIndentationTests(unittest.TestCase):
    def test_authoring_values_and_policy_diagnostics(self):
        for case in cases():
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    read_authoring_yaml(case["source"])
                else:
                    with self.assertRaises(ValueError) as caught:
                        read_authoring_yaml(case["source"])
                    if case["policyCase"]:
                        self.assertIsInstance(caught.exception, ValidationError)
                        self.assertEqual((caught.exception.code, caught.exception.path), (case["code"], case["path"]))

    def test_root_offset_does_not_change_logical_value(self):
        for original in authoring_cases():
            if original["accepted"]:
                expected = read_authoring_yaml(original["source"])
                for width in WIDTHS:
                    self.assertEqual(read_authoring_yaml(shifted(original["source"], width)), expected)
        self.assertEqual(read_yaml(' ' * 256 + 'a: "value"\n'), {"a": "value"})
        self.assertEqual(read_yaml('    {   }\n'), {})

    def test_nested_values_preserve_normalization(self):
        for case in cases():
            if case["name"].startswith("nested-"):
                self.assertEqual(read_yaml(case["source"]), {"a": [{"é": "é"}]})

    def test_encoding_size_and_relative_depth_limits_remain(self):
        for value in [b'\xef\xbb\xbf  a: 1\n', b'  a:\t1\n', b'  a: 1\r\n', b'  a: 1', b'  a: 1\n\n', b'  a: \xff\n', b'x' * (MAX_BYTES + 1)]:
            with self.assertRaises(ValueError):
                read_yaml(value)
        source = "".join(" " * (i * 2) + "x:\n" for i in range(MAX_DEPTH + 2))
        source += " " * ((MAX_DEPTH + 2) * 2) + "end: 1\n"
        for width in WIDTHS:
            with self.assertRaises(ValueError):
                read_yaml(shifted(source, width))

    def test_writer_stays_unindented_across_ten_record_formats(self):
        files = next(value["files"] for value in export_cases() if value["name"] == "all-records-and-reports")
        records = logical_records(read_package_files(files))
        self.assertEqual(len({record["format"] for record in records}), 10)
        for record in records:
            baseline = write_yaml(record)
            for width in WIDTHS:
                self.assertEqual(write_yaml(read_yaml(shifted(baseline, width))), baseline)

    def test_checked_package_records_and_schema_binding_keep_values_and_digests(self):
        for case in package_cases():
            before = copy.deepcopy(case)
            baseline, current = read_package_files(case["baselineFiles"]), read_package_files(case["files"])
            baseline.pop("schemaSources")
            current.pop("schemaSources")
            self.assertEqual(canonical_json(current), canonical_json(baseline))
            self.assertEqual(validate_package_files(case["files"]), validate_package_files(case["baselineFiles"]))
            self.assertEqual(case, before)

    def test_checked_report_sources_preserve_values_and_digests(self):
        for report in reports():
            source = serialize_report_yaml(report)
            expected = read_report_source(source)
            for width in WIDTHS:
                self.assertEqual(read_report_source(shifted(source, width)), expected)


if __name__ == "__main__":
    unittest.main()
