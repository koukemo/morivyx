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

import plugin_host_policy
from canonical import canonical_json, load_json
from plugin_host_policy import authorize_plugin_host_policy, validate_plugin_host_policy
from schema_validation import ValidationError

VECTORS = json.loads((Path(__file__).parent / "fixtures/plugin-host-policy-vectors.json").read_text())
SCRIPT = Path(__file__).with_name("plugin_host_policy.py")


def request_for(case):
    if "inputJson" in case:
        return load_json(case["inputJson"])
    request = {"operation": case["operation"], **copy.deepcopy(VECTORS["template"])}
    for edit in case["edits"]:
        owner = request
        for key in edit["path"][:-1]:
            owner = owner[key]
        key = edit["path"][-1]
        if edit.get("delete"):
            owner.pop(key, None)
        else:
            owner[key] = copy.deepcopy(edit["value"])
    return request


def assess(request):
    try:
        result = validate_plugin_host_policy(request["policy"]) if request["operation"] == "validate" else \
            authorize_plugin_host_policy(request["manifest"], request["capabilityId"], request["policy"])
        return {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(result).encode()).hexdigest()}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


class PluginHostPolicyTests(unittest.TestCase):
    def test_frozen_reference_cases_and_unchanged_inputs(self):
        self.assertEqual(len(VECTORS["cases"]), 326)
        self.assertEqual(sum(case["expected"]["accepted"] for case in VECTORS["cases"]), 92)
        for case in VECTORS["cases"]:
            with self.subTest(name=case["name"]):
                request = request_for(case)
                before = copy.deepcopy(request)
                self.assertEqual(assess(request), case["expected"])
                self.assertEqual(request, before)

    def test_validation_returns_original_but_authorization_is_detached(self):
        request = copy.deepcopy(VECTORS["template"])
        manifest, policy = request["manifest"], request["policy"]
        before = copy.deepcopy(request)
        self.assertIs(validate_plugin_host_policy(policy), policy)
        capability = authorize_plugin_host_policy(manifest, request["capabilityId"], policy)
        capability["permissions"]["fileRead"].append("not-shared")
        capability["resources"]["timeoutMs"] = 1
        capability["id"] = "other"
        self.assertEqual(request, before)

    def test_non_json_values_are_rejected_before_policy_structure(self):
        for value in [float("nan"), float("inf"), float("-inf"), -0.0, 9007199254740992, {1: "x"}, object(), "\ud800"]:
            policy = copy.deepcopy(VECTORS["template"]["policy"])
            policy["plugin"]["id"] = value
            with self.assertRaises(ValidationError) as error:
                validate_plugin_host_policy(policy)
            self.assertEqual((error.exception.code, error.exception.path), ("PLUGIN_HOST_POLICY_INVALID", "/policy"))
        policy = copy.deepcopy(VECTORS["template"]["policy"])
        policy["cycle"] = policy
        with self.assertRaises(ValidationError) as error:
            validate_plugin_host_policy(policy)
        self.assertEqual(error.exception.code, "PLUGIN_HOST_POLICY_INVALID")

    def test_cli_both_operations(self):
        request = copy.deepcopy(VECTORS["template"])
        for operation in ("validate", "authorize"):
            raw = {"operation": operation, "policy": request["policy"]}
            expected = {"valid": True}
            if operation == "authorize":
                raw.update(request)
                expected = {"capability": authorize_plugin_host_policy(request["manifest"], request["capabilityId"], request["policy"])}
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(raw), capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout), expected)

    def test_cli_strict_input_and_fixed_diagnostic(self):
        requests = [(b"{", []), (b"\xff", []), (b'{"operation":"validate","operation":"authorize"}', []),
                    (b" " * (plugin_host_policy.LIMIT + 1), []), (b"{}", ["NEVER_ECHO_ARGUMENT"]),
                    (b'{"operation":"authorize","policy":{"secret":"NEVER_ECHO_BODY"}}', []),
                    (json.dumps({"operation": "validate", "policy": VECTORS["template"]["policy"], "extra": True}).encode(), [])]
        for raw, arguments in requests:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), *arguments], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b'{"error":{"code":"PLUGIN_HOST_POLICY_INPUT_INVALID","path":"/"}}\n')

    def test_cli_input_error_uses_fixed_diagnostic(self):
        diagnostic = StringIO()
        with patch.object(sys, "argv", [str(SCRIPT)]), patch.object(plugin_host_policy, "read_bounded_stdin", side_effect=OSError("NEVER_ECHO_INPUT")), redirect_stderr(diagnostic):
            self.assertEqual(plugin_host_policy.main(), 1)
        self.assertEqual(diagnostic.getvalue(), '{"error":{"code":"PLUGIN_HOST_POLICY_INPUT_INVALID","path":"/"}}\n')

    def test_cli_output_error_uses_fixed_diagnostic(self):
        class FailingBuffer:
            def write(self, value):
                raise OSError("NEVER_ECHO_OUTPUT")

        class Output:
            buffer = FailingBuffer()

        raw = json.dumps({"operation": "validate", "policy": VECTORS["template"]["policy"]}).encode()
        diagnostic = StringIO()
        with patch.object(sys, "argv", [str(SCRIPT)]), patch.object(plugin_host_policy, "read_bounded_stdin", return_value=raw), \
                patch.object(sys, "stdout", Output()), redirect_stderr(diagnostic):
            self.assertEqual(plugin_host_policy.main(), 1)
        self.assertEqual(diagnostic.getvalue(), '{"error":{"code":"PLUGIN_HOST_POLICY_INPUT_INVALID","path":"/"}}\n')


if __name__ == "__main__":
    unittest.main()
