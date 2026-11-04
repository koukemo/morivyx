import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import package_records as implementation
from package_records import read_package, read_package_file_sources, read_package_files, write_package_files
from yaml_records import read_yaml, write_yaml


FIXTURES = Path(__file__).resolve().parents[1] / "kernel/test/fixtures"
VECTOR = json.loads((FIXTURES / "graph-package-roundtrip-vector.json").read_text())
INPUT_ROOT = FIXTURES / VECTOR["inputRoot"]


def inputs():
    return {path: (INPUT_ROOT / path).read_bytes() for path in VECTOR["inputFiles"]}


def materialize(root):
    root.mkdir()
    for path, source in inputs().items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source)


class PackageRecordTests(unittest.TestCase):
    def test_existing_package_read_and_write(self):
        files = inputs()
        before = copy.deepcopy(files)
        result = read_package_files(files)
        for field in ["schemaLock", "revision", "elements", "approvals", "changeSets", "migrations"]:
            self.assertEqual(result[field], VECTOR["inputLogicalValue"][field])
        self.assertEqual(result["reports"][0]["report"], VECTOR["inputLogicalValue"]["reports"][0]["report"])
        self.assertEqual(result["validation"]["scope"], "record-structures-digests-and-bindings")
        for field in ("recordStructuresValidated", "reportsValidated", "approvalLedgerValidated", "migrationBindingsValidated"):
            self.assertTrue(result["validation"][field])
        for field in ("schemaValidated", "graphReferencesValidated", "signaturesValidated"):
            self.assertFalse(result["validation"][field])
        self.assertTrue(result["reports"][0]["valid"])
        written = write_package_files(result)
        self.assertEqual(written, {path: (FIXTURES / expected).read_text()
                                  for path, expected in VECTOR["expectedOutputFiles"].items()})
        self.assertEqual(write_package_files(read_package_files(written)), written)
        self.assertEqual(files, before)

    def test_layout_and_record_identity_rejections(self):
        for path in ["/revision.yaml", "../revision.yaml", "graph/entities/../revision.yaml",
                     "graph/entities/nested/file.yaml", "unknown.yaml"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                read_package_files({**inputs(), path: b"{}\n"})
        files = inputs()
        del files["revision.yaml"]
        with self.assertRaises(ValueError):
            read_package_files(files)
        path = VECTOR["inputFiles"][2]
        for field, value in [("id", "urn:uuid:550e8400-e29b-41d4-a716-446655440099"),
                             ("format", "unknown"), ("kind", "relation")]:
            files = inputs()
            record = read_yaml(files[path])
            record[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                read_package_files({**files, path: write_yaml(record) if field != "format" else files[path].replace(
                    b"morivyx.git-graph/0.1", b"unknown")})
        files = inputs()
        original = read_yaml(files[VECTOR["inputFiles"][3]])
        original.update(format="morivyx.approval/0.1")
        files["approvals/" + original["id"][9:] + ".yaml"] = write_yaml(original)
        with self.assertRaises(ValueError):
            read_package_files(files)

    def test_three_digest_mismatches_are_rejected(self):
        for subject in ["element", "schema-lock", "root"]:
            files = inputs()
            path = VECTOR["inputFiles"][2] if subject == "element" else "revision.yaml"
            record = read_yaml(files[path])
            if subject == "element":
                record["attributes"]["stringValues"].append("changed")
            else:
                record["schemaLockDigest" if subject == "schema-lock" else "rootDigest"] = "sha256:" + "0" * 64
            files[path] = write_yaml(record)
            with self.subTest(subject=subject), self.assertRaises(ValueError):
                read_package_files(files)

    def test_output_collisions_and_untrusted_claims(self):
        package = read_package_files(inputs())
        package["elements"].append(copy.deepcopy(package["elements"][0]))
        with self.assertRaises(ValueError):
            write_package_files(package)
        package = read_package_files(inputs())
        package["validation"] = {"schemaValidated": True}
        reread = read_package_files(write_package_files(package))
        self.assertFalse(reread["validation"]["schemaValidated"])
        package["elements"][0]["attributes"]["stringValues"].append("tampered")
        with self.assertRaises(ValueError):
            write_package_files(package)

    def test_resource_limits_apply_to_read_and_write(self):
        package = read_package_files(inputs())
        for setting, value in [("MAX_FILES", 8), ("MAX_TOTAL_BYTES", 1)]:
            with self.subTest(setting=setting), patch.object(implementation, setting, value):
                with self.assertRaises(ValueError):
                    read_package_files(inputs())
                with self.assertRaises(ValueError):
                    write_package_files(package)
                with self.assertRaises(ValueError):
                    read_package(INPUT_ROOT)
        with patch.object(implementation, "MAX_BYTES", 1), self.assertRaises(ValueError):
            read_package_files(inputs())

    def test_explicit_filesystem_read_is_unchanged(self):
        before = inputs()
        self.assertEqual(read_package(INPUT_ROOT), read_package_files(before))
        self.assertEqual(inputs(), before)

    def test_file_sources_retain_spelling_and_report_aliases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "package"
            materialize(root)
            report = next(root.glob("reports/*.yaml"))
            report.rename(root / "reports/別名.yaml")
            revision = root / "revision.yaml"
            revision.write_bytes(revision.read_bytes().replace(b"\n", b"\n\n", 1))
            expected = {path.relative_to(root).as_posix(): path.read_bytes().decode("utf-8")
                        for path in root.rglob("*.yaml")}
            actual = read_package_file_sources(root)
            self.assertEqual(actual, expected)
            self.assertIn("\n\n", actual["revision.yaml"])
            self.assertIn("reports/別名.yaml", actual)
            self.assertEqual(read_package_files(actual), read_package(root))
            actual.clear()
            self.assertEqual(read_package_file_sources(root), expected)

    def test_file_sources_validate_before_returning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "package"
            materialize(root)
            (root / "revision.yaml").write_bytes(b"\xff")
            with self.assertRaises(ValueError):
                read_package_file_sources(root)
            (root / "revision.yaml").write_text("{}\n")
            with self.assertRaises(ValueError):
                read_package_file_sources(root)
        with patch.object(implementation, "MAX_TOTAL_BYTES", 1), self.assertRaises(ValueError):
            read_package_file_sources(INPUT_ROOT)

    def test_links_special_files_and_unknown_entries(self):
        for kind in ["root-link", "ancestor-link", "file-link", "directory-link", "hard-link", "fifo", "unknown"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                parent = Path(temporary).resolve()
                root = parent / "package"
                materialize(root)
                path = root / "revision.yaml"
                selected = root
                if kind == "root-link":
                    selected = parent / "linked"
                    selected.symlink_to(root, target_is_directory=True)
                elif kind == "ancestor-link":
                    alias = parent / "linked"
                    alias.symlink_to(parent, target_is_directory=True)
                    selected = alias / "package"
                elif kind == "file-link":
                    external = parent / "external.yaml"
                    path.rename(external)
                    path.symlink_to(external)
                elif kind == "directory-link":
                    directory = root / "graph/entities"
                    external = parent / "external"
                    directory.rename(external)
                    directory.symlink_to(external, target_is_directory=True)
                elif kind == "hard-link":
                    os.link(path, parent / "linked.yaml")
                elif kind == "fifo":
                    path.unlink()
                    os.mkfifo(path)
                else:
                    (root / "unknown.yaml").write_text("{}\n")
                for reader in (read_package, read_package_file_sources):
                    with self.assertRaises((ValueError, OSError)):
                        reader(selected)

    def test_record_change_during_read_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "package"
            materialize(root)
            original = os.read

            def changed(handle, count):
                result = original(handle, count)
                current = os.fstat(handle)
                os.utime(handle, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000_000))
                return result

            with patch.object(implementation.os, "read", side_effect=changed), self.assertRaises(ValueError):
                read_package(root)
            with patch.object(implementation.os, "read", side_effect=changed), self.assertRaises(ValueError):
                read_package_file_sources(root)

    def test_standalone_cli_inspection_and_logical_export(self):
        command = [sys.executable, "-B", str(Path(__file__).with_name("package_records.py")), str(INPUT_ROOT)]
        inspected = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        value = json.loads(inspected.stdout)
        self.assertEqual(value["counts"], {"elements": 2, "approvals": 1, "changeSets": 2, "migrations": 1, "reports": 1})
        self.assertFalse(value["validation"]["schemaValidated"])
        exported = subprocess.run(command + ["--export"], capture_output=True, text=True, timeout=10)
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertEqual(json.loads(exported.stdout), read_package_files(inputs()))

    def test_standalone_cli_fails_without_printing_bad_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "package"
            materialize(root)
            (root / "revision.yaml").write_text("private-diagnostic-marker\n")
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("package_records.py")),
                                     str(root)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "package read failed; no result produced\n")


if __name__ == "__main__":
    unittest.main()
