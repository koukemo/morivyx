import copy
import unittest

from canonical import canonical_json, digest
from external_comparison import compare_external_artifact_reference
from package_records import read_package_files
from report_records import read_report_source, serialize_report_yaml
from report_validation import validate_external_artifact_report
from test_external_report_validation import VECTOR
from test_graph_validation import identity
from test_package_core_validation import files_for


def cases():
    out = [{"name": "golden-" + value["name"], "input": copy.deepcopy(value["input"])} for value in VECTOR["cases"]]
    base = out[0]["input"]

    def add(name, value):
        out.append({"name": name, "input": copy.deepcopy(value)})

    for field in base:
        for index, value in enumerate([None, [], {}, 0, ""]):
            add("root-" + field + str(index), {**base, field: value})
        value = copy.deepcopy(base)
        value.pop(field)
        add("root-missing-" + field, value)
    for owner in ("artifact", "externalSource"):
        for field in base[owner]:
            for index, entry in enumerate([None, [], {}, "", "bad"]):
                value = copy.deepcopy(base)
                value[owner][field] = entry
                add(owner + "-" + field + str(index), value)
        for field in base[owner]["attributes"]:
            for index, entry in enumerate([None, [], "", "other"]):
                value = copy.deepcopy(base)
                value[owner]["attributes"][field] = entry
                add(owner + "-attributes-" + field + str(index), value)
            value = copy.deepcopy(base)
            value[owner]["attributes"].pop(field)
            add(owner + "-attributes-missing-" + field, value)
        for field in base[owner]["provenance"]:
            for index, entry in enumerate([None, [], "", "other"]):
                value = copy.deepcopy(base)
                value[owner]["provenance"][field] = entry
                add(owner + "-provenance-" + field + str(index), value)
    for field in base["relations"][0]:
        for index, entry in enumerate([None, [], {}, "", "bad"]):
            value = copy.deepcopy(base)
            value["relations"][0][field] = entry
            add("relation-" + field + str(index), value)
    for field in ("source", "target", "predicate"):
        for index, entry in enumerate([None, [], "", identity(900)]):
            value = copy.deepcopy(base)
            value["relations"][0]["attributes"][field] = entry
            add("relation-attributes-" + field + str(index), value)
    for status in ("resolved", "missing", "unavailable", "unknown", None, []):
        for detail in ({}, {"method": "GET"}, {"reason": "offline"}, {"digest": "sha256:" + "a" * 64, "digestRule": "raw-bytes@1", "externalVersion": "v1"}):
            add("retrieval-" + str(len(out)), {**base, "retrieval": {"status": status, "comparedAt": "2026-10-28T00:00:00Z", **detail}})
    for field in base["retrieval"]:
        for index, entry in enumerate([None, [], {}, "", "other", "2026-02-30T00:00:00Z"]):
            value = copy.deepcopy(base)
            value["retrieval"][field] = entry
            add("retrieval-field-" + field + str(index), value)
    for index, rules in enumerate([None, [], {}, [None], ["raw-bytes@1", ""], ["other"], ["raw-bytes@1", "raw-bytes@1"]]):
        add("rules-" + str(index), {**base, "supportedDigestRules": rules})
    for index, relations in enumerate([[], [None], [None, *base["relations"]], base["relations"] * 2]):
        add("relations-list-" + str(index), {**base, "relations": relations})
    value = copy.deepcopy(base)
    value["relations"][0]["attributes"]["target"] = identity(900)
    add("wrong-relation-retains-identity", value)
    value = copy.deepcopy(base)
    value["artifact"]["attributes"].pop("externalVersion")
    value["retrieval"].pop("externalVersion")
    add("no-external-version", value)
    value["retrieval"]["externalVersion"] = "v2"
    add("retrieved-version-without-recorded-version", value)
    value = copy.deepcopy(base)
    value["artifact"]["attributes"]["externalVersion"] = "é"
    value["retrieval"]["externalVersion"] = "e\u0301"
    add("raw-version-comparison", value)
    add("invalid-date-anywhere", {**base, "extra": "2026-02-30T00:00:00Z"})
    add("unsafe-integer-anywhere", {**base, "extra": 2 ** 53})
    add("normalization-key-collision", {**base, "extra": {"é": 1, "e\u0301": 2}})
    add("retrieval-unknown-field", {**base, "retrieval": {**base["retrieval"], "extra": True}})
    for index, entry in enumerate([None, [], 0, "invalid"]):
        add("non-record-" + str(index), entry)
    return out


def package_comparison():
    value = copy.deepcopy(VECTOR["cases"][0]["input"])
    files = files_for([value["artifact"], value["externalSource"], *value["relations"]])
    contents = read_package_files(files)
    by_id = {element["id"]: element for element in contents["elements"]}
    value.update(graphRevision=contents["revision"]["id"], artifact=by_id[value["artifact"]["id"]],
                 externalSource=by_id[value["externalSource"]["id"]], relations=[by_id[record["id"]] for record in value["relations"]])
    return {"files": files, "input": value}


class ExternalComparisonTests(unittest.TestCase):
    def test_five_fixed_reports_and_digests(self):
        for value in VECTOR["cases"]:
            report = compare_external_artifact_reference(value["input"])
            self.assertEqual(report, value["expected"])
            self.assertEqual(digest("external-artifact-report", report)["digest"], value["expectedDigest"])

    def test_corpus_reports_and_input_immutability(self):
        for value in cases():
            with self.subTest(name=value["name"]):
                before = copy.deepcopy(value["input"])
                report = compare_external_artifact_reference(value["input"])
                validate_external_artifact_report(report)
                self.assertEqual(value["input"], before)
                self.assertNotIn("valid", report)

    def test_serialization_roundtrip(self):
        for value in cases():
            report = compare_external_artifact_reference(value["input"])
            restored = read_report_source(serialize_report_yaml(report))
            self.assertEqual(canonical_json(restored["report"]), canonical_json(report), value["name"])
            self.assertEqual(restored["digest"], digest("external-artifact-report", report)["digest"])

    def test_whole_input_canonical_failures_return_minimal_invalid_report(self):
        empty = compare_external_artifact_reference({})
        for name in ("invalid-date-anywhere", "unsafe-integer-anywhere", "normalization-key-collision"):
            value = next(case["input"] for case in cases() if case["name"] == name)
            self.assertEqual(compare_external_artifact_reference(value), empty)

    def test_logical_comparison_does_not_recompute_declared_revisions(self):
        value = copy.deepcopy(VECTOR["cases"][0]["input"])
        value["artifact"]["revision"] = "sha256:" + "f" * 64
        report = compare_external_artifact_reference(value)
        self.assertEqual(report["status"], "current")
        self.assertEqual(report["artifact"]["revision"], value["artifact"]["revision"])
        report["artifact"]["revision"] = None
        self.assertEqual(value["artifact"]["revision"], "sha256:" + "f" * 64)

    def test_checked_package_connection(self):
        value = package_comparison()
        self.assertEqual(compare_external_artifact_reference(value["input"])["status"], "current")


if __name__ == "__main__":
    unittest.main()
