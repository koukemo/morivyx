import base64
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

from canonical import canonical_json
import plugin_supply_chain as supply

VECTORS = json.loads((Path(__file__).parent / "fixtures/plugin-supply-chain-vectors.json").read_text())
SCRIPT = Path(__file__).with_name("plugin_supply_chain.py")
DIAGNOSTIC = '{"error":{"code":"PLUGIN_SUPPLY_CHAIN_INPUT_INVALID","path":"/"}}\n'


def edits_on(value, edits):
    for edit in edits:
        if not edit["path"]:
            value = copy.deepcopy(edit["value"])
            continue
        owner = value
        for key in edit["path"][:-1]:
            owner = owner[key]
        key = edit["path"][-1]
        if edit.get("delete"):
            del owner[key]
        elif type(owner) is list and key == len(owner):
            owner.append(copy.deepcopy(edit["value"]))
        else:
            owner[key] = copy.deepcopy(edit["value"])
    return value


def input_for(case):
    value = copy.deepcopy(VECTORS["template"])
    if "manifestSpec" in case:
        spec = case["manifestSpec"]
        value["manifest"] = edits_on(copy.deepcopy(VECTORS["manifestTemplates"][spec["template"]]), spec["edits"])
    value = edits_on(value, case["edits"])
    if type(value) is dict and type(value.get("artifacts")) is dict:
        for key, descriptor in list(value["artifacts"].items()):
            if type(descriptor) is not dict:
                continue
            if "base64" in descriptor:
                value["artifacts"][key] = base64.b64decode(descriptor["base64"])
            elif "repeat" in descriptor:
                data = descriptor["repeat"]
                value["artifacts"][key] = bytes([data["byte"]]) * data["length"]
            elif "view" in descriptor:
                data = descriptor["view"]
                value["artifacts"][key] = memoryview(base64.b64decode(data["base64"]))[data["offset"]:data["offset"] + data["length"]]
            elif "invalid" in descriptor:
                value["artifacts"][key] = descriptor["invalid"]
    return value


def assess(value):
    report = supply.verify_plugin_supply_chain(value)
    raw = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return {"status": report["status"], "codes": [issue["code"] for issue in report["issues"]],
            "reportSha256": hashlib.sha256(canonical_json(report).encode()).hexdigest(),
            "reportJsonSha256": hashlib.sha256(raw.encode()).hexdigest()}


def cli_request(value):
    return {"operation": "verify", **{key: value[key] for key in ("manifest", "expectedPackageDigest")},
            "artifacts": {key: base64.b64encode(data).decode("ascii") for key, data in value["artifacts"].items()}}


class PluginSupplyChainTests(unittest.TestCase):
    def test_fixed_reports_and_nonmutation(self):
        self.assertEqual(len(VECTORS["cases"]), 354)
        self.assertEqual(len({entry["id"] for entry in VECTORS["cases"]}), 354)
        self.assertEqual({status: sum(e["expected"]["status"] == status for e in VECTORS["cases"])
                          for status in ("matched", "mismatch", "incomplete", "invalid")},
                         {"matched": 13, "mismatch": 48, "incomplete": 4, "invalid": 289})
        for case in VECTORS["cases"]:
            with self.subTest(name=case["id"]):
                value = input_for(case)
                # The fixture owns memoryviews; their immutable backing bytes can
                # be inspected without deepcopy, which deliberately rejects views.
                before = repr(value)
                self.assertEqual(assess(value), case["expected"])
                self.assertEqual(repr(value), before)

    def test_supported_views_and_detached_evidence(self):
        value = input_for(VECTORS["cases"][0])
        for data in (b"abc", bytearray(b"abc"), memoryview(b"!abc!")[1:4], memoryview(bytearray(b"!abc!"))[1:4]):
            value["artifacts"]["package"] = data
            report = supply.verify_plugin_supply_chain(value)
            self.assertEqual(report["status"], "matched")
            self.assertEqual(report["package"]["byteLength"], 3)
            report["plugin"]["id"] = "changed"
            self.assertNotEqual(value["manifest"]["identity"]["id"], "changed")
        data = bytearray(b"abc")
        value["artifacts"]["package"] = data
        report = supply.verify_plugin_supply_chain(value)
        data[:] = b"xxx"
        self.assertEqual(report["package"]["actualDigest"], VECTORS["template"]["expectedPackageDigest"])
        self.assertNotIn("artifacts", report)
        self.assertEqual(report["authenticity"], "not-verified")

    def test_rejects_exotic_buffers_and_records_without_running_them(self):
        from array import array

        class Record(dict):
            def __iter__(self):
                raise AssertionError("must not call")

        class Bytes(bytes):
            def __bytes__(self):
                raise AssertionError("must not call")

        released = memoryview(b"abc")
        released.release()
        value = input_for(VECTORS["cases"][0])
        for data in (Bytes(b"abc"), object(), memoryview(array("B", [97, 98, 99])),
                     memoryview(b"axbxc")[::2], memoryview(b"abc").cast("b"),
                     memoryview(b"abcd").cast("B", shape=[2, 2]), released):
            value["artifacts"]["package"] = data
            self.assertEqual(supply.verify_plugin_supply_chain(value)["issues"], [{"code": "PLUGIN_SUPPLY_CHAIN_BYTES_INVALID"}])
        self.assertEqual(supply.verify_plugin_supply_chain(Record(value))["issues"], [{"code": "PLUGIN_SUPPLY_CHAIN_INPUT_INVALID"}])
        value["artifacts"] = Record()
        self.assertEqual(supply.verify_plugin_supply_chain(value)["issues"], [{"code": "PLUGIN_SUPPLY_CHAIN_ARTIFACTS_INVALID"}])
        value["expectedPackageDigest"] = "sha256:" + "0" * 64
        self.assertEqual(supply.verify_plugin_supply_chain(value)["status"], "mismatch")

    def test_all_limits_precede_hashing(self):
        for name in ("limits/artifact-16777217", "limits/total-33554433", "priority/undeclared-before-size"):
            case = next(e for e in VECTORS["cases"] if e["id"] == name)
            with patch.object(supply.hashlib, "sha256", side_effect=AssertionError("must not hash")):
                report = supply.verify_plugin_supply_chain(input_for(case))
            self.assertEqual(report["status"], "invalid")

    def test_raw_strings_and_input_ownership(self):
        value = input_for(VECTORS["cases"][1])
        for key in ("id", "distributor"):
            value["manifest"]["identity"][key] = "e\u0301"
        value["manifest"]["supplyChain"]["source"] = "2024-01-01T00:00:00+00:00/e\u0301"
        before = copy.deepcopy(value)
        report = supply.verify_plugin_supply_chain(value)
        self.assertEqual(value, before)
        self.assertEqual(report["plugin"]["id"], "e\u0301")
        self.assertEqual(report["source"], value["manifest"]["supplyChain"]["source"])
        report["package"]["expectedDigest"] = "changed"
        report["issues"].append({"code": "changed"})
        self.assertEqual(value, before)

    def test_cli_reports_are_successful_even_when_evidence_is_invalid(self):
        for name in ("base", "all-sidecars", "missing/package", "mismatch/package", "pin/null"):
            case = next(e for e in VECTORS["cases"] if e["id"] == name)
            value = input_for(case)
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(cli_request(value)),
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout), {"report": supply.verify_plugin_supply_chain(value)})

    def test_cli_strict_envelope_encoding_and_limit(self):
        value = cli_request(input_for(VECTORS["cases"][0]))
        inputs = [(b"\xff", []), (b'{"operation":"verify","operation":"verify"}', []),
                  (json.dumps(value).encode(), ["NEVER_ECHO_ARGUMENT"]),
                  (b" " * (supply.CLI_LIMIT + 1), [])]
        for encoded in ("YQ", "YQ=", "YR==", "YWJj\n", "YWJj!", "é", 42, None):
            wrong = copy.deepcopy(value)
            wrong["artifacts"]["package"] = encoded
            inputs.append((json.dumps(wrong).encode(), []))
        for raw, args in inputs:
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr.decode(), DIAGNOSTIC)

    def test_cli_io_failure_does_not_disclose_contents(self):
        raw = json.dumps(cli_request(input_for(VECTORS["cases"][0]))).encode()

        class Output:
            @property
            def buffer(self):
                raise OSError("NEVER_ECHO_OUTPUT")

        for failing_output in (False, True):
            diagnostic = StringIO()
            with patch.object(sys, "argv", [str(SCRIPT)]), redirect_stderr(diagnostic):
                if failing_output:
                    with patch.object(supply, "read_bounded_stdin", return_value=raw), patch.object(sys, "stdout", Output()):
                        self.assertEqual(supply.main(), 1)
                else:
                    with patch.object(supply, "read_bounded_stdin", side_effect=OSError("NEVER_ECHO_INPUT")):
                        self.assertEqual(supply.main(), 1)
            self.assertEqual(diagnostic.getvalue(), DIAGNOSTIC)


if __name__ == "__main__":
    unittest.main()
