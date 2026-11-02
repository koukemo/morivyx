import copy
import unittest

from canonical import canonical_json, digest
from package_records import read_package_files
from report_records import read_report_source, serialize_report_yaml
from report_validation import validate_trace_report
from schema_validation import ValidationError
from test_graph_validation import entity, identity, relation
from test_package_core_validation import files_for
from trace_query import execute_trace_query


QUERIES = [("why-artifact-exists", 1), ("governing-decision", 1), ("decision-evidence", 5),
           ("goal-achievement-evidence", 4), ("observation-triggered-change", 7)]
GOLDEN_DIGESTS = ["fdd6e89fa3d884fce1293f128c7b5d68541ab0345a37f1f0768978995bb939f2",
                  "88954b8f2b23f4b8ef4ea563b399cd28df201ef5652f15be283dcd7248031f8f",
                  "fc5c3daefe4bd2b3a1bd893d77b489422371d6e8ff3b93e14563cca01ecfb656",
                  "7af351131f89d005d265bfd1834fafabac443616266d7a04dfbb016465bc4290",
                  "910724f376ae28a8581d44e4cb432cb9a58ee60bbc4e2c76c6fb2688e8459e00"]


def graph():
    types = ["artifact", "execution", "plan", "goal", "decision", "knowledge", "observation", "criterion", "verification", "learning"]
    elements = [entity(index, "core." + name) for index, name in enumerate(types, 1)]
    links = [(2, "produces", 1), (2, "executes", 3), (3, "pursues", 4), (5, "governs", 1),
             (5, "supported_by", 6), (5, "challenged_by", 7), (4, "has_criterion", 8),
             (9, "against", 8), (9, "produces", 7), (10, "derived_from", 7), (10, "triggers", 4)]
    return elements + [relation(index, identity(source), predicate, identity(target))
                       for index, (source, predicate, target) in enumerate(links, 20)]


def query(query_id, focus, elements=None):
    return {"queryId": query_id, "graphRevision": "graph:trace-independent", "schemaLockDigest": "sha256:" + "a" * 64,
            "focusId": identity(focus), "evaluatedAt": "2026-10-28T00:00:00Z",
            "id": identity(999), "elements": graph() if elements is None else elements}


def cases():
    out = []

    def add(name, value, accepted=True):
        out.append({"name": name, "input": copy.deepcopy(value), "accepted": accepted})

    for query_id, focus in QUERIES:
        original = query(query_id, focus)
        add(query_id + "-golden", original)
        add(query_id + "-reversed", {**original, "elements": list(reversed(original["elements"]))})
        add(query_id + "-empty", {**original, "elements": []})
        add(query_id + "-missing-focus", {**original, "focusId": identity(998)})
        for index in range(len(original["elements"])):
            elements = copy.deepcopy(original["elements"])
            add(query_id + "-remove-" + str(index), {**original, "elements": elements[:index] + elements[index + 1:]})
            if elements[index]["kind"] == "entity":
                for revision in (False, True):
                    value = relation(900, identity(998), "unused", identity(998))
                    value.update(id=elements[index]["id"], type=elements[index]["type"])
                    if not revision:
                        value.pop("revision")
                    replaced = copy.deepcopy(elements)
                    replaced[index] = value
                    add(query_id + "-relation-" + str(index) + "-" + str(revision), {**original, "elements": replaced})
                elements[index]["type"] = "example.other"
                add(query_id + "-wrong-type-" + str(index), {**original, "elements": elements})
            else:
                value = copy.deepcopy(elements[index])
                value["id"] = identity(1000 + index)
                add(query_id + "-parallel-" + str(index), {**original, "elements": [*elements, value]})
        no_id = copy.deepcopy(original)
        no_id.pop("id")
        add(query_id + "-without-id", no_id)
        for field, values in {"graphRevision": [None, 0, "graph:a b", "graph:\ufeff", "graph:\u0085"],
                              "schemaLockDigest": [None, "sha256:" + "A" * 64],
                              "focusId": [None, identity(1).upper()], "id": [None, []],
                              "evaluatedAt": [None, "2026-02-30T00:00:00Z", "2026-10-28T09:00:00+09:00"],
                              "elements": [None, {}]}.items():
            for index, value in enumerate(values):
                accepted = (field == "graphRevision" and value == "graph:\u0085") or (field == "evaluatedAt" and index == 2)
                add(query_id + "-header-" + field + str(index), {**original, field: value}, accepted)
    base = query("decision-evidence", 5)
    for index, challenge in enumerate([None, False, 0, "", [], {}, True, "reviewed"]):
        value = copy.deepcopy(base)
        value["elements"] = [e for e in value["elements"] if e.get("attributes", {}).get("predicate") != "challenged_by"]
        value["elements"][4]["attributes"]["challengeReview"] = challenge
        add("challenge-review-" + str(index), value)
    for index, value in enumerate([None, [], {}, {"queryId": []}, {"queryId": "unknown"}]):
        add("unknown-" + str(index), value, False)
    for position in (0, 10):
        for field, values in {"id": [None, "bad"], "kind": [None, []], "type": [None, ""],
                              "revision": [None, "bad"], "attributes": [None, []]}.items():
            for index, entry in enumerate(values):
                value = copy.deepcopy(base)
                value["elements"][position][field] = entry
                accepted = (position == 0 and field == "attributes") or (position == 10 and field == "type")
                add("element-" + str(position) + "-" + field + str(index), value, accepted)
    for field in ("source", "target", "predicate"):
        for index, entry in enumerate([None, [], ""]):
            value = copy.deepcopy(base)
            value["elements"][10]["attributes"][field] = entry
            add("relation-attributes-" + field + str(index), value, False)
    for index, entry in enumerate([None, [], 0]):
        add("element-not-record-" + str(index), {**base, "elements": [entry]}, False)
    add("duplicate-id", {**base, "elements": [*base["elements"], base["elements"][0]]}, False)
    no_relation_revision = copy.deepcopy(base)
    for element in no_relation_revision["elements"]:
        if element["kind"] == "relation":
            element.pop("revision")
    add("optional-relation-revisions", no_relation_revision)
    return out


def package_queries():
    files = files_for(graph())
    contents = read_package_files(files)
    return [{"files": files, "input": {**query(query_id, focus, contents["elements"]),
             "graphRevision": contents["revision"]["id"], "schemaLockDigest": contents["revision"]["schemaLockDigest"]}}
            for query_id, focus in QUERIES]


class TraceQueryTests(unittest.TestCase):
    def test_five_fixed_digests(self):
        for (query_id, focus), expected in zip(QUERIES, GOLDEN_DIGESTS):
            value = query(query_id, focus)
            report = execute_trace_query(value)
            self.assertEqual(digest("trace-report", report)["digest"], "sha256:" + expected)
            value["id"] = identity(998)
            self.assertEqual(digest("trace-report", execute_trace_query(value))["digest"], "sha256:" + expected)

    def test_fanout_keeps_all_paths_and_detaches_output(self):
        value = query("governing-decision", 1)
        original = copy.deepcopy(value)
        for index in range(256):
            value["elements"].append(relation(2000 + index, identity(5), "governs", identity(1)))
        report = execute_trace_query(value)
        self.assertEqual(len(report["paths"]), 257)
        report["paths"][0]["hops"][0]["fromId"] = identity(998)
        self.assertEqual(value["elements"][:len(original["elements"])], original["elements"])
        self.assertNotEqual(execute_trace_query(value)["paths"][0], report["paths"][0])

    def test_all_five_complete_paths(self):
        for (query_id, focus), count in zip(QUERIES, [1, 1, 2, 1, 1]):
            report = execute_trace_query(query(query_id, focus))
            self.assertEqual(report["status"], "complete")
            self.assertEqual(len(report["paths"]), count)
            self.assertEqual(report["missing"], [])
            self.assertEqual(validate_trace_report(report), report)

    def test_corpus_and_input_immutability(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    report = execute_trace_query(case["input"])
                    self.assertNotIn("valid", report)
                    validate_trace_report(report)
                    self.assertTrue(digest("trace-report", report)["digest"].startswith("sha256:"))
                else:
                    with self.assertRaises(ValidationError):
                        execute_trace_query(case["input"])
                self.assertEqual(case["input"], before)

    def test_duplicate_paths_are_preserved(self):
        value = query("governing-decision", 1)
        duplicate = copy.deepcopy(value["elements"][13])
        duplicate["id"] = identity(900)
        value["elements"].append(duplicate)
        report = execute_trace_query(value)
        self.assertEqual(len(report["paths"]), 2)
        self.assertEqual(report["paths"][0], report["paths"][1])

    def test_broken_paths_keep_other_evidence(self):
        value = query("decision-evidence", 5)
        value["elements"] = [e for e in value["elements"] if e["id"] != identity(6)]
        report = execute_trace_query(value)
        self.assertEqual(report["status"], "broken")
        self.assertEqual(len(report["paths"]), 1)
        self.assertEqual(report["missing"], ["supported_by"])

    def test_serialization_roundtrip(self):
        for case in cases():
            if case["accepted"]:
                report = execute_trace_query(case["input"])
                restored = read_report_source(serialize_report_yaml(report))["report"]
                self.assertEqual(canonical_json(restored), canonical_json(report))
                self.assertEqual(digest("trace-report", restored), digest("trace-report", report))

    def test_checked_package_reads(self):
        for value in package_queries():
            before = copy.deepcopy(value)
            self.assertEqual(execute_trace_query(value["input"])["status"], "complete")
            self.assertEqual(value, before)


if __name__ == "__main__":
    unittest.main()
