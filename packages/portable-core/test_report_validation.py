import copy
import unittest

from report_validation import TRACE_QUERIES, validate_trace_report
from schema_validation import ValidationError


def identity(index):
    return f"urn:uuid:00000000-0000-4000-8000-{index:012x}"


DIGEST = "sha256:" + "a" * 64


def hop(source=1, target=2, predicate="depends_on"):
    return {"fromId": identity(source), "predicate": predicate, "toId": identity(target),
            "fromRevision": DIGEST, "toRevision": DIGEST}


def report(**changes):
    value = {"format": "morivyx.trace-report/0.1", "queryId": "why-artifact-exists", "graphRevision": "graph:test",
             "schemaLockDigest": DIGEST, "focusId": identity(1), "evaluatedAt": "2026-10-27T00:00:00Z",
             "status": "complete", "paths": [{"hops": [hop()]}], "missing": []}
    value.update(changes)
    return value


class TraceReportValidationTests(unittest.TestCase):
    def test_valid_queries_and_input_preservation(self):
        for query in TRACE_QUERIES:
            value = report(queryId=query)
            before = copy.deepcopy(value)
            self.assertIs(validate_trace_report(value), value)
            self.assertEqual(value, before)

    def test_status_path_missing_and_waiver_consistency(self):
        for status in ("complete", "partial", "waived", "stale", "broken"):
            value = report(status=status, missing=["synthetic"] if status in ("partial", "waived") else [])
            if status == "waived":
                value["waiverDecisionId"] = identity(4)
            validate_trace_report(value)
        for changes, path in [({"paths": []}, "/paths"), ({"missing": ["synthetic"]}, "/missing"),
                              ({"status": "partial"}, "/missing"), ({"status": "waived"}, "/waiverDecisionId"),
                              ({"waiverDecisionId": identity(4)}, "/waiverDecisionId")]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError) as caught:
                validate_trace_report(report(**changes))
            self.assertEqual(caught.exception.path, path)

    def test_required_and_unknown_fields_have_deterministic_locations(self):
        for field in report():
            value = report()
            del value[field]
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                validate_trace_report(value)
            self.assertEqual(caught.exception.path, "/" + field)
        with self.assertRaises(ValidationError) as caught:
            validate_trace_report(report(**{"bad~/field": 1}))
        self.assertEqual(caught.exception.path, "/bad~0~1field")

    def test_focus_and_adjacent_endpoints_include_revisions(self):
        validate_trace_report(report(paths=[{"hops": [hop(2, 1), hop(3, 2)]}]))
        for hops, path in [([], "/paths/0/hops"), ([hop(3, 4)], "/paths/0/hops/0"),
                           ([hop(), hop(3, 4)], "/paths/0/hops/1"),
                           ([hop(), {**hop(2, 3), "fromRevision": "sha256:" + "b" * 64}], "/paths/0/hops/1")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_trace_report(report(paths=[{"hops": hops}]))
            self.assertEqual(caught.exception.path, path)

    def test_path_order_and_duplicate_path_policy(self):
        a, b = {"hops": [hop(predicate="a")]}, {"hops": [hop(predicate="b")]}
        validate_trace_report(report(paths=[a, a, b]))
        with self.assertRaises(ValidationError) as caught:
            validate_trace_report(report(paths=[b, a]))
        self.assertEqual((caught.exception.code, caught.exception.path), ("REPORT_ORDER_INVALID", "/paths/1"))

    def test_missing_order_and_normalized_duplicates(self):
        for missing in [["b", "a"], ["a", "a"], ["e\u0301", "é"]]:
            with self.subTest(missing=missing), self.assertRaises(ValidationError) as caught:
                validate_trace_report(report(status="partial", missing=missing))
            self.assertEqual((caught.exception.code, caught.exception.path), ("REPORT_ORDER_INVALID", "/missing/1"))

    def test_structure_does_not_resolve_graph_references_or_waiver_authority(self):
        value = report(status="waived", missing=["synthetic"], waiverDecisionId=identity(999),
                       paths=[{"hops": [hop(999, 998)]}], focusId=identity(999), graphRevision="graph:unresolved")
        self.assertIs(validate_trace_report(value), value)
        with self.assertRaises(ValidationError) as caught:
            validate_trace_report(report(evaluatedAt="2026-02-30T00:00:00Z"))
        self.assertEqual(caught.exception.path, "/evaluatedAt")


if __name__ == "__main__":
    unittest.main()
