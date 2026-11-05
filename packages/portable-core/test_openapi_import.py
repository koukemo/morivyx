import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import openapi_import
from canonical import canonical_json
from openapi_import import (OpenApiImportError, compare_openapi_import_snapshots, import_openapi_operation,
                            openapi_import_request, validate_openapi_import_request, validate_openapi_import_result)
from schema_validation import ValidationError

CORE = Path(__file__).parent
FIXTURE = CORE.parent / "kernel/test/fixtures/openapi-importer"
REQUEST = json.loads((FIXTURE / "request.json").read_text())
RESULT = json.loads((FIXTURE / "result.json").read_text())
NOW = RESULT["output"]["retrievedAt"]


def changed_document(change):
    request = copy.deepcopy(REQUEST)
    document = json.loads(request["input"]["documentText"])
    change(document)
    request["input"]["documentText"] = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    return request


class OpenApiImportTests(unittest.TestCase):
    def test_all_frozen_node_outcomes_and_expansion_bytes(self):
        vectors = json.loads((CORE / "fixtures/openapi-import-vectors.json").read_text())
        self.assertEqual(len(vectors["cases"]), 621)
        self.assertEqual(len({entry["id"] for entry in vectors["cases"]}), 621)
        for entry in vectors["cases"]:
            with self.subTest(id=entry["id"]):
                value = copy.deepcopy(entry["input"])
                for part in entry.get("expansions", []):
                    text = part["prefix"] + part["unit"] * part["count"] + part["suffix"]
                    self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), part["sha256"])
                    owner = value
                    for key in part["path"][:-1]:
                        owner = owner[key]
                    owner[part["path"][-1]] = text
                before = copy.deepcopy(value)
                def clock():
                    if entry.get("clockMode") == "throw":
                        raise RuntimeError("OWNED_SENTINEL")
                    return entry.get("now", NOW)
                try:
                    operation = entry["operation"]
                    if operation == "validate-request":
                        output = validate_openapi_import_request(value)
                    elif operation == "validate-result":
                        output = validate_openapi_import_result(value["result"], value.get("request"))
                    elif operation == "compare":
                        output = compare_openapi_import_snapshots(value)
                    else:
                        output = import_openapi_operation(value, now=clock)
                    raw = json.dumps(output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                    actual = {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(output).encode()).hexdigest(),
                              "resultJsonSha256": hashlib.sha256(raw.encode()).hexdigest()}
                except ValidationError as error:
                    actual = {"accepted": False, "code": error.code, "path": error.path}
                self.assertEqual(actual, entry["expected"])
                self.assertEqual(value, before)

    def test_builder_validation_source_hash_and_detached_output(self):
        request = openapi_import_request(run_id=REQUEST["runId"], external_id=REQUEST["input"]["externalId"],
                                        document_text=REQUEST["input"]["documentText"], path=REQUEST["input"]["path"], method="get")
        self.assertEqual(request, REQUEST)
        self.assertIs(validate_openapi_import_request(request), request)
        before = copy.deepcopy(request)
        result = import_openapi_operation(request, now=lambda: NOW)
        self.assertEqual(result, RESULT)
        self.assertIs(validate_openapi_import_result(result, request), result)
        self.assertEqual(result["output"]["digest"], "sha256:" + hashlib.sha256(request["input"]["documentText"].encode()).hexdigest())
        result["output"]["operation"]["path"] = "changed"
        result["output"]["informationLoss"].clear()
        self.assertEqual(import_openapi_operation(request, now=lambda: NOW), RESULT)
        self.assertEqual(request, before)
        invalid = openapi_import_request(run_id="e\u0301", external_id="owned", document_text="{}", path="/", method="get")
        self.assertEqual(invalid["runId"], "e\u0301")
        with self.assertRaises(OpenApiImportError):
            validate_openapi_import_request(invalid)

    def test_depth_duplicates_precision_and_unretained_document_values(self):
        for depth, expected in [(63, "success"), (64, "failure"), (1500, "failure")]:
            request = copy.deepcopy(REQUEST)
            source = request["input"]["documentText"].strip()
            request["input"]["documentText"] = source[:-1] + ',"x-depth":' + '[' * depth + '0' + ']' * depth + '}'
            result = import_openapi_operation(request, now=lambda: NOW)
            self.assertEqual(result["status"], expected)
            if expected == "failure":
                self.assertEqual(result["failure"]["code"], "OPENAPI_IMPORT_DOCUMENT_DEPTH")
        for source in ['{"openapi":"3.1.0","openapi":"3.1.2"}',
                       REQUEST["input"]["documentText"].replace('"operationId":"readWidget"', '"operationId":"first","\\u006fperationId":"second"')]:
            request = copy.deepcopy(REQUEST)
            request["input"]["documentText"] = source
            self.assertEqual(import_openapi_operation(request, now=lambda: NOW)["failure"]["code"], "OPENAPI_IMPORT_DOCUMENT_INVALID")
        request = copy.deepcopy(REQUEST)
        source = request["input"]["documentText"].strip()
        request["input"]["documentText"] = source[:-1] + ',"x-large":9007199254740993,"x-overflow":1e1000}'
        result = import_openapi_operation(request, now=lambda: NOW)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["output"]["operation"], RESULT["output"]["operation"])
        self.assertNotIn("9007199254740993", json.dumps(result))

    def test_result_binding_distinguishes_bad_shape_from_source_mismatch(self):
        for field, value, code in [("digest", "bad", "RESULT_INVALID"),
                                   ("digest", "sha256:" + "2" * 64, "RESULT_MISMATCH"),
                                   ("digestRule", "other", "RESULT_INVALID")]:
            result = copy.deepcopy(RESULT)
            result["output"][field] = value
            with self.assertRaises(OpenApiImportError) as error:
                validate_openapi_import_result(result, REQUEST)
            self.assertEqual(error.exception.code, "OPENAPI_IMPORT_" + code)
        result = copy.deepcopy(RESULT)
        result["output"]["externalIdentity"]["externalId"] = "other"
        self.assertIs(validate_openapi_import_result(result), result)
        with self.assertRaises(OpenApiImportError) as error:
            validate_openapi_import_result(result, REQUEST)
        self.assertEqual(error.exception.code, "OPENAPI_IMPORT_RESULT_MISMATCH")

    def test_comparison_recomputes_missing_and_preserves_time_precision(self):
        value = {"previousResult": copy.deepcopy(RESULT), "currentRequest": copy.deepcopy(REQUEST), "currentResult": copy.deepcopy(RESULT)}
        before = copy.deepcopy(value)
        report = compare_openapi_import_snapshots(value)
        self.assertEqual(report, json.loads((FIXTURE / "comparison-current.json").read_text()))
        report["externalIdentity"]["externalId"] = "changed"
        self.assertEqual(value, before)
        value["previousResult"]["output"]["retrievedAt"] = "2026-09-08T18:00:00.000000002Z"
        value["currentResult"]["output"]["retrievedAt"] = "2026-09-08T18:00:00.000000001Z"
        self.assertEqual(compare_openapi_import_snapshots(value)["issues"], [{"code": "OPENAPI_REIMPORT_TIME_REGRESSION"}])
        value["currentResult"]["output"]["retrievedAt"] = "2026-09-09T03:00:00.000000002+09:00"
        self.assertEqual(compare_openapi_import_snapshots(value)["status"], "current")
        request = changed_document(lambda document: document.update(paths={}))
        failed = import_openapi_operation(request, now=lambda: NOW)
        value = {"previousResult": RESULT, "currentRequest": request, "currentResult": failed}
        failed["failure"]["message"] = "OWNED_SENTINEL"
        self.assertEqual(compare_openapi_import_snapshots(value)["status"], "missing")
        value["currentRequest"] = REQUEST
        report = compare_openapi_import_snapshots(value)
        self.assertEqual(report["issues"], [{"code": "OPENAPI_REIMPORT_CURRENT_NOT_MISSING"}])
        self.assertNotIn("OWNED_SENTINEL", json.dumps(report))

    def test_hostile_objects_and_clocks_do_not_read_exception_properties(self):
        calls = []
        class Evil(dict):
            def get(self, *args):
                calls.append("get")
                raise RuntimeError("OWNED_SENTINEL")
        class EvilError(Exception):
            @property
            def code(self):
                calls.append("code")
                raise RuntimeError("OWNED_SENTINEL")
        for value in [Evil(), {"input": Evil()}, {"runId": float("nan")}, {"runId": float("inf")}]:
            result = import_openapi_operation(value)
            self.assertEqual(result["failure"]["code"], "OPENAPI_IMPORT_REQUEST_INVALID")
            self.assertEqual(result["runId"], "invalid-run")
        def throwing():
            raise EvilError("OWNED_SENTINEL")
        self.assertEqual(import_openapi_operation(REQUEST, now=throwing)["failure"]["code"], "OPENAPI_IMPORT_FAILED")
        request = copy.deepcopy(REQUEST)
        def changing():
            request["input"]["path"] = "/changed"
            return NOW
        self.assertEqual(import_openapi_operation(request, now=changing), RESULT)
        self.assertEqual(calls, [])
        for clock in [None, 1, lambda: None, lambda: "bad"]:
            self.assertEqual(import_openapi_operation(REQUEST, now=clock)["failure"]["code"], "OPENAPI_IMPORT_CLOCK_INVALID")

    def test_json_and_stdio_child_protocols_preserve_operations_and_errors(self):
        script = str(CORE / "openapi_import.py")
        comparison = {"previousResult": RESULT, "currentRequest": REQUEST, "currentResult": RESULT}
        for operation, value in [("validate-request", REQUEST), ("validate-result", {"result": RESULT, "request": REQUEST}),
                                 ("import", REQUEST), ("compare", comparison)]:
            result = subprocess.run([sys.executable, "-B", script], input=json.dumps({"operation": operation, "input": value}),
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            output = json.loads(result.stdout)
            if operation == "import":
                validate_openapi_import_result(output["result"], REQUEST)
            elif operation == "compare":
                self.assertEqual(output["report"]["status"], "current")
            else:
                self.assertEqual(output, {"valid": True})
        for raw, args, status, error in [(b"{", [], 1, b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n'),
                                         (b"\xff", [], 1, b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n'),
                                         (b'{"operation":"import","operation":"compare"}', [], 1, b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n'),
                                         (b"{}", ["OWNED_SENTINEL"], 1, b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n'),
                                         (b"{", ["--stdio"], 2, b"PLUGIN_STDIO_INPUT_INVALID\n")]:
            result = subprocess.run([sys.executable, "-B", script, *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (status, b"", error))
        for request in [REQUEST, changed_document(lambda document: document.update(paths={}))]:
            result = subprocess.run([sys.executable, "-B", script, "--stdio"], input=json.dumps(request),
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            validate_openapi_import_result(json.loads(result.stdout), request)

    def test_closed_output_pipes_do_not_create_shutdown_errors(self):
        raw = json.dumps({"operation": "validate-request", "input": REQUEST}).encode()
        diagnostic = b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n'
        for _ in range(3):
            for close_stdout, close_stderr, data in [(True, False, raw), (False, True, b"{"), (True, True, raw)]:
                child = subprocess.Popen([sys.executable, "-B", str(CORE / "openapi_import.py")],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    if close_stdout:
                        child.stdout.close()
                    if close_stderr:
                        child.stderr.close()
                    child.stdin.write(data)
                    child.stdin.close()
                    child.wait(timeout=30)
                    self.assertEqual(child.returncode, 1)
                    self.assertEqual(b"" if close_stdout else child.stdout.read(), b"")
                    self.assertEqual(b"" if close_stderr else child.stderr.read(), b"" if close_stderr else diagnostic)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    for stream in [child.stdin, child.stdout, child.stderr]:
                        stream.close()

    def test_json_entry_handles_short_writes_and_flush_failure(self):
        class Output:
            def __init__(self, fail=False):
                self.data, self.closed, self.fail = bytearray(), False, fail
            def write(self, value):
                count = min(3, len(value))
                self.data.extend(value[:count])
                return count
            def flush(self):
                if self.fail:
                    raise OSError("OWNED_SENTINEL")
            def close(self):
                self.closed = True
        for fail in [False, True]:
            output, error = Output(fail), Output()
            source = json.dumps({"operation": "validate-request", "input": REQUEST}).encode()
            streams = SimpleNamespace(argv=["openapi_import.py"], stdin=SimpleNamespace(buffer=io.BytesIO(source)),
                                      stdout=SimpleNamespace(buffer=output), stderr=SimpleNamespace(buffer=error))
            with patch.object(openapi_import, "sys", streams):
                status = openapi_import.main()
            self.assertEqual(status, 1 if fail else 0)
            self.assertEqual(bytes(output.data), b'{"valid":true}\n')
            self.assertEqual(output.closed, fail)
            self.assertEqual(bytes(error.data), b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n' if fail else b"")


if __name__ == "__main__":
    unittest.main()
