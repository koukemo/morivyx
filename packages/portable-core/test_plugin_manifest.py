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

import plugin_manifest
from canonical import canonical_json, load_json
from plugin_manifest import get_declared_plugin_capability, validate_plugin_manifest
from schema_validation import ValidationError

VECTORS = json.loads((Path(__file__).parent / "fixtures/plugin-manifest-vectors.json").read_text())
SCRIPT = Path(__file__).with_name("plugin_manifest.py")


def request_for(case):
    if "inputJson" in case:
        return load_json(case["inputJson"])
    manifest = copy.deepcopy(VECTORS["templates"][case["template"]])
    for edit in case["edits"]:
        if not edit["path"]:
            manifest = copy.deepcopy(edit["value"])
            continue
        owner = manifest
        for key in edit["path"][:-1]:
            owner = owner[key]
        key = edit["path"][-1]
        if edit.get("delete"):
            del owner[key]
        elif type(owner) is list and key == len(owner):
            owner.append(copy.deepcopy(edit["value"]))
        else:
            owner[key] = copy.deepcopy(edit["value"])
    result = {"operation": case["operation"], "manifest": manifest}
    if case["operation"] == "capability":
        result["capabilityId"] = copy.deepcopy(case["capabilityId"])
    return result


def assess(request):
    try:
        result = validate_plugin_manifest(request["manifest"]) if request["operation"] == "validate" else \
            get_declared_plugin_capability(request["manifest"], request["capabilityId"])
        return {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(result).encode()).hexdigest()}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


class PluginManifestTests(unittest.TestCase):
    def test_fixed_reference_cases_and_input_ownership(self):
        self.assertEqual(len(VECTORS["cases"]), 283)
        self.assertEqual(sum(case["expected"]["accepted"] for case in VECTORS["cases"]), 38)
        for case in VECTORS["cases"]:
            with self.subTest(name=case["name"]):
                request = request_for(case)
                before = copy.deepcopy(request)
                self.assertEqual(assess(request), case["expected"])
                self.assertEqual(request, before)

    def test_returns_original_values_and_preserves_raw_unicode_identity(self):
        manifest = copy.deepcopy(VECTORS["templates"]["repository"])
        first = manifest["capabilities"][0]
        first["id"] = "é"
        second = copy.deepcopy(first)
        second["id"] = "e\u0301"
        manifest["capabilities"].append(second)
        self.assertIs(validate_plugin_manifest(manifest), manifest)
        self.assertIs(get_declared_plugin_capability(manifest, "é"), first)
        self.assertIs(get_declared_plugin_capability(manifest, "e\u0301"), second)
        self.assertNotEqual(first["id"], second["id"])

    def test_non_json_values_and_invalid_manifest_take_precedence(self):
        for invalid in [float("nan"), float("inf"), float("-inf"), -0.0, 9007199254740992, {1: "value"}, object(), "\ud800"]:
            with self.subTest(value=repr(invalid)):
                manifest = copy.deepcopy(VECTORS["templates"]["repository"])
                manifest["identity"]["id"] = invalid
                with self.assertRaises(ValidationError) as error:
                    get_declared_plugin_capability(manifest, None)
                self.assertEqual((error.exception.code, error.exception.path), ("PLUGIN_MANIFEST_INVALID", "/"))
        manifest = copy.deepcopy(VECTORS["templates"]["repository"])
        manifest["cycle"] = manifest
        with self.assertRaises(ValidationError) as error:
            validate_plugin_manifest(manifest)
        self.assertEqual(error.exception.path, "/")

    def test_cli_validation_and_capability_lookup(self):
        manifest = VECTORS["templates"]["repository"]
        for request, expected in [({"operation": "validate", "manifest": manifest}, {"valid": True}),
                                  ({"operation": "capability", "manifest": manifest, "capabilityId": manifest["capabilities"][0]["id"]},
                                   {"capability": manifest["capabilities"][0]})]:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(request), capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout), expected)

    def test_cli_strict_input_limit_and_fixed_diagnostics(self):
        valid = json.dumps({"operation": "validate", "manifest": VECTORS["templates"]["repository"]}).encode()
        for args, raw in [([], b"{"), ([], b"\xff"), ([], b'{"operation":"secret","operation":"validate"}'),
                          ([], b" " * (plugin_manifest.LIMIT + 1)), (["NEVER_ECHO_ARGUMENT"], valid),
                          ([], b'{"operation":"validate","manifest":{"secret-field":"NEVER_ECHO_BODY"}}')]:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b'{"error":{"code":"PLUGIN_MANIFEST_INPUT_INVALID","path":"/"}}\n')

    def test_cli_transport_failure_uses_the_same_fixed_diagnostic(self):
        diagnostic = StringIO()
        with patch.object(sys, "argv", [str(SCRIPT)]), patch.object(plugin_manifest, "read_bounded_stdin", side_effect=OSError("NEVER_ECHO_TRANSPORT")), redirect_stderr(diagnostic):
            self.assertEqual(plugin_manifest.main(), 1)
        self.assertEqual(diagnostic.getvalue(), '{"error":{"code":"PLUGIN_MANIFEST_INPUT_INVALID","path":"/"}}\n')


if __name__ == "__main__":
    unittest.main()
