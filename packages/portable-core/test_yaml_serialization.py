"""Replay pre-implementation public writer observations without Node or Git."""

import copy
import json
from pathlib import Path
import sys
import unittest

from schema_validation import ValidationError
from yaml_records import ORDERS, serialize_yaml_record, write_yaml


FIXTURE = Path(__file__).parent / "fixtures" / "yaml-serialization-vectors.json"


def input_value(spec, templates):
    value = copy.deepcopy(spec["value"] if "value" in spec else templates[spec["template"]])
    for edit in spec.get("edits", []):
        parent = value
        for key in edit["path"][:-1]:
            parent = parent[key]
        key = edit["path"][-1]
        if edit.get("remove"):
            del parent[key]
        else:
            parent[key] = copy.deepcopy(edit["value"])
    special = spec.get("special")
    if special in ("negative-zero", "nan", "infinity"):
        value["probe"] = {"negative-zero": -0.0, "nan": float("nan"), "infinity": float("inf")}[special]
    elif special == "cycle":
        value["probe"] = value
    elif special == "alias":
        shared = {"text": "e\u0301"}
        value["probe"] = [shared, shared]
    if spec.get("depth"):
        nested = "leaf"
        for _ in range(spec["depth"]):
            nested = [nested]
        value["probe"] = nested
    return value


def fingerprint(value):
    seen, pending, rows = {}, [], []

    def reference(item):
        if type(item) in (list, dict):
            if id(item) not in seen:
                seen[id(item)] = len(pending)
                pending.append(item)
            return ["ref", seen[id(item)]]
        return [type(item).__name__, repr(item)]

    first = reference(value)
    index = 0
    while index < len(pending):
        item = pending[index]
        rows.append(["list", [reference(v) for v in item]] if type(item) is list else
                    ["dict", [[k, reference(v)] for k, v in item.items()]])
        index += 1
    return [first, rows]


def replay(frozen):
    results = []
    for case in frozen["cases"]:
        value = input_value(case["input"], frozen["templates"])
        before = fingerprint(value)
        try:
            result = {"ok": True, "source": serialize_yaml_record(value)}
        except ValidationError as error:
            result = {"ok": False, "code": error.code, "path": error.path}
        result["unchanged"] = fingerprint(value) == before
        results.append(result)
    return results


class YamlSerializationTests(unittest.TestCase):
    def test_frozen_public_observations(self):
        frozen = json.loads(FIXTURE.read_text())
        self.assertEqual(frozen["count"], 695)
        self.assertEqual(len(frozen["formats"]), 13)
        for case, actual in zip(frozen["cases"], replay(frozen)):
            with self.subTest(case=case["id"]):
                self.assertEqual(actual, case["expected"])

    def test_legacy_writer_keeps_ten_formats_and_limits(self):
        self.assertEqual(len(ORDERS), 10)
        with self.assertRaises(ValueError):
            write_yaml({"format": "morivyx.schema/0.1"})
        with self.assertRaises(ValueError):
            write_yaml({"format": "morivyx.git-graph/0.1"}, max_bytes=1)
        nested = []
        for _ in range(129):
            nested = [nested]
        with self.assertRaises(ValueError):
            write_yaml({"format": "morivyx.git-graph/0.1", "probe": nested})

    def test_no_callbacks_on_nonlogical_python_objects(self):
        class Unsafe:
            def __str__(self):
                raise AssertionError("callback executed")

        for value in (Unsafe(), {"format": "morivyx.schema/0.1", "probe": Unsafe()}):
            with self.assertRaises(ValidationError) as captured:
                serialize_yaml_record(value)
            self.assertEqual(captured.exception.code, "YAML_SERIALIZATION_INVALID")


if __name__ == "__main__":
    if sys.argv[1:] == ["--replay"]:
        print(json.dumps(replay(json.loads(FIXTURE.read_text())), ensure_ascii=True))
    else:
        unittest.main()
