import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import repository_import

from canonical import canonical_json
from plugin_messages import validate_plugin_run_result
from repository_import import (RepositoryImportError, assess_repository_reimport, compare_repository_import_snapshots,
                               import_repository_file, repository_import_request, validate_repository_import_request,
                               validate_repository_import_result)
from schema_validation import ValidationError

CORE = Path(__file__).parent
VECTORS = json.loads((CORE / "fixtures/repository-import-vectors.json").read_text())
FIXTURE = CORE.parent / "kernel/test/fixtures/plugin-communication/repository"


def evaluate(entry, fixture=FIXTURE):
    value = copy.deepcopy(entry["input"])
    if entry["operation"] == "import" and type(value) is dict and type(value.get("input")) is dict:
        root = value["input"].get("repositoryRoot")
        if type(root) is str and root.startswith("@FIXTURE@"):
            value["input"]["repositoryRoot"] = str(fixture) + root[len("@FIXTURE@"):]
    try:
        operation = entry["operation"]
        if operation == "validate-request":
            result = validate_repository_import_request(value)
        elif operation == "validate-result":
            result = validate_repository_import_result(value["result"], value.get("request"))
        elif operation == "compare":
            result = compare_repository_import_snapshots(value)
        elif operation == "assess":
            result = assess_repository_reimport(value)
        else:
            result = import_repository_file(value, now=lambda: entry.get("now", "2026-09-05T01:00:00Z"))
        raw = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        return {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(result).encode()).hexdigest(),
                "resultJsonSha256": hashlib.sha256(raw.encode()).hexdigest()}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


class RepositoryImportTests(unittest.TestCase):
    def test_all_frozen_results_preserve_inputs_and_unique_names(self):
        self.assertEqual(len({entry["id"] for entry in VECTORS["cases"]}), len(VECTORS["cases"]))
        for entry in VECTORS["cases"]:
            with self.subTest(id=entry["id"]):
                before = copy.deepcopy(entry)
                self.assertEqual(evaluate(entry), entry["expected"])
                self.assertEqual(entry, before)

    def test_builders_validators_and_detached_reports(self):
        request = repository_import_request(run_id="e\u0301", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        self.assertIs(validate_repository_import_request(request), request)
        result = import_repository_file(request, now=lambda: "2026-09-05T01:00:00Z")
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["runId"], "e\u0301")
        self.assertIs(validate_repository_import_result(result, request), result)
        comparison = compare_repository_import_snapshots({"previousResult": result, "currentRequest": request, "currentResult": result})
        self.assertEqual(comparison["status"], "current")
        comparison["externalIdentity"]["externalId"] = "mutated"
        self.assertEqual(result["output"]["externalIdentity"]["externalId"], "owned")
        target = {"id": "target", "revision": "base"}
        assessment = assess_repository_reimport({"comparison": {"format": comparison["format"], "status": "stale"},
                                                "baselineTarget": target, "currentTarget": target})
        self.assertEqual(assessment["status"], "external-changed")
        assessment["baselineTarget"]["revision"] = "mutated"
        self.assertEqual(target["revision"], "base")

    def test_binary_content_missing_roots_symlinks_and_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "root"
            root.mkdir()
            content = bytes(range(256)) + b"\x00\r\n"
            (root / "binary").write_bytes(content)
            (Path(temp) / "outside").write_text("owned")
            (root / "inside").symlink_to(root / "binary")
            (root / "escape").symlink_to(Path(temp) / "outside")
            (root / "self").symlink_to(root)
            (root / "loop").symlink_to(root / "loop")
            (root / "directory").mkdir()
            request = repository_import_request(run_id="owned", repository_root=str(root), external_id="owned", locator="binary")
            for locator in ["binary", "inside"]:
                result = import_repository_file({**request, "input": {**request["input"], "locator": locator}})
                self.assertEqual(result["output"]["digest"], "sha256:" + hashlib.sha256(content).hexdigest())
            for locator, code in [("missing", "REPOSITORY_IMPORT_TARGET_MISSING"), ("escape", "REPOSITORY_IMPORT_OUTSIDE_ROOT"),
                                  ("self", "REPOSITORY_IMPORT_OUTSIDE_ROOT"), ("loop", "REPOSITORY_IMPORT_FAILED"),
                                  ("directory", "REPOSITORY_IMPORT_FAILED")]:
                result = import_repository_file({**request, "input": {**request["input"], "locator": locator}})
                self.assertEqual(result["failure"]["code"], code)
                validate_plugin_run_result(result)

    def test_snapshot_binding_survives_clock_side_effects(self):
        request = repository_import_request(run_id="owned", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        def clock():
            request["runId"] = "mutated"
            request["input"]["externalId"] = "mutated"
            return "2026-09-05T01:00:00Z"
        result = import_repository_file(request, now=clock)
        self.assertEqual(result["runId"], "owned")
        self.assertEqual(result["output"]["externalIdentity"]["externalId"], "owned")

    def test_custom_objects_and_exception_properties_are_not_evaluated(self):
        calls = []
        class Evil(dict):
            def get(self, *args):
                calls.append("get")
                raise RuntimeError("OWNED_SENTINEL")
            def __iter__(self):
                calls.append("iter")
                raise RuntimeError("OWNED_SENTINEL")
        class EvilError(Exception):
            @property
            def code(self):
                calls.append("code")
                raise RuntimeError("OWNED_SENTINEL")
            @property
            def message(self):
                calls.append("message")
                raise RuntimeError("OWNED_SENTINEL")
        for value in [Evil(), {"runId": Evil()}, {"runId": "owned", "input": Evil()}]:
            result = import_repository_file(value)
            self.assertEqual(result["status"], "failure")
            validate_plugin_run_result(result)
        request = repository_import_request(run_id="owned", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        def clock():
            raise EvilError("OWNED_SENTINEL")
        result = import_repository_file(request, now=clock)
        self.assertEqual(result["failure"], {"code": "REPOSITORY_IMPORT_FAILED", "message": "repositoryを読み取れませんでした。"})
        self.assertEqual(calls, [])

        class EvilKey:
            def __hash__(self):
                return hash("runId")
            def __eq__(self, other):
                calls.append("key equality")
                raise RuntimeError("OWNED_SENTINEL")
        invalid_keys = {EvilKey(): "owned"}
        result = import_repository_file(invalid_keys)
        self.assertEqual(result["runId"], "invalid-run")
        self.assertEqual(calls, [])

    def test_cli_strict_input_errors_are_fixed(self):
        script = str(CORE / "repository_import.py")
        for raw, args in [(b"{", []), (b"\xff", []), (b'{"operation":"import","operation":"assess"}', []),
                          (b"{}", ["OWNED_SENTINEL"]), (b" " * (8 * 1024 * 1024 + 1), [])]:
            result = subprocess.run([sys.executable, "-B", script, *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b'{"error":{"code":"REPOSITORY_IMPORT_INPUT_INVALID","path":"/"}}\n')

    def test_cli_import_and_stdio_use_actual_files(self):
        request = repository_import_request(run_id="owned", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        script = str(CORE / "repository_import.py")
        for args, value, wrapped in [([], {"operation": "import", "input": request}, True), (["--stdio"], request, False)]:
            result = subprocess.run([sys.executable, "-B", script, *args], input=json.dumps(value), text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            if wrapped:
                output = output["result"]
            self.assertEqual(output["status"], "success")
            validate_repository_import_result(output, request)

    def test_cli_closed_output_pipes_have_stable_exit_and_no_shutdown_traceback(self):
        request = repository_import_request(run_id="owned", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        valid = json.dumps({"operation": "validate-request", "input": request}).encode()
        diagnostic = b'{"error":{"code":"REPOSITORY_IMPORT_INPUT_INVALID","path":"/"}}\n'
        for _ in range(10):
            for close_stdout, close_stderr, raw in [(True, False, valid), (False, True, b"{"), (True, True, valid)]:
                with self.subTest(stdout=close_stdout, stderr=close_stderr):
                    child = subprocess.Popen([sys.executable, "-B", str(CORE / "repository_import.py")],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    try:
                        if close_stdout:
                            child.stdout.close()
                        if close_stderr:
                            child.stderr.close()
                        child.stdin.write(raw)
                        child.stdin.close()
                        child.wait(timeout=30)
                        output = b"" if close_stdout else child.stdout.read()
                        error = b"" if close_stderr else child.stderr.read()
                        self.assertEqual(child.returncode, 1)
                        self.assertEqual(output, b"")
                        self.assertEqual(error, b"" if close_stderr else diagnostic)
                    finally:
                        if child.poll() is None:
                            child.kill()
                            child.wait()
                        for stream in [child.stdin, child.stdout, child.stderr]:
                            stream.close()

    def test_cli_short_writes_and_flush_failures_are_bounded(self):
        class Output:
            def __init__(self, failure=None):
                self.data, self.closed, self.flushes, self.failure = bytearray(), False, 0, failure
            def write(self, value):
                if self.failure == "write":
                    raise OSError("OWNED_SENTINEL")
                if self.failure == "zero":
                    return 0
                count = min(3, len(value))
                self.data.extend(value[:count])
                return count
            def flush(self):
                self.flushes += 1
                if self.failure == "flush":
                    raise OSError("OWNED_SENTINEL")
            def close(self):
                self.closed = True
                if self.failure:
                    raise OSError("OWNED_SENTINEL")
        request = repository_import_request(run_id="owned", repository_root=str(FIXTURE), external_id="owned", locator="source.txt")
        valid = json.dumps({"operation": "validate-request", "input": request}).encode()
        diagnostic = b'{"error":{"code":"REPOSITORY_IMPORT_INPUT_INVALID","path":"/"}}\n'
        for output_failure, error_failure, raw in [(None, None, valid), ("write", None, valid),
                                                  ("zero", None, valid), ("flush", None, valid),
                                                  (None, "write", b"{"), (None, "flush", b"{")]:
            with self.subTest(output=output_failure, diagnostic=error_failure):
                output, error = Output(output_failure), Output(error_failure)
                streams = SimpleNamespace(argv=["repository_import.py"], stdin=SimpleNamespace(buffer=io.BytesIO(raw)),
                                          stdout=SimpleNamespace(buffer=output), stderr=SimpleNamespace(buffer=error))
                with patch.object(repository_import, "sys", streams):
                    status = repository_import.main()
                if raw == valid and output_failure is None:
                    self.assertEqual(status, 0)
                    self.assertEqual(bytes(output.data), b'{"valid":true}\n')
                    self.assertEqual(output.flushes, 1)
                    self.assertFalse(output.closed)
                    self.assertEqual(bytes(error.data), b"")
                else:
                    self.assertEqual(status, 1)
                    self.assertEqual(output.closed, output_failure is not None)
                    self.assertEqual(error.closed, error_failure is not None)
                    self.assertEqual(bytes(error.data), b"" if error_failure == "write" else diagnostic)
                    self.assertNotIn(b"OWNED_SENTINEL", bytes(output.data) + bytes(error.data))


if __name__ == "__main__":
    unittest.main()
