"""Source-pinned diagnostics for the existing GraphRevision validator.

The --vectors entry is a test driver, not a production command-line API.
"""

import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import unittest

from record_validation import (_revision_keys, _revision_number_text,
                               validate_graph_revision)
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin


FIXTURE_HASH = "579b3328862b96cc15fd58a6d7cf9a89f46e67346215bc28ae523255f515700f"
REVISION = {"format": "morivyx.graph-revision/0.1", "id": "graph:next", "parentRevision": "graph:base",
            "rootDigest": "sha256:" + "a" * 64, "schemaLockDigest": "sha256:" + "b" * 64}


def json_text(value):
    """Transport the API's raw values as JSON.stringify does; do not canonicalize."""
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is str:
        return json.dumps(value, ensure_ascii=False)
    if type(value) in (int, float):
        text = _revision_number_text(value)
        return "null" if text in ("NaN", "Infinity", "-Infinity") else text
    if type(value) is list:
        return "[" + ",".join(json_text(child) for child in value) + "]"
    return "{" + ",".join(json_text(key) + ":" + json_text(value[key]) for key in _revision_keys(value)) + "}"


def raw_json(value):
    return json_text(value).encode("utf-8", "backslashreplace").decode("utf-8")


def run_case(input_text):
    value = json.loads(input_text)
    before = copy.deepcopy(value)
    try:
        result = (validate_graph_revision(value["revision"], value["filePath"]) if "filePath" in value
                  else validate_graph_revision(value["revision"]))
        outcome = {"valid": True, "sameInput": result is value["revision"], "value": result}
    except ValidationError as error:
        outcome = {"valid": False, "name": "PackageError", "code": error.code, "path": error.path}
    except TypeError:
        outcome = {"valid": False, "name": "TypeError"}
    if value != before:
        raise AssertionError("input changed")
    return {"outcome": outcome, "outputText": raw_json(outcome)}


class GraphRevisionTests(unittest.TestCase):
    def test_all_source_pinned_outcomes_and_raw_output(self):
        data = (Path(__file__).parent / "fixtures" / "graph-revision-vectors.json").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), FIXTURE_HASH)
        fixture = json.loads(data)
        self.assertEqual(fixture["count"], 2644)
        for vector in fixture["vectors"]:
            with self.subTest(vector=vector["name"]):
                self.assertEqual(hashlib.sha256(vector["inputText"].encode()).hexdigest(), vector["inputSha256"])
                result = run_case(vector["inputText"])
                self.assertEqual(result["outcome"], vector["expected"])
                self.assertEqual(result["outputText"], vector["outputText"])
                self.assertEqual(hashlib.sha256(result["outputText"].encode()).hexdigest(), vector["outputSha256"])

    def test_source_paths_attach_without_normalizing_or_changing_inputs(self):
        source = "e\u0301/2026-01-01T01:00:00+01:00#~/記録.yaml"
        self.assertIs(validate_graph_revision(REVISION, source), REVISION)
        for value, path in [(None, source), ({**REVISION, "id": "bad"}, source + "#/id"),
                            ({**REVISION, "bad~/field": 1}, source + "#/bad~0~1field")]:
            before = copy.deepcopy(value)
            with self.assertRaises(ValidationError) as caught:
                validate_graph_revision(value, source)
            self.assertEqual(caught.exception.path, path)
            self.assertEqual(value, before)

    def test_raw_root_position_and_conversion_failure_are_distinct(self):
        for source in ([], {}, {"toString": None}):
            with self.assertRaises(ValidationError) as caught:
                validate_graph_revision(None, source)
            self.assertIs(caught.exception.path, source)
        with self.assertRaises(TypeError):
            validate_graph_revision({**REVISION, "id": "bad"}, {"toString": None})
        with self.assertRaises(ValidationError) as caught:
            validate_graph_revision({**REVISION, "id": "bad"}, [])
        self.assertEqual(caught.exception.path, "#/id")

    def test_numeric_unknown_keys_precede_other_keys(self):
        for keys, path in [(["10", "2"], "/2"), (["4294967295", "4294967294"], "/4294967294"),
                           (["01", "1"], "/1"), (["z~/", "a"], "/z~0~1")]:
            value = {**REVISION, **dict.fromkeys(keys, True)}
            with self.assertRaises(ValidationError) as caught:
                validate_graph_revision(value)
            self.assertEqual(caught.exception.path, path)

    def test_no_host_conversion_method_is_invoked(self):
        class Host:
            def __str__(self):
                raise AssertionError("host string conversion")

            def __bool__(self):
                raise AssertionError("host truth conversion")

        source = Host()
        self.assertIs(validate_graph_revision(REVISION, source), REVISION)
        with self.assertRaises(ValidationError) as caught:
            validate_graph_revision(None, source)
        self.assertIs(caught.exception.path, source)
        with self.assertRaises(TypeError):
            validate_graph_revision({**REVISION, "id": "bad"}, source)

    def test_record_values_and_default_diagnostics_remain_raw(self):
        value = {**REVISION, "id": "graph:e\u0301", "parentRevision": None}
        self.assertIs(validate_graph_revision(value), value)
        self.assertEqual(value["id"], "graph:e\u0301")
        for source in ("", None, False, 0):
            with self.assertRaises(ValidationError) as caught:
                validate_graph_revision({**REVISION, "id": "bad"}, source)
            self.assertEqual(caught.exception.path, "/id")


if __name__ == "__main__":
    if sys.argv[1:] == ["--vectors"]:
        values = json.loads(read_bounded_stdin(sys.stdin.buffer, 8 * 1024 * 1024).decode("utf-8"))
        output = {"results": [run_case(value) for value in values], "node": shutil.which("node"), "git": shutil.which("git")}
        sys.stdout.buffer.write(raw_json(output).encode("utf-8"))
        sys.stdout.buffer.flush()
    else:
        unittest.main()
