import copy
import json
from pathlib import Path
import unittest

from canonical import canonical_json, digest, load_json


FIXTURES = Path(__file__).resolve().parents[1] / "kernel/test/fixtures"
VECTORS = {
    "revision-id-vector.json": ("revision", "element"),
    "schema-lock-digest-vector.json": ("schema-lock", "schemaLock"),
    "schema-definition-digest-vector.json": ("schema", "schemaDefinition"),
    "graph-root-digest-vector.json": ("root", "elements"),
    "changeset-digest-vector.json": ("changeset", "changeSet"),
    "migration-digest-vector.json": ("migration", "migration"),
    "semantic-diff-digest-vector.json": ("semantic-diff", "report"),
    "migration-semantic-diff-digest-vector.json": ("migration-semantic-diff", "report"),
    "trace-report-digest-vector.json": ("trace-report", "report"),
}


class CanonicalTests(unittest.TestCase):
    def test_existing_vectors(self):
        for filename, (kind, field) in VECTORS.items():
            vector = load_json((FIXTURES / filename).read_text())
            cases = vector.get("cases", [vector])
            for case in cases:
                with self.subTest(contract=kind, case=case.get("name")):
                    before = copy.deepcopy(case[field])
                    actual = digest(kind, case[field])
                    self.assertEqual(case[field], before)
                    if case.get("equivalent", True):
                        self.assertEqual(actual, vector["expected"])
                    else:
                        self.assertNotEqual(actual["digest"], vector["expected"]["digest"])

    def test_external_artifact_vectors(self):
        vector = load_json((FIXTURES / "external-artifact-comparison-vectors.json").read_text())
        for case in vector["cases"]:
            with self.subTest(case=case["name"]):
                report = dict(case["expected"])
                if "reportId" in case:
                    report["id"] = case["reportId"]
                self.assertEqual(digest("external-artifact-report", report)["digest"], case["expectedDigest"])

    def test_unicode_and_key_order(self):
        self.assertEqual(canonical_json({"\U00010000": "e\u0301", "\ue000": "é"}),
                         '{"\ue000":"é","\U00010000":"é"}')
        self.assertEqual(canonical_json({"2026-01-01T01:00:00+01:00": "x"}),
                         '{"2026-01-01T01:00:00+01:00":"x"}')
        with self.assertRaises(ValueError):
            canonical_json({"é": 1, "e\u0301": 2})
        for bad in ["\ud800", "\udfff", {"\ud800": 0}]:
            with self.subTest(bad=repr(bad)), self.assertRaises(ValueError):
                canonical_json(bad)

    def test_numeric_boundaries(self):
        for value in [9007199254740991, -9007199254740991, 1.0, 0.0]:
            self.assertEqual(canonical_json(value), str(int(value)))
        for value in [9007199254740992, -9007199254740992, -0.0, 1.5, float("inf"), float("nan")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                canonical_json(value)
        with self.assertRaises(ValueError):
            canonical_json(load_json("-0"))

    def test_json_reader_rejects_ambiguity(self):
        for source in ['{"a":1,"a":2}', "NaN", "Infinity", "-Infinity"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                load_json(source)
        self.assertEqual(canonical_json(load_json("1e3")), "1000")

    def test_time_boundaries_and_precision(self):
        cases = {
            "0000-02-29T00:00:00Z": "0000-02-29T00:00:00Z",
            "0099-01-01T01:00:00+01:00": "0099-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123456789000-14:00": "2026-01-01T14:00:00.123456789Z",
            "2026-01-01T00:00:00.000Z": "2026-01-01T00:00:00Z",
        }
        for source, expected in cases.items():
            self.assertEqual(canonical_json(source), json.dumps(expected))
        for value in ["2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z",
                      "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+14:01",
                      "2026-01-01T00:00:00+00:60", "0000-01-01T00:00:00+00:01",
                      "9999-12-31T23:59:59-00:01"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                canonical_json(value)

    def test_cycles_sharing_and_deep_values(self):
        child = [1]
        self.assertEqual(canonical_json([child, child]), "[[1],[1]]")
        child.append(child)
        with self.assertRaises(ValueError):
            canonical_json(child)
        nested = 0
        for _ in range(3000):
            nested = [nested]
        self.assertEqual(canonical_json(nested), "[" * 3000 + "0" + "]" * 3000)

    def test_diff_duplicate_and_unknown_kind(self):
        for entries in [[{"kind": "unknown"}], [{"kind": "entity_added"}] * 2]:
            with self.assertRaises(ValueError):
                digest("semantic-diff", {"entries": entries})

    def test_omitted_fields_and_domains(self):
        self.assertEqual(digest("revision", {"revision": "old", "x": 1}),
                         digest("revision", {"revision": "new", "x": 1}))
        self.assertNotEqual(digest("schema", {"x": 1})["digest"],
                            digest("schema-lock", {"x": 1})["digest"])
        for kind in ["semantic-diff", "trace-report", "external-artifact-report"]:
            with self.assertRaises(ValueError):
                digest(kind, {"id": -0.0})


if __name__ == "__main__":
    unittest.main()
