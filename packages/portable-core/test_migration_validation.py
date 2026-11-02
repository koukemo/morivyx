import copy
import unittest

from migration_validation import validate_migration, validate_migration_change_set
from schema_validation import ValidationError
from test_record_validation import CHANGE, DIGEST, ID


MIGRATION = {"format": "morivyx.migration/0.1", "id": ID[:-1] + "2", "baseRevision": CHANGE["baseRevision"],
             "sourceSchemaLockDigest": "sha256:" + "b" * 64, "targetSchemaLockDigest": CHANGE["schemaLockDigest"],
             "rulesDigest": DIGEST, "mappingDigest": DIGEST, "plannedSemanticDiffDigest": DIGEST,
             "changeSetId": CHANGE["id"], "resultingRevision": CHANGE["resultingRevision"],
             "resultingRootDigest": CHANGE["resultingRootDigest"], "provenance": copy.deepcopy(CHANGE["provenance"]),
             "recordedAt": CHANGE["recordedAt"]}


class MigrationValidationTests(unittest.TestCase):
    def test_valid_records_preserve_input(self):
        before = copy.deepcopy((MIGRATION, CHANGE))
        self.assertIs(validate_migration(MIGRATION), MIGRATION)
        self.assertIs(validate_migration_change_set(MIGRATION, CHANGE), True)
        self.assertEqual((MIGRATION, CHANGE), before)

    def test_required_fields_and_schema_unchanged(self):
        for field in MIGRATION:
            value = copy.deepcopy(MIGRATION)
            del value[field]
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_migration(value)
            self.assertEqual(caught.exception.code, "MIGRATION_INVALID")
            self.assertEqual(caught.exception.path, "/" + field)
        with self.assertRaises(ValidationError) as caught:
            validate_migration({**MIGRATION, "sourceSchemaLockDigest": MIGRATION["targetSchemaLockDigest"]})
        self.assertEqual((caught.exception.code, caught.exception.path), ("MIGRATION_SCHEMA_UNCHANGED", "/targetSchemaLockDigest"))

    def test_invalid_dates_and_unknown_fields(self):
        for changes, path in [({"recordedAt": "2026-02-30T00:00:00Z"}, "/recordedAt"),
                              ({"id": ID.upper()}, "/id"), ({"baseRevision": "graph:bad\n"}, "/baseRevision"),
                              ({"rulesDigest": "sha256:" + "A" * 64}, "/rulesDigest"),
                              ({"unknown~/field": 1}, "/unknown~0~1field")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_migration({**MIGRATION, **changes})
            self.assertEqual(caught.exception.path, path)

    def test_missing_and_each_mismatched_boundary(self):
        for value in (None, False, 0, ""):
            with self.subTest(value=value), self.assertRaises(ValidationError) as caught:
                validate_migration_change_set(MIGRATION, value)
            self.assertEqual(caught.exception.code, "MIGRATION_CHANGESET_MISSING")
        for field, value in [("changeSetId", ID[:-1] + "3"), ("baseRevision", "graph:other"),
                             ("resultingRevision", "graph:other"), ("resultingRootDigest", "sha256:" + "c" * 64),
                             ("targetSchemaLockDigest", "sha256:" + "c" * 64)]:
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_migration_change_set({**MIGRATION, field: value}, CHANGE)
            self.assertEqual((caught.exception.code, caught.exception.path), ("MIGRATION_CHANGESET_MISMATCH", "/" + field))

    def test_diagnostic_priority_and_separate_plan_validation(self):
        with self.assertRaises(ValidationError) as caught:
            validate_migration_change_set({}, None)
        self.assertEqual(caught.exception.code, "MIGRATION_INVALID")
        for value, path in [([], ""), ({}, "/format"), ({**CHANGE, "operations": []}, "/operations")]:
            with self.subTest(value=value), self.assertRaises(ValidationError) as caught:
                validate_migration_change_set(MIGRATION, value)
            self.assertEqual((caught.exception.code, caught.exception.path), ("CHANGESET_INVALID", path))
        value = copy.deepcopy(MIGRATION)
        value["rulesDigest"] = "sha256:" + "c" * 64
        value["provenance"]["extra"] = "preserved"
        self.assertIs(validate_migration_change_set(value, CHANGE), True)


if __name__ == "__main__":
    unittest.main()
