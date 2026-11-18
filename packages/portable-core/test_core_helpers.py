"""Direct helper contracts, including cases beyond the shared observation set."""

import copy
import math
import unittest

from canonical import UNDEFINED, compare_unicode
from graph_validation import compare_issues
from schema_registry import schema_key
from schema_validation import PackageError, ValidationError
from semantic_diff import compare_semantic_diff_entries


class CoreHelpersTest(unittest.TestCase):
    def test_raw_comparison_retains_exact_difference_without_nfc(self):
        self.assertEqual(compare_unicode("a", "c"), -2)
        self.assertEqual(compare_unicode("e\u0301", "é"), -132)
        self.assertEqual(compare_unicode("abcd", "a"), 3)

    def test_code_points_and_lone_surrogates(self):
        self.assertEqual(compare_unicode("\U00010000", "\ue000"), 8192)
        self.assertEqual(compare_unicode("\ud800\udc00", "\U00010000"), 0)
        self.assertEqual(compare_unicode("\ud800", "\udc00"), -1024)

    def test_array_point_extraction_is_eager_on_both_sides(self):
        with self.assertRaisesRegex(TypeError, "value.codePointAt is not a function"):
            compare_unicode(["a", 1], ["z"])
        with self.assertRaisesRegex(TypeError, "value.codePointAt is not a function"):
            compare_unicode(["a"], ["z", False])
        self.assertTrue(math.isnan(compare_unicode([""], ["a"])))
        self.assertEqual(compare_unicode([""], [""]), 0)

    def test_noniterable_logical_primitives_and_omission(self):
        self.assertEqual(compare_unicode(42, True), 0)
        with self.assertRaisesRegex(TypeError, "undefined is not iterable"):
            compare_unicode()
        with self.assertRaisesRegex(TypeError, "object null is not iterable"):
            compare_unicode(None, "")

    def test_package_error_public_defaults_and_projection(self):
        error = PackageError()
        self.assertIsInstance(error, Exception)
        self.assertEqual(error.name, "PackageError")
        self.assertEqual(error.message, "")
        self.assertIs(error.code, UNDEFINED)
        self.assertIs(error.path, UNDEFINED)
        self.assertEqual(error.toIssue(), error.to_issue())
        self.assertIsNot(error.toIssue(), error.toIssue())

    def test_package_error_attributes_preserve_identity(self):
        code, path = {}, []
        error = PackageError(code, path, [None, "x"])
        self.assertEqual(str(error), ",x")
        self.assertIs(error.to_issue()["code"], code)
        self.assertIs(error.to_issue()["path"], path)
        code["changed"] = True
        self.assertTrue(error.to_issue()["code"]["changed"])
        self.assertEqual(PackageError("C", "P", None).message, "null")

    def test_existing_validation_error_is_preserved(self):
        error = ValidationError("OLD", "/path")
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), "OLD: /path")
        self.assertFalse(hasattr(error, "toIssue"))

    def test_schema_key_is_conversion_without_validation(self):
        self.assertEqual(schema_key(), "undefined@undefined")
        self.assertEqual(schema_key(None, False), "null@false")
        self.assertEqual(schema_key([None, "x"], {}), ",x@[object Object]")
        self.assertEqual(schema_key(-0.0, math.inf), "0@Infinity")
        self.assertEqual(schema_key("bad id", "not-a-version"), "bad id@not-a-version")

    def test_conversion_rejects_shadowed_to_string_and_handles_cycles(self):
        for function, args in [(schema_key, ({"toString": 42}, "1")), (PackageError, ("C", "", {"toString": 42}))]:
            with self.assertRaisesRegex(TypeError, "Cannot convert object to primitive value"):
                function(*args)
        array = []
        array.append(array)
        self.assertEqual(schema_key(array, "1"), "@1")

    def test_semantic_kind_order_and_validation_before_text(self):
        self.assertEqual(compare_semantic_diff_entries({"kind": "entity_added"}, {"kind": "schema_changed"}), -12)
        with self.assertRaises(PackageError) as raised:
            compare_semantic_diff_entries({"kind": "entity_added"}, {"kind": "unknown"})
        self.assertEqual(raised.exception.to_issue(), {"code": "SEMANTIC_DIFF_KIND_UNKNOWN", "path": "/entries/kind",
                                                    "message": "未知の semantic diff 種別です: unknown"})

    def test_semantic_text_uses_nfc_and_nonstring_empty(self):
        self.assertEqual(compare_semantic_diff_entries({"kind": "entity_added", "targetId": "e\u0301"},
                                                      {"kind": "entity_added", "targetId": "é"}), 0)
        self.assertEqual(compare_semantic_diff_entries({"kind": "entity_added", "targetId": False},
                                                      {"kind": "entity_added", "targetId": ""}), 0)

    def test_issue_phase_uses_strict_type_equality(self):
        self.assertEqual(compare_issues({"phase": 1, "code": "z"}, {"phase": "1", "code": "a"}), 0)
        self.assertEqual(compare_issues({"phase": 1, "code": "z"}, {"phase": 1.0, "code": "a"}), 25)
        self.assertTrue(math.isnan(compare_issues({"phase": math.nan}, {"phase": math.nan})))
        self.assertEqual(compare_issues({"phase": math.inf, "code": "z"}, {"phase": math.inf, "code": "a"}), 25)

    def test_issue_phase_object_identity_and_number_parsing(self):
        shared = []
        self.assertEqual(compare_issues({"phase": shared, "code": "z"}, {"phase": shared, "code": "a"}), 25)
        self.assertEqual(compare_issues({"phase": [], "code": "z"}, {"phase": [], "code": "a"}), 0)
        self.assertEqual(compare_issues({"phase": "0x10"}, {"phase": 1}), 15)
        self.assertTrue(math.isnan(compare_issues({"phase": "inf"}, {"phase": 1})))
        self.assertTrue(math.isnan(compare_issues({"phase": "1_0"}, {"phase": 1})))

    def test_issue_field_order_normalization_and_no_mutation(self):
        left = {"phase": 1, "elementId": "e\u0301", "code": "a", "path": "z"}
        right = {"phase": 1, "elementId": "é", "code": "c", "path": "a"}
        before = copy.deepcopy([left, right])
        self.assertEqual(compare_issues(left, right), -2)
        self.assertEqual([left, right], before)
        self.assertEqual(compare_issues({"code": "a"}, {"code": "c"}), -2)

    def test_omitted_and_null_records_refuse_with_public_error(self):
        for function, field in [(compare_issues, "phase"), (compare_semantic_diff_entries, "kind")]:
            for value, source in [(UNDEFINED, "undefined"), (None, "null")]:
                with self.assertRaisesRegex(TypeError, f"Cannot read properties of {source} \\(reading '{field}'\\)"):
                    function(value, {})


if __name__ == "__main__":
    unittest.main()
