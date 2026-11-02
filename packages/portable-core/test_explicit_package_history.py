import copy
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from package_history import PackageHistoryError, inspect_package_history, main
from package_migration import plan_package_migration
from test_graph_validation import entity
from test_package_core_validation import files_for
from test_package_migration import extension_request
from test_package_validation import empty_files, refresh
from test_schema_registry import NAME
from test_yaml_authoring import yaml
from yaml_records import read_yaml, write_yaml


SCRIPT = Path(__file__).with_name("package_history.py")


def labeled(files, identity, parent=None):
    result = copy.deepcopy(files)
    revision = read_yaml(result["revision.yaml"])
    revision.update(id=identity, parentRevision=parent)
    result["revision.yaml"] = write_yaml(revision)
    return result


def request():
    packages = [labeled(files_for([entity(1), entity(2, "core.criterion", lifecycle=state)]),
                        "graph:explicit-" + str(i), "graph:explicit-" + str(i - 1) if i else None)
                for i, state in enumerate(("draft", "active", "deprecated"))]
    return {"tipRevision": "graph:explicit-2", "packages": packages}


def migration_request():
    value = extension_request()
    value["sourceFiles"] = labeled(value["sourceFiles"], read_yaml(value["sourceFiles"]["revision.yaml"])["id"])
    target = plan_package_migration(value)["files"]
    return {"tipRevision": value["resultingRevision"]["id"], "packages": [target, value["sourceFiles"]]}


def cases():
    out = []

    def add(name, value, valid=True, code=None, path=None, order=None):
        out.append({"name": name, "input": copy.deepcopy(value), "valid": valid, "code": code, "path": path, "order": order})

    add("three-generations", request(), order=[0, 1, 2])
    reverse = request()
    reverse["packages"].reverse()
    add("input-order-independent", reverse, order=[2, 1, 0])
    add("one-root", {"tipRevision": "graph:root", "packages": [empty_files("graph:root")]}, order=[0])
    invalid_edge = request()
    invalid_edge["packages"] = [invalid_edge["packages"][0], labeled(invalid_edge["packages"][2], "graph:explicit-2", "graph:explicit-0")]
    add("draft-to-deprecated", invalid_edge, False, order=[0, 1])
    add("different-schema-versions-with-opaque-extension", migration_request(), order=[1, 0])
    missing = request()
    missing["packages"].pop(0)
    add("missing-root", missing, code="MISSING_REVISION", path="/packages")
    missing = request()
    missing["packages"].pop(1)
    add("missing-middle", missing, code="MISSING_REVISION", path="/packages")
    missing = request()
    missing["tipRevision"] = "graph:not-supplied"
    add("missing-tip", missing, code="MISSING_REVISION", path="/packages")
    cyclic = request()
    cyclic["packages"][0] = labeled(cyclic["packages"][0], "graph:explicit-0", "graph:explicit-2")
    add("cycle-three", cyclic, code="CYCLE", path="/packages")
    duplicate = request()
    duplicate["packages"].append(copy.deepcopy(duplicate["packages"][0]))
    add("duplicate-even-if-identical", duplicate, code="DUPLICATE_REVISION", path="/packages/3")
    duplicate["packages"][3] = empty_files("graph:explicit-0")
    add("conflicting-revision-id", duplicate, code="DUPLICATE_REVISION", path="/packages/3")
    unused = request()
    unused["packages"].append(empty_files("graph:unrelated"))
    add("unrelated-root", unused, code="UNUSED_SNAPSHOT", path="/packages")
    branch = request()
    branch["packages"].append(labeled(branch["packages"][1], "graph:branch", "graph:explicit-0"))
    add("unused-branch", branch, code="UNUSED_SNAPSHOT", path="/packages")
    conflict = request()
    definition = read_yaml(conflict["packages"][1]["schemas/" + NAME])
    criterion = next(t for t in definition["entityTypes"] if t["typeId"] == "core.criterion")
    criterion["lifecycle"] = sorted([*criterion["lifecycle"], "archived"])
    conflict["packages"][1] = labeled(files_for([entity(1), entity(2, "core.criterion", lifecycle="active")],
                                               schemas=[(NAME, yaml(definition))]), "graph:explicit-1", "graph:explicit-0")
    add("same-schema-key-different-digest", conflict, code="SCHEMA_CONFLICT", path="/packages/1")
    for name in ("missing-schema", "broken-schema", "wrong-schema", "bad-old-graph", "bad-root-digest", "self-parent"):
        value = request()
        first = value["packages"][0]
        if name == "missing-schema":
            first.pop("schemas/" + NAME)
        elif name == "broken-schema":
            first["schemas/" + NAME] = "unparsed: [\n"
        elif name == "wrong-schema":
            first["schemas/" + NAME] = first["schemas/" + NAME].replace('version: "0.1"', 'version: "0.2"')
        elif name == "bad-old-graph":
            path = next(p for p in first if p.startswith("graph/entities/"))
            record = read_yaml(first[path])
            record["attributes"]["unknown"] = "untrusted"
            first[path] = write_yaml(record)
            refresh(first)
        else:
            revision = read_yaml(first["revision.yaml"])
            revision["rootDigest" if name == "bad-root-digest" else "parentRevision"] = "sha256:" + "0" * 64 if name == "bad-root-digest" else revision["id"]
            first["revision.yaml"] = write_yaml(revision)
        add(name, value, code="PACKAGE_INVALID", path="/packages/0")
    for name, value in [("empty", {}), ("unknown-field", {**request(), "secret": "private"}),
                        ("no-packages", {"tipRevision": "graph:x", "packages": []}),
                        ("wrong-tip-type", {**request(), "tipRevision": False})]:
        add(name, value, code="INPUT_INVALID", path="/")
    return out


class ExplicitPackageHistoryTests(unittest.TestCase):
    def test_declared_chain_errors_and_semantics_preserve_input(self):
        for case in cases():
            with self.subTest(case=case["name"]):
                before = copy.deepcopy(case["input"])
                if case["code"]:
                    with self.assertRaises(PackageHistoryError) as raised:
                        inspect_package_history(case["input"])
                    self.assertEqual(raised.exception.code, "PACKAGE_HISTORY_" + case["code"])
                    self.assertEqual(raised.exception.path, case["path"])
                else:
                    result = inspect_package_history(case["input"])
                    self.assertEqual(result["valid"], case["valid"])
                    self.assertEqual(result["checks"]["comparedEdges"], len(result["entries"]) - 1)
                    self.assertFalse(result["checks"]["actualHistoryAuthenticated"])
                    self.assertFalse(result["checks"]["migrationPlansValidated"])
                self.assertEqual(case["input"], before)

    def test_order_and_adjacent_lifecycle_diagnostics(self):
        value = request()
        expected = inspect_package_history(value)
        self.assertEqual([e["id"] for e in expected["entries"]], ["graph:explicit-" + str(i) for i in range(3)])
        self.assertIsNone(expected["entries"][0]["comparison"])
        value["packages"].reverse()
        self.assertEqual(inspect_package_history(value), expected)
        case = next(c for c in cases() if c["name"] == "draft-to-deprecated")
        invalid = inspect_package_history(case["input"])
        self.assertFalse(invalid["valid"])
        self.assertEqual([i["code"] for i in invalid["entries"][-1]["comparison"]["issues"]], ["LIFECYCLE_TRANSITION"])

    def test_each_schema_and_opaque_extension_are_retained(self):
        value = migration_request()
        before = copy.deepcopy(value)
        result = inspect_package_history(value)
        self.assertTrue(result["valid"])
        self.assertNotEqual(result["entries"][0]["schemaLockDigest"], result["entries"][1]["schemaLockDigest"])
        self.assertEqual(value, before)
        result["entries"][0]["id"] = "changed-output"
        self.assertEqual(value, before)

    def test_snapshot_count_and_byte_limits(self):
        packages = [labeled(empty_files(), "graph:count-" + str(i), "graph:count-" + str(i - 1) if i else None) for i in range(128)]
        value = {"tipRevision": "graph:count-127", "packages": packages}
        self.assertEqual(len(inspect_package_history(value)["entries"]), 128)
        value["packages"].append(empty_files("graph:extra"))
        with self.assertRaisesRegex(PackageHistoryError, "INPUT_INVALID"):
            inspect_package_history(value)
        for files in [{"secret": "x" * (1024 * 1024 + 1)}, {str(i): "" for i in range(4097)}]:
            with self.assertRaisesRegex(PackageHistoryError, "LIMIT_EXCEEDED"):
                inspect_package_history({"tipRevision": "graph:x", "packages": [files]})
        block = "x" * (1024 * 1024)
        files = {str(i): block for i in range(64)}
        with self.assertRaisesRegex(PackageHistoryError, "PACKAGE_INVALID"):
            inspect_package_history({"tipRevision": "graph:x", "packages": [files]})
        with self.assertRaisesRegex(PackageHistoryError, "LIMIT_EXCEEDED"):
            inspect_package_history({"tipRevision": "graph:x", "packages": [files, {"extra": "x"}]})

    def test_invalid_text_and_mapping_types(self):
        for files in [{"revision.yaml": "\ud800"}, {False: "private"}, {"revision.yaml": False}, {"x" * 4097: "private"}, []]:
            with self.assertRaisesRegex(PackageHistoryError, "PACKAGE_INVALID"):
                inspect_package_history({"tipRevision": "graph:x", "packages": [files]})

    def test_cli_has_distinct_semantic_report_and_static_request_failure(self):
        for case in (cases()[0], next(c for c in cases() if c["name"] == "draft-to-deprecated"), cases()[-1]):
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(case["input"]), text=True, capture_output=True)
            if case["code"]:
                self.assertEqual(result.stdout, "")
                self.assertEqual(json.loads(result.stderr), {"error": {"code": "PACKAGE_HISTORY_" + case["code"], "path": case["path"]}})
            else:
                self.assertEqual(json.loads(result.stdout), inspect_package_history(case["input"]))
                self.assertEqual(result.stderr, "")
            self.assertEqual(result.returncode, 1 if case["code"] or not case["valid"] else 0)

    def test_strict_json_bytes_and_unknown_arguments_emit_no_payload(self):
        for raw in (b'{"tipRevision":"graph:private","packages":[],"packages":[]}', b'{} trailing-private', b'\xff', b' ' * (8 * 1024 * 1024 + 1)):
            result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=raw, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"private", result.stderr)
            self.assertIn(json.loads(result.stderr)["error"]["code"], ("PACKAGE_HISTORY_INPUT_INVALID", "PACKAGE_HISTORY_LIMIT_EXCEEDED"))
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "private-argument"], input=b"{}", capture_output=True)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr), {"error": {"code": "PACKAGE_HISTORY_INPUT_INVALID", "path": "/"}})

    def test_os_error_does_not_echo_exception_details(self):
        error = StringIO()
        with patch("package_history.read_request_bytes", side_effect=OSError("private-input")), redirect_stderr(error):
            self.assertEqual(main([]), 1)
        self.assertEqual(json.loads(error.getvalue()), {"error": {"code": "PACKAGE_HISTORY_INPUT_INVALID", "path": "/"}})


if __name__ == "__main__":
    unittest.main()
