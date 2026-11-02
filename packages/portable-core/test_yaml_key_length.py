import copy
import unittest

from canonical import canonical_json, digest
from package_records import read_package_files, write_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from test_package_export import cases as export_cases
from test_report_records import reports
from yaml_records import key_value, mapping_pair, read_yaml


def spellings():
    rows = []
    def add(name, token, key, accepted, spaces=0):
        rows.append(dict(name=name, token=token, key=key, accepted=accepted, gap=" " * spaces))
    for n, accepted in [(1023, True), (1024, True), (1025, False)]:
        add(f"ascii-{n}", "a" * n, "a" * n, accepted)
        add(f"bmp-{n}", "日" * n, "日" * n, accepted)
    for quote in ("'", '"'):
        for n, accepted in [(1021, True), (1022, True), (1023, False)]:
            add(f"quoted-{ord(quote)}-{n}", quote + "a" * n + quote, "a" * n, accepted)
        for n, accepted in [(510, True), (511, True), (512, True), (1022, True), (1023, False)]:
            add(f"quoted-astral-{ord(quote)}-{n}", quote + "😀" * n + quote, "😀" * n, accepted)
    for n, accepted in [(511, True), (512, True), (513, True), (1023, True), (1024, True), (1025, False)]:
        add(f"astral-{n}", "😀" * n, "😀" * n, accepted)
    for n, accepted in [(170, True), (171, False)]:
        add(f"escape-ascii-{n}", '"' + "\\u0061" * n + '"', "a" * n, accepted)
    for n, accepted in [(85, True), (86, False)]:
        add(f"escape-pair-{n}", '"' + "\\uD83D\\uDE00" * n + '"', "😀" * n, accepted)
    for n, accepted in [(102, True), (103, False)]:
        add(f"escape-astral-{n}", '"' + "\\U0001F600" * n + '"', "😀" * n, accepted)
    for n, accepted in [(340, True), (341, False)]:
        add(f"apostrophe-{n}", "'" + "a''" * n + "'", "a'" * n, accepted)
    for n, accepted in [(512, True), (513, False)]:
        add(f"nfd-{n}", "é" * n, "é" * n, accepted)
        add(f"variation-{n}", "✈️" * n, "✈️" * n, accepted)
    for n, accepted in [(1022, True), (1023, False)]:
        add(f"nfc-boundary-{n}", "é" + "a" * n, "é" + "a" * n, accepted)
    for n, accepted in [(341, True), (342, False)]:
        add(f"joiner-{n}", "👩‍💻" * n, "👩‍💻" * n, accepted)
    for token, key in [("key", "key"), ("?x", "?x"), (":x", ":x"), ("a#b", "a#b"), ('""', "")]:
        for total, accepted in [(1023, True), (1024, True), (1025, False)]:
            add(f"separation-{token}-{total}", token, key, accepted, total - len(token))
    return rows


def cases():
    rows = []
    for row in spellings():
        for explicit in (False, True):
            line = ("? " + row["token"] + row["gap"] + '\n: "value"\n') if explicit else (
                row["token"] + row["gap"] + ': "value"\n')
            for context in ("root", "nested", "compact"):
                if context == "root":
                    source, expected = line, {row["key"]: "value"}
                elif context == "nested":
                    source = "outer:\n" + "\n".join("  " + s for s in line.splitlines()) + '\nnext: "after"\n'
                    expected = {"outer": {row["key"]: "value"}, "next": "after"}
                else:
                    parts = line.splitlines()
                    source = "outer:\n  - " + parts[0] + "\n" + "".join("    " + s + "\n" for s in parts[1:]) + 'next: "after"\n'
                    expected = {"outer": [{row["key"]: "value"}], "next": "after"}
                for indent in (0, 2, 5):
                    indented = "\n".join(" " * indent + s for s in source.splitlines()) + "\n"
                    rows.append(dict(name=f"{row['name']}-{explicit}-{context}-{indent}", source=indented,
                                     accepted=explicit or row["accepted"], expected=expected))
    return rows


def replace_key_source(source, key, token, gap):
    lines, result, index, replaced = source.splitlines(), [], 0, False
    while index < len(lines):
        raw = lines[index]
        text = raw.lstrip(" ")
        prefix = raw[:len(raw) - len(text)]
        pair = mapping_pair(text)
        if text.startswith("? ") and key_value(text[2:]) == key:
            index += 1
            assert lines[index].startswith(prefix + ":")
            result.append(prefix + token + gap + lines[index][len(prefix):])
            replaced = True
        elif pair is not None and key_value(pair[0]) == key:
            result.append(prefix + token + gap + ": " + pair[1])
            replaced = True
        else:
            result.append(raw)
        index += 1
    assert replaced
    return "\n".join(result) + "\n"


def package_cases():
    original = next(row for row in export_cases() if row["name"] == "valid-core")
    selected = {"astral-1024", "astral-1025", "quoted-astral-34-1022", "nfc-boundary-1023", "separation-key-1025"}
    result = []
    for row in spellings():
        if row["name"] not in selected:
            continue
        package = read_package_files(original["files"])
        entity = package["elements"][0]
        entity["extensions"] = {"example.test/key-length": {row["key"]: "value"}}
        entity["revision"] = digest("revision", entity)["digest"]
        package["revision"]["rootDigest"] = digest("root", package["elements"])["digest"]
        baseline = write_package_files(package)
        path = next(name for name in baseline if name.startswith("graph/entities/"))
        files = {**baseline, path: replace_key_source(baseline[path], row["key"], row["token"], row["gap"])}
        result.append(dict(name=row["name"], baselineFiles=baseline, files=files, accepted=row["accepted"]))
    assert len(result) == len(selected)
    return result


def report_cases():
    result = []
    for index, report in enumerate(reports()):
        baseline = serialize_report_yaml(report)
        for span in (1024, 1025):
            source = baseline.replace("format:", "format" + " " * (span - 6) + ":", 1)
            result.append(dict(name=f"report-{index}-{span}", baseline=baseline, source=source, accepted=span == 1024))
    return result


class ImplicitKeyLengthTests(unittest.TestCase):
    def test_source_spelling_boundaries_and_unicode(self):
        for row in cases():
            if "-False-" not in row["name"]:
                continue
            with self.subTest(name=row["name"]):
                if row["accepted"]:
                    self.assertEqual(read_yaml(row["source"]), row["expected"])
                else:
                    with self.assertRaises(ValueError):
                        read_yaml(row["source"])

    def test_explicit_keys_keep_long_names(self):
        for row in cases():
            if "-True-" in row["name"]:
                with self.subTest(name=row["name"]):
                    self.assertEqual(read_yaml(row["source"]), row["expected"])

    def test_valid_and_invalid_package_sources_keep_logical_values(self):
        for row in package_cases():
            before = copy.deepcopy(row)
            if row["accepted"]:
                baseline = read_package_files(row["baselineFiles"])
                actual = read_package_files(row["files"])
                self.assertEqual(canonical_json(actual), canonical_json(baseline))
                self.assertEqual(validate_package_files(row["files"]), validate_package_files(row["baselineFiles"]))
                self.assertTrue(validate_package_files(row["files"])["valid"])
            else:
                with self.assertRaises(ValueError):
                    read_package_files(row["files"])
            self.assertEqual(row, before)

    def test_report_separation_counts_and_unchanged_digests(self):
        for row in report_cases():
            if row["accepted"]:
                self.assertEqual(read_report_source(row["source"]), read_report_source(row["baseline"]))
                self.assertEqual(serialize_report_yaml(read_report_source(row["source"])["report"]), row["baseline"])
            else:
                with self.assertRaises(ValueError):
                    read_report_source(row["source"])


if __name__ == "__main__":
    unittest.main()
