import copy
import unittest

from canonical import digest
from graph_validation import validate_graph
from migration_apply import apply_migration
from package_records import read_package_files
from schema_validation import ValidationError
from test_changeset_apply import frame, golden as change_golden, operation
from test_graph_validation import SCHEMA, entity, identity, seal
from test_package_core_validation import files_for
from test_package_records import inputs
from test_report_records import MIGRATION
from test_yaml_authoring import yaml


def golden():
    package = read_package_files(inputs())
    migration = package["migrations"][0]
    change = next(change for change in package["changeSets"] if change["id"] == migration["changeSetId"])
    report = copy.deepcopy(MIGRATION)
    report["id"] = "urn:uuid:550e8400-e29b-41d4-a716-446655440013"
    return {"migration": migration, "changeSet": change, "plannedSemanticDiff": report,
            "currentRevision": package["revision"], "currentElements": package["elements"],
            "candidateElements": change_golden()["candidateElements"],
            "resultingRevision": {"format": "morivyx.graph-revision/0.1", "id": migration["resultingRevision"],
                                  "parentRevision": migration["baseRevision"], "rootDigest": migration["resultingRootDigest"], "schemaLockDigest": migration["targetSchemaLockDigest"]},
            "targetValidation": {"valid": True, "issues": [], "graphRevision": migration["resultingRevision"],
                                 "schemaLockDigest": migration["targetSchemaLockDigest"], "rootDigest": migration["resultingRootDigest"]}}


def actual_target_input():
    files = files_for([entity(1)])
    package = read_package_files(files)
    target = copy.deepcopy(SCHEMA)
    target["version"] = "0.2"
    lock = {"format": "morivyx.schema-lock/0.1", "stableIdScheme": "urn-uuid-v4", "digestAlgorithm": "sha256",
            "schemas": [{"schemaId": target["schemaId"], "version": target["version"], "digest": digest("schema", target)["digest"]}]}
    target_digest = digest("schema-lock", lock)["digest"]
    a = package["elements"][0]
    revised = seal({**a, "typeVersion": "0.2"})
    created = seal({**entity(2), "typeVersion": "0.2"})
    value = frame([a], [revised, created], [operation("revise", a, revised), operation("create", after=created)], [revised, created], target_digest)
    value.pop("schemaLockDigest")
    value["currentRevision"] = package["revision"]
    value["changeSet"]["baseRevision"] = package["revision"]["id"]
    value["resultingRevision"]["parentRevision"] = package["revision"]["id"]
    report = {"format": "morivyx.migration-semantic-diff/0.1", "id": identity(9002),
              "baseRevision": package["revision"]["id"], "targetRevision": value["changeSet"]["resultingRevision"],
              "sourceSchemaLockDigest": package["calculatedSchemaLockDigest"], "targetSchemaLockDigest": target_digest,
              "evaluatedAt": "2026-10-28T00:00:00Z", "entries": [
                  {"kind": "entity_added", "targetId": created["id"], "afterRevision": created["revision"]},
                  {"kind": "entity_revised", "targetId": a["id"], "beforeRevision": a["revision"], "afterRevision": revised["revision"]},
                  {"kind": "schema_changed", "targetId": "morivyx.core"}]}
    value["migration"] = {"format": "morivyx.migration/0.1", "id": identity(9001), "baseRevision": report["baseRevision"],
                          "sourceSchemaLockDigest": report["sourceSchemaLockDigest"], "targetSchemaLockDigest": target_digest,
                          "rulesDigest": "sha256:" + "c" * 64, "mappingDigest": "sha256:" + "d" * 64,
                          "plannedSemanticDiffDigest": digest("migration-semantic-diff", report)["digest"],
                          "changeSetId": value["changeSet"]["id"], "resultingRevision": report["targetRevision"],
                          "resultingRootDigest": value["changeSet"]["resultingRootDigest"],
                          "provenance": copy.deepcopy(value["changeSet"]["provenance"]), "recordedAt": value["changeSet"]["recordedAt"]}
    value["plannedSemanticDiff"] = report
    value["targetValidation"] = validate_graph(graph_revision=report["targetRevision"], schema_lock_digest=target_digest,
                                                schemas=[target], elements=[revised, created], previous_elements=[a])
    return {"input": value, "originalFiles": files, "targetSchemaLock": lock,
            "targetSchemaSources": {"morivyx.core@0.2.yaml": yaml(target)}}


def cases():
    base = golden()
    out = [{"name": "golden", "input": base, "accepted": True},
           {"name": "actual-target-schema-validation", "input": actual_target_input()["input"], "accepted": True}]

    def add(name, transform, accepted=False, reseal=False):
        value = copy.deepcopy(base)
        transform(value)
        if reseal:
            value["migration"]["plannedSemanticDiffDigest"] = digest("migration-semantic-diff", value["plannedSemanticDiff"])["digest"]
        out.append({"name": name, "input": value, "accepted": accepted})

    add("report-id-optional", lambda v: v["plannedSemanticDiff"].pop("id"), True)
    add("report-id-independent", lambda v: v["plannedSemanticDiff"].update(id=identity(9002)), True)
    add("migration-id-independent", lambda v: v["migration"].update(id=identity(9001)), True)
    add("target-extra-metadata", lambda v: v["targetValidation"].update(validation={"scope": "caller-declared"}), True)
    for value in (None, [], False):
        out.append({"name": "input-" + repr(value), "input": value, "accepted": False})
    for field in ("migration", "changeSet", "plannedSemanticDiff", "targetValidation"):
        for invalid in (None, [], {}, False, "wrong"):
            add(field + "-" + repr(invalid), lambda v, f=field, x=invalid: v.update({f: x}))
    add("migration-unknown", lambda v: v["migration"].update(extra=1))
    add("same-schema", lambda v: v["migration"].update(sourceSchemaLockDigest=v["migration"]["targetSchemaLockDigest"]))
    for field, replacement in [("changeSetId", identity(9999)), ("baseRevision", "graph:other"),
                               ("resultingRevision", "graph:other"), ("resultingRootDigest", "sha256:" + "0" * 64),
                               ("targetSchemaLockDigest", "sha256:" + "e" * 64)]:
        add("change-binding-" + field, lambda v, f=field, x=replacement: v["migration"].update({f: x}))
    add("report-format", lambda v: v["plannedSemanticDiff"].update(format="morivyx.semantic-diff/0.1"))
    add("report-unknown-field", lambda v: v["plannedSemanticDiff"].update(extra=1))
    add("report-missing-entries", lambda v: v["plannedSemanticDiff"].pop("entries"))
    add("report-invalid-kind", lambda v: v["plannedSemanticDiff"]["entries"][0].update(kind="unknown"))
    add("report-no-schema-change", lambda v: v["plannedSemanticDiff"].update(entries=[e for e in v["plannedSemanticDiff"]["entries"] if e["kind"] != "schema_changed"]), reseal=True)
    add("report-digest", lambda v: v["plannedSemanticDiff"].update(evaluatedAt="2026-08-03T00:00:01Z"))
    add("migration-planned-digest", lambda v: v["migration"].update(plannedSemanticDiffDigest="sha256:" + "0" * 64))
    for field, replacement in [("baseRevision", "graph:other"), ("targetRevision", "graph:other"),
                               ("sourceSchemaLockDigest", "sha256:" + "f" * 64), ("targetSchemaLockDigest", "sha256:" + "e" * 64)]:
        add("report-boundary-" + field, lambda v, f=field, x=replacement: v["plannedSemanticDiff"].update({f: x}), reseal=True)
    for invalid in (None, False, 1, "true"):
        add("target-valid-" + repr(invalid), lambda v, x=invalid: v["targetValidation"].update(valid=x))
    for invalid in (None, {}, False, [{"code": "synthetic"}]):
        add("target-issues-" + repr(invalid), lambda v, x=invalid: v["targetValidation"].update(issues=x))
    for field, replacement in [("graphRevision", "graph:other"), ("schemaLockDigest", "sha256:" + "0" * 64), ("rootDigest", "sha256:" + "0" * 64)]:
        add("target-boundary-" + field, lambda v, f=field, x=replacement: v["targetValidation"].update({f: x}))
        add("target-missing-" + field, lambda v, f=field: v["targetValidation"].pop(f))
    add("candidate-digest", lambda v: v["candidateElements"][0].update(revision="sha256:" + "0" * 64))
    add("source-lock", lambda v: v["currentRevision"].update(schemaLockDigest=v["migration"]["targetSchemaLockDigest"]))
    add("current-root-before-target-result", lambda v: (v["currentRevision"].update(rootDigest="sha256:" + "0" * 64), v.update(targetValidation=False)))
    add("no-candidates", lambda v: v.pop("candidateElements"))
    return out


class MigrationApplyTests(unittest.TestCase):
    def test_golden_digests_and_result(self):
        value = golden()
        result = apply_migration(value)
        self.assertEqual(result["rootDigest"], "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538")
        self.assertEqual(result["migrationDigest"], "sha256:db4ff26038cdc82d8972ab41269a0a8d4b8c1ebc0e482a17e12243735c7b82b8")
        self.assertEqual(result["plannedSemanticDiffDigest"], value["migration"]["plannedSemanticDiffDigest"])

    def test_corpus_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    apply_migration(case["input"])
                else:
                    with self.assertRaises(ValueError):
                        apply_migration(case["input"])
                self.assertEqual(case["input"], before)

    def test_target_validation_requires_true_boolean_and_empty_issues(self):
        for value in (None, False, 1, "true"):
            data = golden()
            data["targetValidation"]["valid"] = value
            with self.assertRaises(ValidationError) as caught:
                apply_migration(data)
            self.assertEqual((caught.exception.code, caught.exception.path), ("MIGRATION_TARGET_VALIDATION_FAILED", "/targetValidation/valid"))

    def test_planned_report_and_target_boundaries_have_precise_diagnostics(self):
        expected = {"report-digest": ("MIGRATION_SEMANTIC_DIFF_MISMATCH", "/plannedSemanticDiffDigest"),
                    "report-boundary-baseRevision": ("MIGRATION_SEMANTIC_DIFF_MISMATCH", "/plannedSemanticDiff/baseRevision"),
                    "target-boundary-rootDigest": ("MIGRATION_TARGET_VALIDATION_MISMATCH", "/targetValidation/rootDigest"),
                    "current-root-before-target-result": ("CHANGESET_APPLY_INVALID", "/currentRevision/rootDigest")}
        for case in cases():
            if case["name"] in expected:
                with self.assertRaises(ValidationError) as caught:
                    apply_migration(case["input"])
                self.assertEqual((caught.exception.code, caught.exception.path), expected[case["name"]])

    def test_result_is_detached_and_does_not_claim_authenticated_validity(self):
        value = golden()
        before = copy.deepcopy(value)
        result = apply_migration(value)
        self.assertEqual(set(result), {"elements", "revision", "rootDigest", "migrationDigest", "plannedSemanticDiffDigest"})
        result["elements"][0]["attributes"]["stringValues"].append("changed")
        result["revision"]["id"] = "graph:changed"
        self.assertEqual(value, before)

    def test_actual_target_schema_result_can_be_supplied(self):
        value = actual_target_input()["input"]
        self.assertTrue(value["targetValidation"]["valid"])
        self.assertEqual(apply_migration(value)["rootDigest"], value["targetValidation"]["rootDigest"])


if __name__ == "__main__":
    unittest.main()
