import copy
import unittest

from canonical import canonical_json
from package_records import read_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from test_package_export import cases as export_cases
from test_report_records import reports
from test_yaml_authoring import cases as authoring_cases
from yaml_authoring import read_authoring_yaml
from yaml_records import MAX_BYTES, MAX_DEPTH, key_value, mapping_pair, read_yaml, write_yaml, yaml_quote


def explicit(source, mode=0):
    """Change mapping syntax only; keep field and list order and all values."""
    result = []
    for raw in source.split("\n")[:-1]:
        indent = len(raw) - len(raw.lstrip(" "))
        text, prefix = raw.lstrip(" "), " " * indent
        while text.startswith("- "):
            prefix += "- "
            indent += 2
            text = text[2:]
        pair = mapping_pair(text)
        if pair is None:
            result.append(raw)
            continue
        key, rest = pair
        key = key_value(key)
        quoted = yaml_quote(key)
        if mode == 1:
            result.extend([prefix + "?", " " * (indent + 2) + quoted])
        elif mode == 2:
            result.extend([prefix + '? "\\', " " * (indent + 2) + quoted[1:]])
        elif mode == 3:
            result.append(prefix + "? '" + key.replace("'", "''") + "'")
        else:
            result.append(prefix + "? " + quoted)
        result.append(" " * indent + ": " + rest)
    return "\n".join(result) + "\n"


def examples():
    return [
        ("plain", '? key\n: "value"\n', {"key": "value"}),
        ("double", '? "key"\n: "value"\n', {"key": "value"}),
        ("single", "? 'it''s'\n: \"value\"\n", {"it's": "value"}),
        ("empty", '? ""\n: "value"\n', {"": "value"}),
        ("numeric-string", '? "42"\n: 42\n', {"42": 42}),
        ("separate-key", '?\n  "key"\n: "value"\n', {"key": "value"}),
        ("separate-plain", '?\n  key\n: "value"\n', {"key": "value"}),
        ("fold-double", '? "first\n  second"\n: "value"\n', {"first second": "value"}),
        ("fold-single", "? 'first\n  second'\n: \"value\"\n", {"first second": "value"}),
        ("fold-plain", '? first\n  second\n: "value"\n', {"first second": "value"}),
        ("blank-double", '? "first\n\n  second"\n: "value"\n', {"first\nsecond": "value"}),
        ("blank-single", "? 'first\n\n  second'\n: \"value\"\n", {"first\nsecond": "value"}),
        ("blank-plain", '? first\n\n  second\n: "value"\n', {"first\nsecond": "value"}),
        ("separation", '? key\n\n: "value"\n', {"key": "value"}),
        ("escaped-break", '? "e\\\n  \\u0301"\n: "value"\n', {"é": "value"}),
        ("surrogates", '? "\\uD83D\\\n  \\uDE00"\n: "value"\n', {"😀": "value"}),
        ("unicode-single", "? 'é'\n: \"value\"\n", {"é": "value"}),
        ("nested", 'outer:\n  ? "key"\n  : "value"\n', {"outer": {"key": "value"}}),
        ("compact", 'outer:\n  - ? "key"\n    : "value"\n', {"outer": [{"key": "value"}]}),
        ("compact-bare", 'outer:\n  - ?\n      "key"\n    : "value"\n', {"outer": [{"key": "value"}]}),
        ("nested-lists", 'outer:\n  - - ? "key"\n      : "value"\n', {"outer": [[{"key": "value"}]]}),
        ("list-value", '? key\n:\n  - "a"\n  - "b"\n', {"key": ["a", "b"]}),
        ("indentless-value", '? key\n:\n- "a"\nnext: "after"\n', {"key": ["a"], "next": "after"}),
        ("multiline-value", '? key\n: "a\n  b"\n', {"key": "a b"}),
        ("compact-map-value", '? key\n: nested: "value"\n', {"key": {"nested": "value"}}),
        ("compact-seq-value", '? key\n: - "one"\n  - "two"\n', {"key": ["one", "two"]}),
        ("compact-value-spaces", '? key\n:   nested: "value"\n', {"key": {"nested": "value"}}),
        ("compact-explicit-value", '? outer\n: ? inner\n  : "value"\n', {"outer": {"inner": "value"}}),
        ("markers-in-key", '? "a\n  # text\n  ---\n  % text"\n: "v"\n', {"a # text --- % text": "v"}),
        ("question-literal", '"? key": "value"\n', {"? key": "value"}),
        ("colon-literal", '? ": value"\n: "value"\n', {": value": "value"}),
    ]


def invalid_sources():
    return [
        '?\n: "value"\n', '? key\n', '? "key"\nnext: "value"\n',
        '? "key"\n  : "value"\n', '? "key"\n:value\n', '? "key" : "value"\n',
        '? key: "value"\n: "other"\n', '? ["key"]\n: "value"\n', '? {}\n: "value"\n',
        '?\n  nested: "key"\n: "value"\n', '?\n  - "key"\n: "value"\n',
        '? true\n: "value"\n', '? 42\n: "value"\n', '? null\n: "value"\n',
        '? !tag "key"\n: "value"\n', '? &anchor "key"\n: "value"\n', '? *alias\n: "value"\n',
        '? "<<"\n: "value"\n', '? <<\n: "value"\n',
        '? "key" # comment\n: "value"\n', '? key # comment\n: "value"\n',
        '? "key"\n# comment\n: "value"\n', '? "key"\n: "value" # comment\n',
        '? "first\nsecond"\n: "value"\n', "? 'first\nsecond'\n: \"value\"\n",
        '? "first\n  second\n: "value"\n', '? "\\q"\n: "value"\n', '? "\\uD800"\n: "value"\n',
        '? "key"\n: "value"\nkey: "duplicate"\n', '? "é"\n: 1\n? "e\\u0301"\n: 2\n',
        '? "key"\n: "value"\n\n', '? "key"\r\n: "value"\r\n', '? "key"\n:\t"value"\n',
    ]


def cases():
    result = []
    for name, source, expected in examples():
        for indent in (0, 2, 5):
            indented = "\n".join(" " * indent + line if line else line for line in source.split("\n")[:-1]) + "\n"
            result.append(dict(name=f"{name}-indent-{indent}", source=indented, accepted=True, expected=expected))
    result.extend(dict(name=f"invalid-{i}", source=source, accepted=False) for i, source in enumerate(invalid_sources()))
    for original in authoring_cases():
        for mode in range(4):
            result.append({**original, "name": original["name"] + f"-explicit-{mode}",
                           "source": explicit(original["source"], mode), "policyCase": True})
    return result


def package_cases():
    return [dict(name=original["name"] + f"-explicit-{mode}", baselineFiles=original["files"],
                 files={name: explicit(source, mode) for name, source in original["files"].items()})
            for original in export_cases() if original["name"] in ("valid-core", "all-records-and-reports", "report-alias")
            for mode in range(4)]


def long_keys():
    return ["a" * n for n in (1022, 1023, 1024, 1025, 1200)] + [
        ": " + "a" * n for n in (1018, 1019, 1020, 1021, 1022)] + [
        "😀" * n for n in (510, 511, 512, 513, 1025)] + [
        "a" * 1018 + "\0", "a" * 1018 + "\n", "a" * 1018 + '"', "a" * 1018 + "\\"]


class ExplicitKeyTests(unittest.TestCase):
    def test_strings_folding_and_container_positions(self):
        for case in cases():
            if "expected" in case:
                with self.subTest(name=case["name"]):
                    self.assertEqual(read_yaml(case["source"]), case["expected"])

    def test_existing_authoring_rules_and_diagnostics(self):
        for original in authoring_cases():
            try:
                baseline, error = read_authoring_yaml(original["source"]), None
            except ValueError as caught:
                error = (getattr(caught, "code", None), getattr(caught, "path", None))
            for mode in range(4):
                source = explicit(original["source"], mode)
                if error:
                    with self.assertRaises(ValueError) as caught:
                        read_authoring_yaml(source)
                    self.assertEqual((getattr(caught.exception, "code", None), getattr(caught.exception, "path", None)), error)
                else:
                    self.assertEqual(read_authoring_yaml(source), baseline)

    def test_invalid_sources_and_bounds(self):
        for source in invalid_sources() + [b'? "bad\xff"\n: "v"\n', '? "' + "a" * MAX_BYTES + '"\n: "v"\n']:
            with self.subTest(source=str(source)[:40]), self.assertRaises(ValueError):
                read_yaml(source)
        nested = "".join(" " * (2 * i) + '? "key"\n' + " " * (2 * i) + ":\n" for i in range(MAX_DEPTH + 2))
        with self.assertRaises(ValueError):
            read_yaml(nested + " " * (2 * (MAX_DEPTH + 2)) + 'end: "value"\n')

    def test_packages_and_original_inputs(self):
        for case in package_cases():
            before = copy.deepcopy(case)
            baseline, actual = read_package_files(case["baselineFiles"]), read_package_files(case["files"])
            baseline.pop("schemaSources"); actual.pop("schemaSources")
            self.assertEqual(canonical_json(actual), canonical_json(baseline))
            self.assertEqual(validate_package_files(case["files"]), validate_package_files(case["baselineFiles"]))
            self.assertEqual(case, before)

    def test_reports_digests_and_writer_are_unchanged(self):
        for report in reports():
            baseline = serialize_report_yaml(report)
            for mode in range(4):
                source = explicit(baseline, mode)
                self.assertEqual(read_report_source(source), read_report_source(baseline))
                self.assertEqual(write_yaml(read_yaml(source)), baseline)

    def test_long_keys_keep_values_across_writer_and_reader(self):
        for key in long_keys():
            for value in ("value", {"nested": "value"}, ["one", "two"], [{key: "nested"}]):
                record = {"format": "morivyx.git-graph/0.1", "extensions": {"example.test/key": {key: value}}}
                before = copy.deepcopy(record)
                source = write_yaml(record)
                self.assertEqual(read_yaml(source), record)
                self.assertEqual(record, before)
                self.assertEqual(write_yaml(read_yaml(source)), source)


if __name__ == "__main__":
    unittest.main()
