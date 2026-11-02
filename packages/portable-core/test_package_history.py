import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from package_validation import validate_package, validate_package_files
from test_graph_validation import SCHEMA, entity
from test_package_core_validation import files_for, grant
from test_package_export import materialize
from test_schema_registry import NAME
from yaml_records import read_yaml, write_yaml


SCRIPT = Path(__file__).with_name("package_validation.py")
ALLOWED = {"core.criterion": {("draft", "active"), ("draft", "retracted"), ("active", "deprecated"),
                               ("active", "superseded"), ("active", "retracted")},
           "core.learning": {("draft", "active"), ("draft", "retracted"), ("active", "superseded"), ("active", "retracted")}}


def marked(files, identity):
    files = copy.deepcopy(files)
    revision = read_yaml(files["revision.yaml"])
    revision["id"] = identity
    files["revision.yaml"] = write_yaml(revision)
    return files


def record_files(type_id, state, *, before=False, index=3, approved=False):
    element = entity(index, type_id, lifecycle=state, reviewState="approved" if approved else "unreviewed")
    records = [grant(element)] if approved else []
    return marked(files_for([entity(1), element], records), "graph:history-before" if before else "graph:history-after")


def cases():
    out = []

    def add(name, previous, current, transition=False):
        out.append({"name": name, "previousFiles": copy.deepcopy(previous), "files": copy.deepcopy(current), "transitionExpected": transition})

    for type_id in ALLOWED:
        definition = next(value for value in SCHEMA["entityTypes"] if value["typeId"] == type_id)
        states = [*definition["lifecycle"], "legacy"]
        for before in states:
            for after in states:
                add(type_id + "-" + before + "-" + after, record_files(type_id, before, before=True), record_files(type_id, after),
                    before != after and (before, after) not in ALLOWED[type_id])
    previous = record_files("core.criterion", "draft", before=True)
    current = record_files("core.criterion", "deprecated")
    add("without-previous", None, current)
    add("empty-previous-graph", marked(files_for([]), "graph:history-empty"), current)
    add("empty-current-graph", previous, marked(files_for([]), "graph:history-empty"))
    add("same-package", previous, previous)
    add("type-changed", previous, record_files("core.learning", "active"))
    add("new-element", previous, record_files("core.criterion", "deprecated", index=4))
    unresolved_previous = copy.deepcopy(previous)
    unresolved_previous["schemas/" + NAME] = "unparsed: [\n"
    add("previous-schema-not-resolved", unresolved_previous, current, True)
    unresolved_current = copy.deepcopy(current)
    unresolved_current.pop("schemas/" + NAME)
    add("current-schema-missing-suppresses-history", previous, unresolved_current, False)
    approved = record_files("core.criterion", "deprecated", approved=True)
    add("current-approval-present", previous, approved, True)
    missing_approval = {path: source for path, source in approved.items() if not path.startswith("approvals/")}
    add("current-approval-missing", previous, missing_approval, True)
    add("allowed-active-transition", previous, record_files("core.criterion", "active"))
    add("approved-allowed-transition", previous, record_files("core.criterion", "active", approved=True))
    add("same-files-without-comparison", None, previous)
    return out


class PackageHistoryTests(unittest.TestCase):
    def test_state_matrices_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case)
            with self.subTest(name=case["name"]):
                result = validate_package_files(case["files"], previous_files=case["previousFiles"])
                transitions = [issue for issue in result["issues"] if issue["code"] == "LIFECYCLE_TRANSITION"]
                self.assertEqual(bool(transitions), case["transitionExpected"])
                self.assertFalse(result["validation"]["packageValidated"])
                if case["previousFiles"] is not None:
                    self.assertTrue(result["validation"]["previousRecordStructuresValidated"])
                    self.assertTrue(result["validation"]["previousRecordDigestsValidated"])
                    self.assertFalse(result["validation"]["historyAncestryValidated"])
                self.assertEqual(case, before)

    def test_default_behavior_is_unchanged(self):
        current = record_files("core.criterion", "deprecated")
        self.assertEqual(validate_package_files(current), validate_package_files(current, previous_files=None))
        self.assertTrue(validate_package_files(current)["valid"])
        self.assertNotIn("previousGraphRevision", validate_package_files(current)["validation"])
        self.assertFalse(validate_package_files(current, previous_files=record_files("core.criterion", "draft", before=True))["valid"])

    def test_current_schema_failure_suppresses_history_diagnostics(self):
        case = next(value for value in cases() if value["name"] == "current-schema-missing-suppresses-history")
        result = validate_package_files(case["files"], previous_files=case["previousFiles"])
        self.assertTrue(result["issues"])
        self.assertEqual({issue["phase"] for issue in result["issues"]}, {2})
        self.assertFalse(result["validation"]["lifecycleTransitionsCompared"])

    def test_prior_schema_and_ancestry_are_not_authenticated(self):
        case = next(value for value in cases() if value["name"] == "previous-schema-not-resolved")
        result = validate_package_files(case["files"], previous_files=case["previousFiles"])
        self.assertFalse(result["validation"]["previousSchemaLockBindingValidated"])
        self.assertFalse(result["validation"]["historyAncestryValidated"])
        self.assertTrue(result["validation"]["lifecycleTransitionsCompared"])
        self.assertEqual(result["validation"]["previousGraphRevision"], "graph:history-before")

    def test_cli_valid_invalid_and_registry_failure_keep_both_sources(self):
        for name in ("allowed-active-transition", "core.criterion-draft-deprecated", "current-schema-missing-suppresses-history"):
            case = next(value for value in cases() if value["name"] == name)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                prior, current = root / 'previous', root / 'current'
                materialize(prior, case["previousFiles"])
                materialize(current, case["files"])
                result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(current), '--previous', str(prior)], capture_output=True, text=True)
                expected = validate_package_files(case["files"], previous_files=case["previousFiles"])
                import json
                self.assertEqual(json.loads(result.stdout), expected)
                self.assertEqual(result.returncode, 0 if expected["valid"] else 1)
                self.assertEqual(result.stderr, '')
                self.assertEqual(validate_package(current, previous_directory=prior), expected)
                for path, files in ((prior, case["previousFiles"]), (current, case["files"])):
                    for name, source in files.items():
                        self.assertEqual((path / name).read_text(), source)

    def test_bad_or_linked_previous_package_produces_no_result(self):
        files = record_files("core.criterion", "active")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            prior, current = root / 'previous', root / 'current'
            materialize(prior, files)
            materialize(current, files)
            linked = root / 'linked'
            linked.symlink_to(prior, target_is_directory=True)
            for selected in (linked, root / 'missing'):
                result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(current), '--previous', str(selected)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'package validation failed; no result produced\n')
            (prior / 'revision.yaml').write_text('broken: [\n')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(current), '--previous', str(prior)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
