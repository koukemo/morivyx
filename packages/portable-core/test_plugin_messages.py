import copy
from contextlib import redirect_stderr
import hashlib
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import plugin_messages
from canonical import canonical_json, load_json
from plugin_messages import authorize_plugin_run_request, validate_plugin_run_request, validate_plugin_run_result
from schema_validation import ValidationError

VECTORS = json.loads((Path(__file__).parent / "fixtures/plugin-message-vectors.json").read_text())
SCRIPT = Path(__file__).with_name("plugin_messages.py")


def request_for(case):
    if "inputJson" in case:
        return load_json(case["inputJson"])
    value = {"operation": case["operation"], **copy.deepcopy(VECTORS["templates"][case["template"]])}
    for edit in case["edits"]:
        owner = value
        for key in edit["path"][:-1]:
            owner = owner[key]
        key = edit["path"][-1]
        if edit.get("delete"):
            owner.pop(key, None)
        else:
            owner[key] = copy.deepcopy(edit["value"])
    return value


def assess(value):
    try:
        if value["operation"] == "validate-request":
            result = validate_plugin_run_request(value["request"])
        elif value["operation"] == "authorize-request":
            result = authorize_plugin_run_request(value["manifest"], value["request"])
        else:
            result = validate_plugin_run_result(value["result"], value.get("request"))
        return {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(result).encode()).hexdigest()}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


class PluginMessageTests(unittest.TestCase):
    def test_frozen_outcomes_and_unchanged_inputs(self):
        self.assertEqual(len(VECTORS["cases"]), 311)
        self.assertEqual(sum(case["expected"]["accepted"] for case in VECTORS["cases"]), 71)
        self.assertEqual(len({case["name"] for case in VECTORS["cases"]}), 311)
        for case in VECTORS["cases"]:
            with self.subTest(name=case["name"]):
                value = request_for(case)
                before = copy.deepcopy(value)
                self.assertEqual(assess(value), case["expected"])
                self.assertEqual(value, before)

    def test_all_three_apis_preserve_original_references(self):
        value = copy.deepcopy(VECTORS["templates"]["base"])
        self.assertIs(validate_plugin_run_request(value["request"]), value["request"])
        self.assertIs(authorize_plugin_run_request(value["manifest"], value["request"]), value["manifest"]["capabilities"][0])
        self.assertIs(validate_plugin_run_result(value["result"], value["request"]), value["result"])
        self.assertIs(validate_plugin_run_result(value["result"]), value["result"])

    def test_non_json_and_cycles_use_root_diagnostics(self):
        for invalid in [float("nan"), float("inf"), float("-inf"), -0.0, 9007199254740992, {1: "value"}, object(), "\ud800"]:
            for name, function, field, code in [("request", validate_plugin_run_request, "input", "PLUGIN_REQUEST_INVALID"),
                                                  ("result", validate_plugin_run_result, "output", "PLUGIN_RESULT_INVALID")]:
                value = copy.deepcopy(VECTORS["templates"]["base"][name])
                value[field]["value"] = invalid
                with self.assertRaises(ValidationError) as error:
                    function(value)
                self.assertEqual((error.exception.code, error.exception.path), (code, "/"))
        value = copy.deepcopy(VECTORS["templates"]["base"]["request"])
        value["input"]["cycle"] = value
        with self.assertRaises(ValidationError) as error:
            validate_plugin_run_request(value)
        self.assertEqual((error.exception.code, error.exception.path), ("PLUGIN_REQUEST_INVALID", "/"))

    def test_binding_keeps_raw_unicode_identity(self):
        value = copy.deepcopy(VECTORS["templates"]["base"])
        value["request"]["runId"] = "e\u0301"
        value["result"]["runId"] = "e\u0301"
        self.assertIs(validate_plugin_run_result(value["result"], value["request"]), value["result"])
        self.assertEqual(value["result"]["runId"], "e\u0301")
        value["result"]["runId"] = "é"
        with self.assertRaises(ValidationError) as error:
            validate_plugin_run_result(value["result"], value["request"])
        self.assertEqual(error.exception.code, "PLUGIN_RESULT_MISMATCH")

    def test_cli_three_operations_and_optional_binding(self):
        value = VECTORS["templates"]["base"]
        requests = [({"operation": "validate-request", "request": value["request"]}, {"valid": True}),
                    ({"operation": "authorize-request", "manifest": value["manifest"], "request": value["request"]}, {"capability": value["manifest"]["capabilities"][0]}),
                    ({"operation": "validate-result", "result": value["result"], "request": value["request"]}, {"valid": True}),
                    ({"operation": "validate-result", "result": value["result"]}, {"valid": True}),
                    ({"operation": "validate-result", "result": VECTORS["templates"]["failure"]["result"], "request": None}, {"valid": True})]
        for request, expected in requests:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(request), capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout), expected)

    def test_cli_strict_input_limit_and_sanitized_errors(self):
        for raw, args in [(b"{", []), (b"\xff", []), (b'{"operation":"validate-request","operation":"validate-result"}', []),
                          (b" " * (plugin_messages.LIMIT + 1), []), (b"{}", ["NEVER_ECHO_ARGUMENT"]),
                          (b'{"operation":"validate-request","request":{"NEVER_ECHO_FIELD":"NEVER_ECHO_BODY"}}', []),
                          (json.dumps({"operation": "validate-result", **VECTORS["templates"]["base"]}).encode(), [])]:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b'{"error":{"code":"PLUGIN_MESSAGES_INPUT_INVALID","path":"/"}}\n')

    def test_cli_input_and_output_errors_use_the_same_fixed_diagnostic(self):
        class FailingBuffer:
            def write(self, value):
                raise OSError("NEVER_ECHO_OUTPUT")

        class Output:
            buffer = FailingBuffer()

        raw = json.dumps({"operation": "validate-request", "request": VECTORS["templates"]["base"]["request"]}).encode()
        for failure in ("input", "output"):
            diagnostic = StringIO()
            with patch.object(sys, "argv", [str(SCRIPT)]), redirect_stderr(diagnostic):
                if failure == "input":
                    with patch.object(plugin_messages, "read_bounded_stdin", side_effect=OSError("NEVER_ECHO_INPUT")):
                        self.assertEqual(plugin_messages.main(), 1)
                else:
                    with patch.object(plugin_messages, "read_bounded_stdin", return_value=raw), patch.object(sys, "stdout", Output()):
                        self.assertEqual(plugin_messages.main(), 1)
            self.assertEqual(diagnostic.getvalue(), '{"error":{"code":"PLUGIN_MESSAGES_INPUT_INVALID","path":"/"}}\n')


if __name__ == "__main__":
    unittest.main()
