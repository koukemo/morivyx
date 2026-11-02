import copy
import unittest

from approval_assessment import UNSET, assess_approvals
from package_records import read_package_files
from schema_validation import ValidationError
from test_approval_validation import approval, identity
from test_graph_validation import entity
from test_package_core_validation import files_for


def context(**changes):
    return {"targetId": identity(3), "targetRevision": "sha256:" + "a" * 64, "operation": "approve",
            "scope": "single-revision", "evaluatedAt": "2026-10-28T00:00:00Z", "allowedActors": [identity(2)], **changes}


def golden():
    return {"approvals": [approval()], "context": context()}


def evaluate(value):
    value = value if type(value) is dict else {}
    return assess_approvals(value.get("approvals", UNSET), value.get("context", UNSET))


def cases():
    out = []
    base = golden()

    def add(name, value, accepted=True):
        out.append({"name": name, "input": copy.deepcopy(value), "accepted": accepted})

    add("golden", base)
    add("empty-ledger", {**base, "approvals": []})
    for field, entries in {
        "targetId": [identity(4)], "targetRevision": ["sha256:" + "b" * 64], "operation": ["create", "other"],
        "scope": ["other"], "actor": [identity(4)], "approvedAt": ["2026-10-29T00:00:00Z"],
        "recordedAt": ["2026-10-29T00:00:00Z"], "expiresAt": ["2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z"],
    }.items():
        for index, entry in enumerate(entries):
            record = approval(**{field: entry})
            if field == "approvedAt":
                record["recordedAt"] = entry
            add("reason-" + field + str(index), {**base, "approvals": [record]})
    for allowed in ([], [identity(4)], [identity(2), identity(4)]):
        add("allowed-" + str(len(out)), {**base, "context": context(allowedActors=allowed)})
    for order in (False, True):
        records = [approval(), approval(4, operation="revoke", revokes=identity(1), expiresAt="2026-10-27T01:00:00Z")]
        if order:
            records.reverse()
        for allowed in ([identity(2)], [], [identity(4)]):
            add("revocation-expiry-" + str(len(out)), {"approvals": records, "context": context(allowedActors=allowed)})
    for field in ("approvedAt", "recordedAt"):
        record = approval(4, operation="revoke", revokes=identity(1), **{field: "2026-10-29T00:00:00Z"})
        if field == "approvedAt":
            record["recordedAt"] = record[field]
        add("future-revocation-" + field, {**base, "approvals": [record, approval()]})
    for index, fraction in enumerate(["1", "10000000000000000000000000000001", "0" * 100 + "1", "1" * 1000]):
        for evaluated in ["0", fraction, "9"]:
            at = "2026-10-27T00:00:00." + fraction + "Z"
            record = approval(approvedAt=at, recordedAt=at)
            add("fraction-" + str(index) + "-" + str(len(out)), {"approvals": [record], "context": context(evaluatedAt="2026-10-27T00:00:00." + evaluated + "Z")})
    for at in ["2026-10-27T09:00:00+09:00", "2026-10-26T10:00:00-14:00", "0000-01-01T00:00:00Z", "9999-12-31T23:59:59Z"]:
        add("offset-year-" + str(len(out)), {"approvals": [approval(approvedAt=at, recordedAt=at)], "context": context(evaluatedAt=at)})
    for field in context():
        for index, entry in enumerate([None, [], {}, 0, "", "bad"]):
            accepted = (field in ("operation", "scope") and entry == "bad") or (field == "allowedActors" and entry == [])
            add("context-field-" + field + str(index), {**base, "context": context(**{field: entry})}, accepted)
        value = context()
        value.pop(field)
        add("context-missing-" + field, {**base, "context": value}, False)
    for extra in [{"extra": True}, {"é": 1, "e\u0301": 2}, {"extra": "2026-02-30T00:00:00Z"}, {"extra": 2 ** 53}]:
        add("context-extra-" + str(len(out)), {**base, "context": {**context(), **extra}}, False)
    for allowed in [[identity(2), identity(2)], [None], [identity(2).upper()], [{}]]:
        add("invalid-allowed-" + str(len(out)), {**base, "context": context(allowedActors=allowed)}, False)
    add("context-revoke-forbidden", {**base, "context": context(operation="revoke")}, False)
    for field in approval():
        for index, entry in enumerate([None, [], {}, 0, "", "bad"]):
            accepted = field in ("operation", "scope") and entry == "bad"
            add("approval-field-" + field + str(index), {**base, "approvals": [approval(**{field: entry})]}, accepted)
        record = approval()
        record.pop(field)
        add("approval-missing-" + field, {**base, "approvals": [record]}, False)
    for entry in [None, [], {}, 0, "bad"]:
        add("ledger-type-" + str(len(out)), {**base, "approvals": entry}, entry == [])
    add("duplicate-ledger-id", {**base, "approvals": [approval(), approval()]}, False)
    for changes in [{"scope": "other"}, {"approvedAt": "2026-10-26T00:00:00Z", "recordedAt": "2026-10-26T00:00:00Z"},
                    {"targetId": identity(4)}, {"revokes": identity(900)}]:
        record = approval(4, operation="revoke", revokes=identity(1))
        record.update(changes)
        add("invalid-revocation-" + str(len(out)), {**base, "approvals": [record, approval()]}, False)
    for record in [approval(approvedAt="2026-10-28T00:00:00Z"), approval(expiresAt="2026-10-27T00:00:00Z"),
                   approval(expiresAt="2026-10-26T00:00:00Z")]:
        add("invalid-time-order-" + str(len(out)), {**base, "approvals": [record]}, False)
    for value in [None, [], {}, {"approvals": []}, {"context": context()}]:
        add("missing-input-" + str(len(out)), value, False)
    records = [approval(index, actor=identity(4) if index == 4 else identity(2)) for index in (4, 3, 5)]
    add("record-order-preserved", {**base, "approvals": records})
    for mask in range(128):
        record = approval()
        for bit, field, entry in [(0, "targetId", identity(4)), (1, "operation", "create"), (2, "scope", "other"),
                                  (3, "actor", identity(4)), (4, "recordedAt", "2026-10-29T00:00:00Z"),
                                  (5, "expiresAt", "2026-10-28T00:00:00Z")]:
            if mask & (1 << bit):
                record[field] = entry
        records = [record]
        if mask & 64:
            records.append(approval(4, operation="revoke", revokes=identity(1), actor=identity(900),
                                    targetId=record["targetId"], targetRevision=record["targetRevision"], scope=record["scope"],
                                    expiresAt="2026-10-27T01:00:00Z"))
        add("reason-precedence-" + str(mask), {**base, "approvals": records})
    return out


def package_assessment():
    elements = [entity(index) for index in (1, 2, 3)]
    records = [approval(50, targetRevision=elements[2]["revision"]),
               approval(51, operation="revoke", revokes=identity(50), targetRevision=elements[2]["revision"], expiresAt="2026-10-27T01:00:00Z"),
               approval(52, targetRevision=elements[2]["revision"])]
    files = files_for(elements, records)
    contents = read_package_files(files)
    return {"files": files, "input": {"approvals": contents["approvals"], "context": context(targetRevision=elements[2]["revision"])}}


class ApprovalAssessmentTests(unittest.TestCase):
    def test_fixed_result_and_unverified_authenticity(self):
        result = evaluate(golden())
        self.assertEqual(result, {"applicable": True, **{field: context()[field] for field in ("targetId", "targetRevision", "operation", "scope", "evaluatedAt")},
                                 "approvals": [{"approvalId": identity(1), "actor": identity(2)}],
                                 "evaluations": [{"approvalId": identity(1), "actor": identity(2), "reason": "applicable"}],
                                 "authenticity": "not-verified", "persisted": False})

    def test_corpus_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    self.assertEqual(evaluate(case["input"])["authenticity"], "not-verified")
                else:
                    with self.assertRaises(ValidationError):
                        evaluate(case["input"])
                self.assertEqual(case["input"], before)

    def test_expired_revocation_does_not_resurrect_grant(self):
        records = [approval(), approval(4, operation="revoke", revokes=identity(1), expiresAt="2026-10-27T01:00:00Z", actor=identity(900))]
        self.assertEqual(assess_approvals(records, context())["evaluations"][0]["reason"], "revoked")

    def test_subsecond_boundary_without_float_rounding(self):
        fraction = "0" * 100 + "1"
        record = approval(expiresAt="2026-10-28T00:00:00." + fraction + "Z")
        self.assertTrue(assess_approvals([record], context())["applicable"])
        self.assertEqual(assess_approvals([record], context(evaluatedAt=record["expiresAt"]))["evaluations"][0]["reason"], "expired")

    def test_diagnostic_boundaries(self):
        for value, expected in [({"approvals": [], "context": context(operation="revoke")}, ("APPROVAL_ASSESSMENT_INVALID", "/context")),
                                ({"approvals": None, "context": context()}, ("APPROVAL_INVALID", "/approvals")),
                                ({"approvals": [], "context": context(evaluatedAt="2026-02-30T00:00:00Z")}, ("APPROVAL_ASSESSMENT_INVALID", "/"))]:
            with self.assertRaises(ValidationError) as caught:
                evaluate(value)
            self.assertEqual((caught.exception.code, caught.exception.path), expected)

    def test_returned_values_detach_from_input(self):
        value = golden()
        result = evaluate(value)
        result["approvals"][0]["actor"] = identity(900)
        result["evaluations"][0]["reason"] = "changed"
        self.assertEqual(value, golden())

    def test_checked_package_connection_and_permanent_withdrawal(self):
        value = package_assessment()
        result = evaluate(value["input"])
        self.assertEqual([record["reason"] for record in result["evaluations"]], ["revoked", "applicable"])
        self.assertEqual(result["approvals"], [{"approvalId": identity(52), "actor": identity(2)}])


if __name__ == "__main__":
    unittest.main()
