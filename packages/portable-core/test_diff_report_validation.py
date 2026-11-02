import copy
import unittest

from canonical import entry_key
from report_validation import DIFF_FIELDS, validate_migration_semantic_diff_report, validate_semantic_diff_report
from schema_validation import ValidationError


ID = "urn:uuid:00000000-0000-4000-8000-000000000001"
A, B = "sha256:" + "a" * 64, "sha256:" + "b" * 64


def entry(kind):
    value = {"kind": kind, "targetId": "morivyx.core" if kind == "schema_changed" else ID}
    values = {"afterRevision": B, "beforeRevision": A, "replacementId": ID[:-1] + "2", "aspect": "selection" if kind == "decision_changed" else "criterion",
              "queryId": "why-artifact-exists", "beforeStatus": "partial", "afterStatus": "complete"}
    value.update({field: values[field] for field in DIFF_FIELDS[kind]})
    return value


def report(entries=None, migration=False):
    return {"format": "morivyx.migration-semantic-diff/0.1" if migration else "morivyx.semantic-diff/0.1",
            "baseRevision": "graph:base", "targetRevision": "graph:target", "evaluatedAt": "2026-10-27T00:00:00Z",
            **({"sourceSchemaLockDigest": A, "targetSchemaLockDigest": B} if migration else {"schemaLockDigest": A}),
            "entries": [] if entries is None else entries}


class DiffReportValidationTests(unittest.TestCase):
    def test_all_kinds_and_input_preservation(self):
        value = report(sorted((entry(kind) for kind in DIFF_FIELDS), key=entry_key))
        before = copy.deepcopy(value)
        self.assertIs(validate_semantic_diff_report(value), value)
        self.assertEqual(value, before)

    def test_order_keys_include_revisions_and_reject_duplicates(self):
        a = entry("entity_revised")
        b = {**a, "afterRevision": "sha256:" + "c" * 64}
        validate_semantic_diff_report(report([a, b]))
        for entries in ([b, a], [a, a], [entry("trace_quality_changed"), {**entry("trace_quality_changed"), "beforeStatus": "broken"}]):
            with self.subTest(entries=entries), self.assertRaises(ValidationError) as caught:
                validate_semantic_diff_report(report(entries))
            self.assertEqual((caught.exception.code, caught.exception.path), ("REPORT_ORDER_INVALID", "/entries/1"))

    def test_kind_specific_fields_and_identity_constraints(self):
        for kind in DIFF_FIELDS:
            value = entry(kind)
            for field in value:
                broken = {key: item for key, item in value.items() if key != field}
                with self.subTest(kind=kind, field=field), self.assertRaises(ValidationError) as caught:
                    validate_semantic_diff_report(report([broken]))
                self.assertEqual(caught.exception.path, "/entries/0/" + field)
        for value, field in [({**entry("entity_revised"), "afterRevision": A}, "afterRevision"),
                             ({**entry("entity_replaced"), "replacementId": ID}, "replacementId"),
                             ({**entry("schema_changed"), "targetId": ID}, "targetId"),
                             ({**entry("entity_added"), "extra": 1}, "extra")]:
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_semantic_diff_report(report([value]))
            self.assertEqual(caught.exception.path, "/entries/0/" + field)

    def test_aspects_and_trace_quality_statuses(self):
        for kind, aspect in [("decision_changed", "selection"), ("decision_changed", "evidence"), ("decision_changed", "scope"),
                             ("goal_changed", "criterion"), ("goal_changed", "achievement")]:
            validate_semantic_diff_report(report([{**entry(kind), "aspect": aspect}]))
        for value, path in [({**entry("decision_changed"), "aspect": "unknown"}, "/entries/0/aspect"),
                            ({**entry("trace_quality_changed"), "queryId": "unknown"}, "/entries/0/queryId"),
                            ({**entry("trace_quality_changed"), "beforeStatus": "unknown"}, "/entries/0"),
                            ({**entry("trace_quality_changed"), "afterStatus": "partial"}, "/entries/0/afterStatus")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_semantic_diff_report(report([value]))
            self.assertEqual(caught.exception.path, path)

    def test_migration_requires_distinct_schema_locks_and_schema_change_entry(self):
        value = report([entry("schema_changed")], migration=True)
        self.assertIs(validate_migration_semantic_diff_report(value), value)
        for changed, code, path in [({**value, "targetSchemaLockDigest": A}, "REPORT_STRUCTURE_INVALID", "/targetSchemaLockDigest"),
                                    ({**value, "entries": []}, "MIGRATION_SEMANTIC_DIFF_MISMATCH", "/entries"),
                                    ({**value, "entries": [entry("entity_added")]}, "MIGRATION_SEMANTIC_DIFF_MISMATCH", "/entries")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_migration_semantic_diff_report(changed)
            self.assertEqual((caught.exception.code, caught.exception.path), (code, path))

    def test_empty_normal_diff_and_separate_graph_or_plan_validation(self):
        value = report()
        self.assertIs(validate_semantic_diff_report(value), value)
        value = report([entry("schema_changed")], migration=True)
        before = copy.deepcopy(value)
        validate_migration_semantic_diff_report(value)
        self.assertEqual(value, before)
        with self.assertRaises(ValidationError) as caught:
            validate_semantic_diff_report({**report(), "evaluatedAt": "2026-02-30T00:00:00Z"})
        self.assertEqual(caught.exception.path, "/evaluatedAt")


if __name__ == "__main__":
    unittest.main()
