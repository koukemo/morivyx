import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from canonical import canonical_json
from package_records import read_package, read_package_files, write_package_files
from package_restore import INCOMPLETE, RestoreError, restore_package_files
from package_validation import validate_package, validate_package_files
from test_package_export import cases
import package_restore


SCRIPT = Path(__file__).with_name("package_restore.py")


class PackageRestoreTests(unittest.TestCase):
    def test_all_exported_records_restore_verbatim_and_keep_existing_diagnostics(self):
        for case in cases():
            with self.subTest(name=case["name"]), tempfile.TemporaryDirectory() as temporary:
                files = write_package_files(read_package_files(case["files"]))
                original = copy.deepcopy(files)
                target = Path(temporary).resolve() / ".morivyx"
                result = restore_package_files(files, target)
                self.assertTrue(result["restored"])
                self.assertNotIn("valid", result)
                self.assertFalse(result["validation"]["schemaValidated"])
                self.assertFalse(result["validation"]["signaturesValidated"])
                self.assertEqual(result["filesWritten"], len(files))
                self.assertEqual(result["bytesWritten"], sum(len(source.encode()) for source in files.values()))
                self.assertEqual(canonical_json(read_package(target)), canonical_json(read_package_files(files)))
                self.assertEqual(validate_package(target), validate_package_files(files))
                self.assertEqual(files, original)
                self.assertNotIn(INCOMPLETE, os.listdir(target))
                self.assertEqual(stat.S_IMODE(target.stat().st_mode) & 0o077, 0)
                for name, source in files.items():
                    self.assertEqual((target / name).read_bytes(), source.encode())
                    self.assertEqual(stat.S_IMODE((target / name).stat().st_mode) & 0o077, 0)

    def test_invalid_input_is_rejected_before_creating_output(self):
        files = cases()[2]["files"]
        malformed = [None, [], {}, {**files, "unknown.yaml": "{}\n"}, {**files, "../outside.yaml": "{}\n"},
                     {**files, "revision.yaml": "{}\n"}, {**files, "schemas/bad.yaml": b"\xff"}]
        for value in malformed:
            with self.subTest(value=type(value).__name__), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary).resolve() / ".morivyx"
                with self.assertRaises((ValueError, TypeError)):
                    restore_package_files(value, target)
                self.assertFalse(target.exists())

    def test_existing_outputs_links_missing_parents_and_parent_traversal_are_rejected(self):
        files = cases()[2]["files"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            existing = root / "existing"
            existing.mkdir()
            (existing / "keep").write_bytes(b"unchanged")
            regular = root / "regular"
            regular.write_bytes(b"unchanged")
            linked = root / "linked"
            linked.symlink_to(existing, target_is_directory=True)
            dangling = root / "dangling"
            dangling.symlink_to(root / "absent")
            fifo = root / "fifo"
            os.mkfifo(fifo)
            for target in [existing, regular, linked, dangling, fifo, linked / ".morivyx", root / "missing/.morivyx", root / "existing/../new"]:
                with self.subTest(target=target.name), self.assertRaises(RestoreError) as caught:
                    restore_package_files(files, target)
                self.assertEqual(caught.exception.code, "PACKAGE_RESTORE_TARGET_UNAVAILABLE")
            self.assertEqual((existing / "keep").read_bytes(), b"unchanged")
            self.assertEqual(regular.read_bytes(), b"unchanged")
            self.assertFalse((existing / ".morivyx").exists())

    def test_stopped_writes_leave_unreadable_marked_output_without_automatic_cleanup(self):
        files = cases()[2]["files"]
        original_write = os.write
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / ".morivyx"
            count = 0

            def stopped(handle, source):
                nonlocal count
                count += 1
                if count == 2:
                    raise OSError("synthetic interrupted write")
                return original_write(handle, source)

            with patch("package_restore.os.write", side_effect=stopped), self.assertRaises(RestoreError) as caught:
                restore_package_files(files, target)
            self.assertEqual(caught.exception.code, "PACKAGE_RESTORE_INCOMPLETE")
            self.assertTrue((target / INCOMPLETE).is_symlink())
            with self.assertRaises(ValueError):
                read_package(target)
            snapshot = {p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob("*") if p.is_file()}
            self.assertTrue(snapshot)
            with self.assertRaises(RestoreError):
                restore_package_files(files, target)
            self.assertEqual({p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob("*") if p.is_file()}, snapshot)

    def test_completion_failure_keeps_marker_even_when_every_record_has_been_written(self):
        files = cases()[2]["files"]
        original_unlink = os.unlink
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / ".morivyx"

            def stopped(name, *args, **kwargs):
                if name == INCOMPLETE:
                    raise OSError("synthetic completion failure")
                return original_unlink(name, *args, **kwargs)

            with patch("package_restore.os.unlink", side_effect=stopped), self.assertRaises(RestoreError):
                restore_package_files(files, target)
            for name, source in files.items():
                self.assertEqual((target / name).read_bytes(), source.encode())
            self.assertTrue((target / INCOMPLETE).is_symlink())
            with self.assertRaises(ValueError):
                read_package(target)

    def test_readback_refuses_tampered_bytes_and_preserves_incomplete_output(self):
        files = cases()[2]["files"]
        original_check = package_restore._check_file
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / ".morivyx"

            def tampered(parent, name, expected):
                if name == "revision.yaml":
                    (target / name).write_bytes(b"tampered")
                return original_check(parent, name, expected)

            with patch("package_restore._check_file", side_effect=tampered), self.assertRaises(RestoreError):
                restore_package_files(files, target)
            self.assertTrue((target / INCOMPLETE).is_symlink())
            self.assertEqual((target / "revision.yaml").read_bytes(), b"tampered")

    def test_exclusive_write_never_follows_an_injected_link(self):
        files = cases()[2]["files"]
        original_write = package_restore._write_file
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            sentinel = root / "outside"
            sentinel.write_bytes(b"unchanged")
            target = root / ".morivyx"

            def injected(parent, name, source):
                os.symlink(sentinel, name, dir_fd=parent)
                return original_write(parent, name, source)

            with patch("package_restore._write_file", side_effect=injected), self.assertRaises(RestoreError):
                restore_package_files(files, target)
            self.assertEqual(sentinel.read_bytes(), b"unchanged")
            self.assertTrue((target / INCOMPLETE).is_symlink())

    def test_short_writes_are_completed_before_success(self):
        files = cases()[2]["files"]
        original_write = os.write
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / ".morivyx"
            with patch("package_restore.os.write", side_effect=lambda handle, source: original_write(handle, source[:3])):
                self.assertTrue(restore_package_files(files, target)["restored"])
            self.assertEqual(canonical_json(read_package(target)), canonical_json(read_package_files(files)))

    def test_cli_success_and_input_failures_have_no_input_echo_or_existing_output_changes(self):
        files = write_package_files(read_package_files(cases()[2]["files"]))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for index, source in enumerate([b"\xff", b'{"NEVER_ECHO":', b'{"duplicate":1,"duplicate":2}', json.dumps({**files, "NEVER_ECHO": "secret"}).encode(), b" " * (8 * 1024 * 1024 + 1)]):
                target = root / f"rejected-{index}"
                result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(target)], input=source, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(json.loads(result.stderr), {"error": {"code": "PACKAGE_RESTORE_INPUT_INVALID", "path": "/"}})
                self.assertFalse(target.exists())
            target = root / ".morivyx"
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(target)], input=json.dumps(files).encode(), capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, b"")
            self.assertTrue(json.loads(result.stdout)["restored"])
            before = {name: (target / name).read_bytes() for name in files}
            second = subprocess.run([sys.executable, "-B", str(SCRIPT), str(target)], input=json.dumps(files).encode(), capture_output=True, timeout=30)
            self.assertEqual(second.returncode, 1)
            self.assertEqual(json.loads(second.stderr)["error"]["code"], "PACKAGE_RESTORE_TARGET_UNAVAILABLE")
            self.assertEqual({name: (target / name).read_bytes() for name in files}, before)


if __name__ == "__main__":
    unittest.main()
