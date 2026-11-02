import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from canonical import canonical_json
from package_records import read_package_files, write_package_files
from package_validation import validate_package_files
from report_records import serialize_report_yaml
from test_graph_validation import entity
from test_package_core_validation import cases as core_cases, files_for
from test_package_validation import empty_files
from test_report_records import FIXTURES, package_files, reports
from test_schema_registry import NAME, SOURCE


SCRIPT = Path(__file__).with_name("package_records.py")


def cases():
    old = FIXTURES / "package-v1/.morivyx"
    legacy = {path.relative_to(old).as_posix(): path.read_text() for path in old.rglob("*.yaml")}
    legacy["schemas/" + NAME] = SOURCE
    full = {path: source.decode() if type(source) is bytes else source for path, source in package_files().items()}
    full["schemas/" + NAME] = SOURCE
    nullable = copy.deepcopy(next(report for report in reports() if report.get("status") == "invalid"))
    nullable.update(id="urn:uuid:ffffffff-ffff-4fff-8fff-fffffffffff1", graphRevision=None, comparedAt=None, retrieval=None)
    for field in ("artifact", "externalSource", "relation"):
        nullable[field] = {key: None for key in nullable[field]}
    full["reports/" + nullable["id"][9:] + ".yaml"] = serialize_report_yaml(nullable)
    aliases = copy.deepcopy(full)
    report_path = next(path for path in aliases if path.startswith("reports/"))
    aliases["reports/別名.yaml"] = aliases.pop(report_path)
    opaque = {**full, "schemas/unlocked.yaml": "unparsed: [\n"}
    return [{"name": "legacy-v1", "files": legacy}, {"name": "all-records-and-reports", "files": full},
            {"name": "valid-core", "files": files_for([entity(1)])},
            next({"name": "multiple-schemas", "files": case["files"]} for case in core_cases() if case["name"] == "multiple-schemas"),
            {"name": "report-alias", "files": aliases}, {"name": "opaque-schema-source", "files": opaque},
            {"name": "empty", "files": empty_files()}]


def materialize(root, files):
    for name, source in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)


def invoke(files, *flags):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        materialize(root, files)
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(root), *flags], capture_output=True, text=True)
        for name, source in files.items():
            if (root / name).read_text() != source:
                raise AssertionError("source file changed")
        return result


class PackageExportTests(unittest.TestCase):
    def test_full_export_preserves_records_digests_and_raw_schema_sources(self):
        for case in cases():
            before = copy.deepcopy(case["files"])
            with self.subTest(name=case["name"]):
                exported = invoke(case["files"], "--export-files")
                self.assertEqual(exported.returncode, 0, exported.stderr)
                self.assertEqual(exported.stderr, "")
                files = json.loads(exported.stdout)
                self.assertEqual(files, write_package_files(read_package_files(case["files"])))
                self.assertEqual(canonical_json(read_package_files(files)), canonical_json(read_package_files(case["files"])))
                self.assertEqual(validate_package_files(files), validate_package_files(case["files"]))
                self.assertEqual(case["files"], before)
                for name, source in case["files"].items():
                    if name.startswith("schemas/"):
                        self.assertEqual(files[name], source)

    def test_export_is_deterministic_and_idempotent(self):
        files = next(case["files"] for case in cases() if case["name"] == "all-records-and-reports")
        first = invoke(files, "--export-files")
        second = invoke(files, "--export-files")
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(invoke(json.loads(first.stdout), "--export-files").stdout, first.stdout)

    def test_cli_keeps_existing_modes_and_rejects_conflicting_flags(self):
        files = files_for([entity(1)])
        self.assertIn("counts", json.loads(invoke(files).stdout))
        self.assertIn("elements", json.loads(invoke(files, "--export").stdout))
        result = invoke(files, "--export", "--export-files")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_corruption_and_unknown_files_produce_no_partial_export(self):
        files = files_for([entity(1)])
        for broken in [{**files, "unknown.yaml": "{}\n"}, {**files, "revision.yaml": "{}\n"}]:
            result = invoke(broken, "--export-files")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "package read failed; no result produced\n")

    def test_reports_have_all_formats_nullable_diagnostics_and_stable_output_names(self):
        case = next(case for case in cases() if case["name"] == "report-alias")
        exported = json.loads(invoke(case["files"], "--export-files").stdout)
        self.assertNotIn("reports/別名.yaml", exported)
        package = read_package_files(exported)
        self.assertEqual(len({value["type"] for value in package["reports"]}), 4)
        self.assertTrue(any(value["report"].get("retrieval", "absent") is None for value in package["reports"]))
        for value in package["reports"]:
            self.assertIn("reports/" + value["report"]["id"][9:] + ".yaml", exported)


if __name__ == "__main__":
    unittest.main()
