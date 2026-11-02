import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from package_records import read_package, read_package_files, write_package_files
from report_records import prepare_report, read_report_source, serialize_report_yaml
from schema_validation import ValidationError
from test_package_records import inputs
from yaml_records import read_yaml, write_yaml


FIXTURES = Path(__file__).resolve().parents[1] / "kernel/test/fixtures"
NORMAL = json.loads(json.loads((FIXTURES / "semantic-diff-digest-vector.json").read_text())["expected"]["canonicalJson"])
MIGRATION = json.loads(json.loads((FIXTURES / "migration-semantic-diff-digest-vector.json").read_text())["expected"]["canonicalJson"])
EXTERNAL = [case["expected"] for case in json.loads((FIXTURES / "external-artifact-comparison-vectors.json").read_text())["cases"]]


def reports():
    values = copy.deepcopy([NORMAL, MIGRATION, *EXTERNAL])
    for index, value in enumerate(values):
        value["id"] = f"urn:uuid:00000000-0000-4000-8000-{500+index:012x}"
    return values


def package_files():
    files = inputs()
    for report in reports():
        files["reports/" + report["id"][9:] + ".yaml"] = serialize_report_yaml(report)
    return files


class ReportRecordTests(unittest.TestCase):
    def test_all_four_formats_round_trip_and_preserve_input(self):
        values = reports()
        before = copy.deepcopy(values)
        for report in values:
            source = serialize_report_yaml(report)
            self.assertEqual(read_report_source(source), prepare_report(report))
            self.assertEqual(write_yaml(read_yaml(source)), source)
        self.assertEqual(values, before)
        self.assertEqual(set(r["type"] for r in read_package_files(package_files())["reports"]),
                         {"trace-report", "semantic-diff", "migration-semantic-diff", "external-artifact-report"})

    def test_invalid_status_null_policy_preserves_diagnostic_values(self):
        value = copy.deepcopy(next(r for r in EXTERNAL if r["status"] == "invalid"))
        value.update(graphRevision=None, comparedAt=None)
        for field in ("artifact", "externalSource", "relation"):
            for key in value[field]:
                value[field][key] = None
        value["retrieval"] = {field: None for field in "status comparedAt digest digestRule externalVersion method reason".split()}
        self.assertEqual(read_report_source(serialize_report_yaml(value))["report"], value)
        value["retrieval"] = None
        self.assertEqual(read_report_source(serialize_report_yaml(value))["report"], value)
        for record in [copy.deepcopy(NORMAL), copy.deepcopy(EXTERNAL[0])]:
            record["unexpected"] = None
            with self.assertRaises(ValueError):
                write_yaml(record)

    def test_package_read_and_write_reject_invalid_report_claims(self):
        files = package_files()
        package = read_package_files(files)
        self.assertTrue(package["validation"]["reportsValidated"])
        self.assertFalse(package["validation"]["schemaValidated"])
        self.assertTrue(all(r["valid"] for r in package["reports"]))
        value = package["reports"][0]["report"]
        value["format"] = "unknown"
        with self.assertRaises(ValidationError):
            write_package_files(package)
        files = package_files()
        path = next(path for path in files if path.startswith("reports/"))
        report = read_yaml(files[path])
        report["format"] = "unknown"
        previous = files[path]
        if type(previous) is bytes:
            previous = previous.decode("utf-8")
        original_format = read_yaml(previous)["format"]
        files[path] = previous.replace('format: "' + original_format + '"', 'format: "unknown"')
        self.assertNotEqual(files[path], previous)
        # A syntax-valid report with an unknown format must never be skipped.
        with self.assertRaises(ValueError):
            read_package_files(files)

    def test_report_identity_collision_and_filename_mismatch(self):
        files = package_files()
        package = read_package_files(files)
        report = copy.deepcopy(package["reports"][0]["report"])
        report["id"] = package["elements"][0]["id"]
        files["reports/" + report["id"][9:] + ".yaml"] = serialize_report_yaml(report)
        with self.assertRaises(ValueError):
            read_package_files(files)
        files = package_files()
        report = reports()[0]
        files["reports/00000000-0000-4000-8000-000000000999.yaml"] = serialize_report_yaml(report)
        with self.assertRaises(ValueError):
            read_package_files(files)

    def test_all_report_files_survive_disk_read_and_cli_export(self):
        files = write_package_files(read_package_files(package_files()))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for path, source in files.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source)
            package = read_package(root)
            self.assertEqual(len(package["reports"]), 8)
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("package_records.py")), str(root), "--export"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["reports"], package["reports"])
            for path, source in files.items():
                self.assertEqual((root / path).read_text(), source)

    def test_bad_report_is_rejected_by_cli_without_modifying_any_file(self):
        files = write_package_files(read_package_files(package_files()))
        path = next(path for path in files if path.startswith("reports/") and 'format: "morivyx.trace-report/0.1"' in files[path])
        report = read_yaml(files[path])
        report["status"] = "unknown"
        files[path] = write_yaml(report)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name, source in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source)
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("package_records.py")), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("unknown", result.stderr)
            for name, source in files.items():
                self.assertEqual((root / name).read_text(), source)


if __name__ == "__main__":
    unittest.main()
