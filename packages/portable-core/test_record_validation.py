import copy
import unittest

from record_validation import validate_change_set, validate_graph_revision, validate_schema_lock
from schema_validation import ValidationError


ID = "urn:uuid:00000000-0000-4000-8000-000000000001"
DIGEST = "sha256:" + "a" * 64
LOCK = {"format": "morivyx.schema-lock/0.1", "stableIdScheme": "urn-uuid-v4", "digestAlgorithm": "sha256",
        "schemas": [{"schemaId": "morivyx.core", "version": "0.1", "digest": DIGEST}]}
REVISION = {"format": "morivyx.graph-revision/0.1", "id": "graph:next", "parentRevision": "graph:base",
            "rootDigest": DIGEST, "schemaLockDigest": DIGEST}
CHANGE = {"format": "morivyx.changeset/0.1", "id": ID, "baseRevision": "graph:base", "resultingRevision": "graph:next",
          "resultingRootDigest": DIGEST, "schemaLockDigest": DIGEST,
          "operations": [{"op": "create", "targetId": ID, "afterRevision": DIGEST}],
          "provenance": {"method": "asserted", "actor": ID, "recordedAt": "2026-10-27T00:00:00Z"},
          "recordedAt": "2026-10-27T00:00:00Z"}


class RecordValidationTests(unittest.TestCase):
    def test_header_checks_and_input_preservation(self):
        for function, value in [(validate_schema_lock, LOCK), (validate_graph_revision, REVISION), (validate_change_set, CHANGE)]:
            before = copy.deepcopy(value)
            self.assertIs(function(value), value)
            self.assertEqual(value, before)
        self.assertIsNone(validate_graph_revision({**REVISION, "parentRevision": None})["parentRevision"])
        for changes, path in [({"id": "graph:bad\n"}, "/id"), ({"parentRevision": REVISION["id"]}, "/parentRevision")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_graph_revision({**REVISION, **changes})
            self.assertEqual(caught.exception.path, path)
        self.assertEqual(validate_graph_revision({**REVISION, "id": "graph:allowed\u0085"})["id"], "graph:allowed\u0085")

    def test_schema_reference_order_duplicates_and_empty_set(self):
        self.assertEqual(validate_schema_lock({**LOCK, "schemas": []})["schemas"], [])
        entry = LOCK["schemas"][0]
        for entries in [[entry, entry], [entry, {**entry, "schemaId": "a.first"}],
                        [{**entry, "schemaId": "e\u0301.name"}, {**entry, "schemaId": "é.name"}]]:
            with self.subTest(entries=entries), self.assertRaises(ValidationError) as caught:
                validate_schema_lock({**LOCK, "schemas": entries})
            self.assertEqual(caught.exception.code, "SCHEMA_LOCK_ORDER_INVALID")
            self.assertEqual(caught.exception.path, "/schemas/1")

    def test_operation_specific_fields_and_revoke_mixing(self):
        for name, fields in [("create", {"afterRevision": DIGEST}), ("revise", {"beforeRevision": DIGEST, "afterRevision": DIGEST}),
                             ("retire", {"beforeRevision": DIGEST}), ("replace", {"beforeRevision": DIGEST, "afterRevision": DIGEST,
                              "replacementId": ID[:-1] + "2"}), ("revoke", {})]:
            operation = {"op": name, "targetId": ID, **fields}
            self.assertEqual(validate_change_set({**CHANGE, "operations": [operation]})["operations"], [operation])
        for operations in [[], [None], [{"op": "unknown", "targetId": ID}],
                           [{"op": "create", "targetId": ID}], [{"op": "retire", "targetId": ID, "beforeRevision": DIGEST, "afterRevision": DIGEST}],
                           [*CHANGE["operations"], {"op": "revoke", "targetId": ID}]]:
            with self.subTest(operations=operations), self.assertRaises(ValidationError):
                validate_change_set({**CHANGE, "operations": operations})

    def test_structure_does_not_claim_application_or_authorization(self):
        value = copy.deepcopy(CHANGE)
        value["provenance"]["extra"] = "preserved"
        self.assertIs(validate_change_set(value), value)
        with self.assertRaises(ValidationError) as caught:
            validate_change_set({**value, "recordedAt": "2026-02-30T00:00:00Z"})
        self.assertEqual(caught.exception.path, "/recordedAt")


if __name__ == "__main__":
    unittest.main()
