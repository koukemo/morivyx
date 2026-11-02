import copy
import json
from pathlib import Path
import unittest

from report_validation import validate_external_artifact_report, validate_report
from schema_validation import ValidationError
from test_report_validation import report as trace_report
from test_diff_report_validation import entry, report as diff_report


VECTOR = json.loads((Path(__file__).resolve().parents[1] / "kernel/test/fixtures/external-artifact-comparison-vectors.json").read_text())
REPORTS = {case["expected"]["status"]: case["expected"] for case in VECTOR["cases"]}


class ExternalReportValidationTests(unittest.TestCase):
    def test_five_statuses_preserve_input(self):
        self.assertEqual(set(REPORTS), {"current", "stale", "missing", "unavailable", "invalid"})
        for value in REPORTS.values():
            before = copy.deepcopy(value)
            self.assertIs(validate_external_artifact_report(value), value)
            self.assertEqual(value, before)

    def test_identity_requirements_and_diagnostic_invalid_values(self):
        value = copy.deepcopy(REPORTS["current"])
        value["artifact"]["id"] = "not-a-stable-id"
        with self.assertRaises(ValidationError) as caught:
            validate_external_artifact_report(value)
        self.assertEqual(caught.exception.path, "/artifact/id")
        value = copy.deepcopy(REPORTS["invalid"])
        for field in ("artifact", "externalSource", "relation"):
            for key in value[field]:
                value[field][key] = None
        self.assertIs(validate_external_artifact_report(value), value)

    def test_retrieval_status_and_raw_comparison_time_match(self):
        value = copy.deepcopy(REPORTS["current"])
        value["retrieval"]["status"] = "unavailable"
        with self.assertRaises(ValidationError) as caught:
            validate_external_artifact_report(value)
        self.assertEqual(caught.exception.path, "/retrieval/status")
        value = copy.deepcopy(REPORTS["current"])
        value["comparedAt"] = "2026-09-01T10:00:00+09:00"
        with self.assertRaises(ValidationError) as caught:
            validate_external_artifact_report(value)
        self.assertEqual(caught.exception.path, "/comparedAt")

    def test_issue_order_duplicates_and_status_consistency(self):
        for issues, code, path in [
            ([], "REPORT_STRUCTURE_INVALID", "/issues"),
            ([{"code": "EXTERNAL_DIGEST_CHANGED"}, {"code": "EXTERNAL_VERSION_CHANGED"}], "REPORT_ORDER_INVALID", "/issues/1"),
            ([{"code": "EXTERNAL_DIGEST_CHANGED"}, {"code": "EXTERNAL_DIGEST_CHANGED"}], "REPORT_ORDER_INVALID", "/issues/1"),
            ([{"code": "EXTERNAL_TARGET_MISSING"}], "REPORT_STRUCTURE_INVALID", "/issues"),
            ([{"code": "unknown"}], "REPORT_STRUCTURE_INVALID", "/issues/0/code"),
        ]:
            value = {**REPORTS["stale"], "issues": issues}
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_external_artifact_report(value)
            self.assertEqual((caught.exception.code, caught.exception.path), (code, path))

    def test_invalid_evidence_can_be_recorded_without_authenticating_it(self):
        value = copy.deepcopy(REPORTS["invalid"])
        value.update(graphRevision="untrusted", comparedAt=None, retrieval=None)
        self.assertIs(validate_external_artifact_report(value), value)
        value["retrieval"] = {"status": None, "comparedAt": None, "digest": None, "digestRule": "untrusted"}
        self.assertIs(validate_external_artifact_report(value), value)
        value = copy.deepcopy(REPORTS["current"])
        value["retrieval"]["digestRule"] = "unresolved-rule-name"
        self.assertIs(validate_external_artifact_report(value), value)

    def test_unknown_fields_and_dates(self):
        for changes, path in [({"unknown~/field": 1}, "/unknown~0~1field"),
                              ({"comparedAt": "2026-02-30T00:00:00Z"}, "/comparedAt"), ({"retrieval": None}, "/retrieval")]:
            with self.subTest(path=path), self.assertRaises(ValidationError) as caught:
                validate_external_artifact_report({**REPORTS["current"], **changes})
            self.assertEqual(caught.exception.path, path)

    def test_four_format_dispatch_and_unknown_format(self):
        values = [(trace_report(), "trace-report"), (diff_report(), "semantic-diff"),
                  (diff_report([entry("schema_changed")], migration=True), "migration-semantic-diff"),
                  (REPORTS["current"], "external-artifact-report")]
        for value, expected in values:
            result = validate_report(value)
            self.assertEqual(result["type"], expected)
            self.assertIs(result["report"], value)
        for value in (None, [], False, 0, "text", {}, {"format": []}):
            with self.subTest(value=value), self.assertRaises(ValidationError) as caught:
                validate_report(value)
            self.assertEqual((caught.exception.code, caught.exception.path), ("REPORT_FORMAT_UNSUPPORTED", "/format"))


if __name__ == "__main__":
    unittest.main()
