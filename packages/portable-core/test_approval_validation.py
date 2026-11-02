import copy
import unittest

from approval_validation import validate_approval, validate_approval_ledger
from schema_validation import ValidationError


def identity(index):
    return f"urn:uuid:00000000-0000-4000-8000-{index:012x}"


def approval(index=1, **changes):
    result = {"format": "morivyx.approval/0.1", "id": identity(index), "actor": identity(2),
              "targetId": identity(3), "targetRevision": "sha256:" + "a" * 64,
              "operation": "approve", "scope": "single-revision", "approvedAt": "2026-10-27T00:00:00Z",
              "recordedAt": "2026-10-27T00:00:00Z"}
    result.update(changes)
    return result


class ApprovalValidationTests(unittest.TestCase):
    def test_record_and_ledger_preserve_input(self):
        grant = approval()
        revoke = approval(4, operation="revoke", revokes=grant["id"])
        records = [revoke, grant]
        before = copy.deepcopy(records)
        self.assertIs(validate_approval(grant), grant)
        self.assertIs(validate_approval_ledger(records), records)
        self.assertEqual(records, before)

    def test_required_fields_and_unknown_fields(self):
        for field in approval():
            record = approval()
            del record[field]
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_approval(record)
            self.assertEqual(caught.exception.path, "/" + field)
        with self.assertRaises(ValidationError) as caught:
            validate_approval(approval(**{"bad~/key": 1}))
        self.assertEqual(caught.exception.path, "/bad~0~1key")

    def test_invalid_identifiers_and_dates(self):
        for field, value in [("id", "not-an-id"), ("actor", identity(2).upper()), ("targetRevision", "sha256:" + "A" * 64),
                             ("approvedAt", "2026-02-30T00:00:00Z"), ("recordedAt", "2026-10-27T00:00:00+24:00"),
                             ("expiresAt", None), ("operation", ""), ("scope", False)]:
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_approval(approval(**{field: value}))
            self.assertEqual(caught.exception.path, "/" + field)

    def test_revocation_record_requirements(self):
        for changes in [{"operation": "revoke"}, {"operation": "revoke", "revokes": identity(1)},
                        {"revokes": identity(4)}, {"operation": "revoke", "revokes": "bad"}]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError) as caught:
                validate_approval(approval(**changes))
            self.assertEqual(caught.exception.path, "/revokes")

    def test_ledger_duplicate_missing_and_mismatched_links(self):
        grant = approval()
        for records, path in [([grant, copy.deepcopy(grant)], "/approvals/1/id"),
                              ([approval(4, operation="revoke", revokes=identity(8))], "/approvals/0/revokes"),
                              ([grant, approval(4, operation="revoke", revokes=grant["id"], targetId=identity(8))], "/approvals/1/revokes"),
                              ([grant, approval(4, operation="revoke", revokes=grant["id"], targetRevision="sha256:" + "b" * 64)], "/approvals/1/revokes")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_approval_ledger(records)
            self.assertEqual(caught.exception.path, path)
        revoke = approval(4, operation="revoke", revokes=grant["id"])
        with self.assertRaises(ValidationError) as caught:
            validate_approval_ledger([grant, revoke, approval(5, operation="revoke", revokes=revoke["id"])])
        self.assertEqual(caught.exception.path, "/approvals/2/revokes")

    def test_validation_does_not_invent_time_order_or_authority(self):
        # These are separate assessment rules in the frozen product contract.
        grant = approval(approvedAt="2026-10-28T00:00:00Z", expiresAt="2026-10-26T00:00:00Z", operation="custom-operation")
        self.assertIs(validate_approval_ledger([grant])[0], grant)
        with self.assertRaises(ValidationError) as caught:
            validate_approval_ledger([None])
        self.assertEqual(caught.exception.path, "/approvals/0")


if __name__ == "__main__":
    unittest.main()
