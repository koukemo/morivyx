import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from canonical import canonical_json
from changeset_apply import apply_change_set
from decision_preparation import prepare_decision_creation, prepare_decision_revision
from package_records import read_package, read_package_files, write_package_files
from package_restore import restore_package_files
from package_validation import validate_package, validate_package_files
from schema_validation import ValidationError


FIXTURES = Path(__file__).with_name("fixtures")
VECTORS = json.loads((FIXTURES / "decision-preparation-vectors.json").read_text())
BASE_BYTES = (FIXTURES / "portable-cli-vectors.json").read_bytes()
FILES = next(case["input"] for case in json.loads(BASE_BYTES)["cases"] if case["name"] == "package-read")


def applied_contents(contents, plan):
    applied = apply_change_set({"changeSet": plan["changeSet"], "currentRevision": contents["revision"],
                                "schemaLockDigest": contents["calculatedSchemaLockDigest"], "currentElements": contents["elements"],
                                "candidateElements": [plan["candidateElement"]], "resultingRevision": plan["resultingRevision"]})
    result = copy.deepcopy(contents)
    result["elements"] = applied["elements"]
    result["revision"] = applied["revision"]
    result["changeSets"].append(plan["changeSet"])
    return result


class DecisionPreparationTests(unittest.TestCase):
    def test_fixed_node_plans_and_source_input_are_preserved(self):
        self.assertEqual(hashlib.sha256(BASE_BYTES).hexdigest(), VECTORS["source"]["baseVectorsSha256"])
        contents = read_package_files(FILES)
        for case in VECTORS["cases"]:
            with self.subTest(operation=case["operation"]):
                request = copy.deepcopy(case["request"])
                before = copy.deepcopy((contents, request))
                prepare = prepare_decision_creation if case["operation"] == "create" else prepare_decision_revision
                plan = prepare(contents, request)
                self.assertEqual(plan, case["expected"])
                self.assertEqual((contents, request), before)
                contents = applied_contents(contents, plan)

    def test_returned_attributes_provenance_and_preserved_extensions_are_independent(self):
        contents = read_package_files(FILES)
        request = copy.deepcopy(VECTORS["cases"][0]["request"])
        plan = prepare_decision_creation(contents, request)
        before = copy.deepcopy((contents, request))
        plan["candidateElement"]["attributes"]["consequences"].append("changed")
        plan["candidateElement"]["provenance"]["actor"] = "changed"
        self.assertEqual((contents, request), before)
        self.assertEqual(plan["changeSet"]["provenance"]["actor"], request["actor"])
        contents = applied_contents(contents, VECTORS["cases"][0]["expected"])
        contents["elements"][-1]["extensions"] = {"example/meta": {"values": ["kept"]}}
        contents["elements"][-1]["reviewState"] = "approved"
        before = copy.deepcopy(contents)
        revised = prepare_decision_revision(contents, VECTORS["cases"][1]["request"])
        self.assertEqual(revised["candidateElement"]["reviewState"], "unreviewed")
        self.assertEqual(revised["candidateElement"]["extensions"], before["elements"][-1]["extensions"])
        revised["candidateElement"]["extensions"]["example/meta"]["values"].append("changed")
        self.assertEqual(contents, before)

    def test_conflicts_and_lifecycle_diagnostics_have_fixed_codes_and_paths(self):
        contents = applied_contents(read_package_files(FILES), VECTORS["cases"][0]["expected"])
        request = VECTORS["cases"][1]["request"]
        for state in ("accepted", "deprecated", "retired"):
            value = copy.deepcopy(contents)
            value["elements"][-1]["lifecycle"] = state
            with self.subTest(state=state), self.assertRaises(ValidationError) as caught:
                prepare_decision_revision(value, request)
            self.assertEqual((caught.exception.code, caught.exception.path), ("DECISION_REVISION_LIFECYCLE_INVALID", "/decisionId"))
        with self.assertRaises(ValidationError) as caught:
            prepare_decision_creation(contents, VECTORS["cases"][0]["request"])
        self.assertEqual((caught.exception.code, caught.exception.path), ("DECISION_CREATION_ID_EXISTS", "/decisionId"))

    def test_preparation_does_not_claim_attribute_validity_or_actor_authority(self):
        contents = read_package_files(FILES)
        request = copy.deepcopy(VECTORS["cases"][0]["request"])
        request["attributes"] = {}
        plan = prepare_decision_creation(contents, request)
        self.assertEqual(set(plan), {"candidateElement", "changeSet", "resultingRevision"})
        self.assertEqual(plan["candidateElement"]["attributes"], {})
        self.assertEqual(plan["candidateElement"]["reviewState"], "unreviewed")
        self.assertEqual(plan["candidateElement"]["provenance"]["method"], "asserted")
        report = validate_package_files(write_package_files(applied_contents(contents, plan)))
        self.assertTrue(report["issues"])

    def test_creation_and_revision_restore_new_real_files_without_replacing_previous_output(self):
        files = copy.deepcopy(FILES)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            snapshots = []
            for index, case in enumerate(VECTORS["cases"]):
                contents = read_package_files(files)
                prepare = prepare_decision_creation if index == 0 else prepare_decision_revision
                plan = prepare(contents, case["request"])
                previous = files
                files = write_package_files(applied_contents(contents, plan))
                target = root / str(index)
                receipt = restore_package_files(files, target)
                self.assertTrue(receipt["restored"])
                self.assertEqual(canonical_json(read_package(target)), canonical_json(read_package_files(files)))
                self.assertEqual(validate_package(target), validate_package_files(files))
                self.assertEqual(validate_package_files(files, previous_files=previous)["issues"], [])
                snapshot = {name: (target / name).read_bytes() for name in files}
                self.assertEqual(snapshot, {name: source.encode("utf-8") for name, source in files.items()})
                snapshots.append((target, snapshot))
            for target, snapshot in snapshots:
                self.assertEqual({name: (target / name).read_bytes() for name in snapshot}, snapshot)


if __name__ == "__main__":
    unittest.main()
