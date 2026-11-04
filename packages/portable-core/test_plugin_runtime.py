import copy
from contextlib import redirect_stderr
import hashlib
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import plugin_runtime
from canonical import canonical_json, load_json
from plugin_runtime import create_plugin_execution_grant, run_plugin_process
from schema_validation import ValidationError

CORE = Path(__file__).parent
VECTORS = json.loads((CORE / "fixtures/plugin-runtime-vectors.json").read_text())
CHILD = CORE / "fixtures/plugin-runtime-child.py"
SCRIPT = CORE / "plugin_runtime.py"


def value_for(case):
    if "inputJson" in case:
        return load_json(case["inputJson"])
    value = copy.deepcopy(VECTORS["templates"][case["template"]])
    for edit in case["edits"]:
        owner = value
        for key in edit["path"][:-1]:
            owner = owner[key]
        if edit.get("delete"):
            owner.pop(edit["path"][-1], None)
        else:
            owner[edit["path"][-1]] = copy.deepcopy(edit["value"])
    return value


def process_options(case, directory):
    value = value_for(case)
    if case.get("inputDepth"):
        nested = {}
        for _ in range(case["inputDepth"]):
            nested = {"next": nested}
        value["request"]["input"] = nested
    if case.get("inputRepeat"):
        value["request"]["input"] = {"payload": "x" * case["inputRepeat"]}
    options = {key: value[key] for key in ("manifest", "request", "policy")}
    options.update(command=sys.executable, args=["-B", str(CHILD), *case.get("childArgs", [])], cwd=str(directory))
    if case.get("commandKind") == "missing":
        options["command"] = str(directory / "NEVER_ECHO_MISSING")
    if case.get("cwdKind") == "missing":
        options["cwd"] = str(directory / "NEVER_ECHO_CWD")
    if case.get("cwdKind") == "work":
        options["cwd"] = str(directory / "work")
    for key in ("command", "args", "cwd"):
        if key in case:
            options[key] = copy.deepcopy(case[key])
    return options


def grant_outcome(value):
    try:
        grant = create_plugin_execution_grant(value["manifest"], value["request"], value["policy"])
        wire = grant.canonical_json.encode("utf-8")
        return {"accepted": True, "resultSha256": hashlib.sha256(wire).hexdigest(), "wireUtf8Bytes": len(wire)}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


def process_outcome(options):
    try:
        result = run_plugin_process(**options)
        return {"accepted": True, "resultSha256": hashlib.sha256(canonical_json(result).encode()).hexdigest(), "status": result["status"]}
    except ValidationError as error:
        return {"accepted": False, "code": error.code, "path": error.path}


class PluginRuntimeTests(unittest.TestCase):
    def test_frozen_grants_and_input_ownership(self):
        self.assertEqual(len(VECTORS["grantCases"]), 371)
        self.assertEqual(sum(case["expected"]["accepted"] for case in VECTORS["grantCases"]), 68)
        for case in VECTORS["grantCases"]:
            with self.subTest(name=case["name"]):
                value = value_for(case)
                before = copy.deepcopy(value)
                self.assertEqual(grant_outcome(value), case["expected"])
                self.assertEqual(value, before)

    def test_frozen_actual_processes_and_input_ownership(self):
        self.assertEqual(len(VECTORS["processCases"]), 64)
        self.assertEqual(sum(case["expected"]["accepted"] for case in VECTORS["processCases"]), 22)
        self.assertEqual(hashlib.sha256(CHILD.read_bytes()).hexdigest(), VECTORS["reference"]["childSha256"])
        with tempfile.TemporaryDirectory(prefix="morivyx-runtime-unit-") as location:
            directory = Path(location)
            (directory / "work").mkdir()
            for case in VECTORS["processCases"]:
                with self.subTest(name=case["name"]):
                    options = process_options(case, directory)
                    before = canonical_json(options) if case.get("inputDepth") else copy.deepcopy(options)
                    self.assertEqual(process_outcome(options), case["expected"])
                    self.assertEqual(canonical_json(options) if case.get("inputDepth") else options, before)

    def test_immutable_snapshot_raw_values_and_detached_mapping(self):
        case = next(case for case in VECTORS["grantCases"] if case["name"] == "valid/raw-unicode")
        value = value_for(case)
        grant = create_plugin_execution_grant(value["manifest"], value["request"], value["policy"])
        original = grant.json_text
        with self.assertRaises(AttributeError):
            grant.json_text = "changed"
        with self.assertRaises(TypeError):
            grant[0] = "changed"
        mapping = grant.to_dict()
        self.assertEqual(mapping["runId"], "e\u0301")
        self.assertEqual(load_json(grant.canonical_json)["runId"], "é")
        mapping["capability"]["permissions"]["fileRead"].append("changed")
        mapping["capability"]["resources"]["timeoutMs"] = 1
        value["manifest"]["capabilities"][0]["permissions"]["fileRead"].append("later")
        value["request"]["runId"] = "later"
        self.assertEqual(grant.json_text, original)
        self.assertNotEqual(grant.to_dict(), mapping)
        self.assertEqual(grant.to_dict()["runId"], "e\u0301")

    def test_nested_json_grammar_and_raw_serialization(self):
        source = '{"next":' * 1200 + '{}' + '}' * 1200
        self.assertEqual(plugin_runtime._json_text(plugin_runtime._json_value(source)), source)
        self.assertEqual(plugin_runtime._json_text({"later": True, "2": 2, "1": 1}), '{"1":1,"2":2,"later":true}')
        atoms = [None, True, False, 0, 1, -2, 9007199254740991, "日本語とe\u0301", "\0\n\ufeff", [], {}]
        for atom in atoms:
            for value in (atom, [atom], {"value": atom}, {"left": [atom], "right": {"value": atom}}):
                wire = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                self.assertEqual(plugin_runtime._json_value(wire), value)
                self.assertEqual(json.loads(plugin_runtime._json_text(value)), value)
        self.assertEqual(plugin_runtime._json_value('{"value":1,"value":2}'), {"value": 2})
        with self.assertRaises(ValueError):
            plugin_runtime._json_value('{"value":1,"value":2}', reject_duplicates=True)
        for source in ['[1,]', '{"x":1,}', '{x:1}', '{"x" 1}', '{"x":}', '[1 2]', '01', 'NaN', '{}{}', '[', '{', '', 'true false']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                plugin_runtime._json_value(source)

    def test_result_binding_uses_the_sent_request_after_caller_changes(self):
        value = copy.deepcopy(VECTORS["templates"]["runtime"])
        original = subprocess.Popen
        expected_run = value["request"]["runId"]

        def start(*args, **kwargs):
            process = original(*args, **kwargs)
            value["request"]["runId"] = "changed-by-caller"
            value["request"]["input"] = None
            return process

        with patch.object(plugin_runtime.subprocess, "Popen", side_effect=start):
            result = run_plugin_process(**value, command=sys.executable, args=["-B", str(CHILD)])
        self.assertEqual(result["runId"], expected_run)
        self.assertEqual(result["output"]["value"]["text"], "日本語とe\u0301")
        self.assertEqual(value["request"]["runId"], "changed-by-caller")
        self.assertIsNone(value["request"]["input"])

    def test_denied_settings_do_not_start_a_child(self):
        value = copy.deepcopy(VECTORS["templates"]["runtime"])
        with tempfile.TemporaryDirectory(prefix="morivyx-runtime-marker-") as location:
            marker = Path(location) / "started"
            arguments = ["-B", "-c", "from pathlib import Path;Path(" + repr(str(marker)) + ").write_text('started')"]
            for key in ("maxMemoryBytes", "maxCostUnits"):
                policy = copy.deepcopy(value["policy"])
                policy["capability"]["resources"][key] = 1024
                with self.assertRaises(ValidationError) as error:
                    run_plugin_process(**{**value, "policy": policy}, command=sys.executable, args=arguments)
                self.assertEqual(error.exception.code, "PLUGIN_RUN_RESOURCE_UNSUPPORTED")
            policy = copy.deepcopy(value["policy"])
            policy["plugin"]["id"] = "other"
            with self.assertRaises(ValidationError) as error:
                run_plugin_process(**{**value, "policy": policy}, command=sys.executable, args=arguments)
            self.assertEqual(error.exception.code, "PLUGIN_HOST_POLICY_IDENTITY_MISMATCH")
            self.assertFalse(marker.exists())

    def test_cli_grant_only_and_strict_bounded_diagnostics(self):
        value = {"operation": "grant", **VECTORS["templates"]["runtime"]}
        result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(value), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {"grant": create_plugin_execution_grant(value["manifest"], value["request"], value["policy"]).to_dict()})
        for raw, args in [(b"{", []), (b"\xff", []), (b'{"operation":"grant","operation":"run"}', []),
                          (b" " * (plugin_runtime.LIMIT + 1), []), (b"{}", ["NEVER_ECHO_ARGUMENT"]),
                          (b'{"operation":"run","command":"NEVER_ECHO_COMMAND"}', []),
                          (json.dumps({**value, "extra": "NEVER_ECHO_BODY"}).encode(), [])]:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b'{"error":{"code":"PLUGIN_RUNTIME_INPUT_INVALID","path":"/"}}\n')

    def test_cli_input_and_output_failures_are_sanitized(self):
        class FailingBuffer:
            def write(self, value):
                raise OSError("NEVER_ECHO_OUTPUT")

        class Output:
            buffer = FailingBuffer()

        raw = json.dumps({"operation": "grant", **VECTORS["templates"]["runtime"]}).encode()
        for failure in ("input", "output"):
            diagnostic = StringIO()
            with patch.object(sys, "argv", [str(SCRIPT)]), redirect_stderr(diagnostic):
                if failure == "input":
                    with patch.object(plugin_runtime, "read_bounded_stdin", side_effect=OSError("NEVER_ECHO_INPUT")):
                        self.assertEqual(plugin_runtime.main(), 1)
                else:
                    with patch.object(plugin_runtime, "read_bounded_stdin", return_value=raw), patch.object(sys, "stdout", Output()):
                        self.assertEqual(plugin_runtime.main(), 1)
            self.assertEqual(diagnostic.getvalue(), '{"error":{"code":"PLUGIN_RUNTIME_INPUT_INVALID","path":"/"}}\n')

    def test_failed_transports_close_pipes_and_reap_direct_children(self):
        original = subprocess.Popen
        children = []

        def start(*args, **kwargs):
            process = original(*args, **kwargs)
            children.append(process)
            return process

        with tempfile.TemporaryDirectory(prefix="morivyx-runtime-cleanup-") as location:
            directory = Path(location)
            for name in ("timeout", "closed-outputs-timeout", "bytes/stdout-over", "early-input-close"):
                case = next(case for case in VECTORS["processCases"] if case["name"] == name)
                with patch.object(plugin_runtime.subprocess, "Popen", side_effect=start):
                    self.assertEqual(process_outcome(process_options(case, directory)), case["expected"])
                process = children[-1]
                self.assertIsNotNone(process.poll())
                self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))
        with patch.object(plugin_runtime.subprocess, "Popen", side_effect=OSError("NEVER_ECHO_LAUNCH")):
            with self.assertRaises(ValidationError) as error:
                run_plugin_process(**VECTORS["templates"]["runtime"], command=sys.executable)
        self.assertEqual((error.exception.code, error.exception.path), ("PLUGIN_RUN_FAILED", "/"))
        self.assertNotIn("NEVER_ECHO", str(error.exception))


if __name__ == "__main__":
    unittest.main()
