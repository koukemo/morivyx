import copy
import unittest

from canonical import canonical_json
from graph_index import build_graph_index, graph_index_snapshot, verify_graph_index
from package_records import read_package_files
from schema_validation import ValidationError
from test_graph_validation import entity, identity, relation, seal
from test_package_core_validation import files_for


def golden():
    return {"graphRevision": "graph:index-independent", "elements": [entity(3), entity(1), relation(2, identity(3), "link", identity(1), "example.link")]}


def cases():
    base = golden()
    out = []

    def add(name, value, accepted=True):
        out.append({"name": name, "input": copy.deepcopy(value), "accepted": accepted})

    add("golden", base)
    add("reversed", {**base, "elements": list(reversed(base["elements"]))})
    add("empty", {**base, "elements": []})
    for index, value in enumerate([None, [], {}, {"graphRevision": "graph:x"}, {"elements": []}]):
        add("root-" + str(index), value, False)
    for index, value in enumerate([None, [], {}, 0, "", "graph:x y", "graph:x\n", "graph:\ufeff"]):
        add("graph-revision-" + str(index), {**base, "graphRevision": value}, False)
    for index, value in enumerate(["graph:é", "graph:e\u0301", "graph:\u0085"]):
        add("unicode-graph-revision-" + str(index), {**base, "graphRevision": value})
    for index, value in enumerate([None, {}, 0, ""]):
        add("elements-" + str(index), {**base, "elements": value}, False)
    for position in range(3):
        for field in base["elements"][position]:
            for index, entry in enumerate([None, [], {}, "", "bad", 1]):
                value = copy.deepcopy(base)
                value["elements"][position][field] = entry
                add("element-" + str(position) + "-" + field + str(index), value, False)
        value = copy.deepcopy(base)
        value["elements"].append(value["elements"][position])
        add("duplicate-" + str(position), value, False)
    for field in ("source", "target"):
        for index, entry in enumerate([None, [], {}, "", identity(900)]):
            value = copy.deepcopy(base)
            value["elements"][2]["attributes"][field] = entry
            seal(value["elements"][2])
            add("endpoint-" + field + str(index), value, False)
        value = copy.deepcopy(base)
        value["elements"][2]["attributes"].pop(field)
        seal(value["elements"][2])
        add("endpoint-missing-" + field, value, False)
    value = copy.deepcopy(base)
    value["elements"][2]["attributes"]["target"] = identity(2)
    seal(value["elements"][2])
    add("relation-endpoint-is-only-indexed-not-semantically-validated", value)
    for index, type_id in enumerate(["example.é", "example.e\u0301", "example.😀", "example.\ue000"]):
        value = copy.deepcopy(base)
        value["elements"][0].update(type=type_id)
        seal(value["elements"][0])
        add("unicode-type-" + str(index), value)
    value = copy.deepcopy(base)
    value["elements"][0]["type"] = "example.é"
    value["elements"][1]["type"] = "example.e\u0301"
    for element in value["elements"]:
        seal(element)
    add("normalized-type-group", value)
    for position in range(3):
        value = copy.deepcopy(base)
        value["elements"][position]["attributes"]["extra"] = "2026-02-30T00:00:00Z"
        add("noncanonical-date-" + str(position), value, False)
        value["elements"][position]["attributes"]["extra"] = 2 ** 53
        add("unsafe-integer-" + str(position), value, False)
    value = copy.deepcopy(base)
    value["elements"].append(relation(4, identity(3), "link", identity(1), "example.link"))
    add("parallel-relations", value)
    return out


def mutations():
    return ["none", "revision", "root", "element", "type", "outgoing", "incoming", "body", "malformed"]


def mutate(index, name):
    if name == "revision":
        index["graphRevision"] = "graph:other"
    elif name == "root":
        index["rootDigest"] = "sha256:" + "f" * 64
    elif name == "element":
        index["byId"].pop(identity(1))
    elif name == "type":
        index["byType"]["core.actor"] = []
    elif name in ("outgoing", "incoming"):
        index[name] = {}
    elif name == "body":
        index["byId"][identity(1)]["attributes"]["changed"] = True
    elif name == "malformed":
        index["byId"] = None
    return index


def package_index():
    files = files_for(golden()["elements"])
    contents = read_package_files(files)
    return {"files": files, "input": {"graphRevision": contents["revision"]["id"], "elements": contents["elements"]}}


class GraphIndexTests(unittest.TestCase):
    def test_fixed_root_digest(self):
        self.assertEqual(build_graph_index(golden())["rootDigest"], "sha256:34472924b0ede73f9439b263161cfcf25d3f8a9e748b88270db2687125f866d1")

    def test_order_independence_and_maps(self):
        value = golden()
        before = copy.deepcopy(value)
        index = build_graph_index(value)
        reverse = build_graph_index({**value, "elements": list(reversed(value["elements"]))})
        self.assertEqual(graph_index_snapshot(index), graph_index_snapshot(reverse))
        self.assertEqual(list(index["byId"]), [identity(1), identity(2), identity(3)])
        self.assertEqual(index["outgoing"], {identity(3): [identity(2)]})
        self.assertEqual(index["incoming"], {identity(1): [identity(2)]})
        self.assertEqual(value, before)

    def test_corpus_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    index = build_graph_index(case["input"])
                    self.assertTrue(verify_graph_index(index, case["input"])["valid"])
                else:
                    with self.assertRaises(ValidationError):
                        build_graph_index(case["input"])
                self.assertEqual(case["input"], before)

    def test_index_and_snapshot_detach_from_source(self):
        value = golden()
        index = build_graph_index(value)
        snapshot = graph_index_snapshot(index)
        snapshot["types"][0]["elementIds"].clear()
        self.assertTrue(index["byType"]["core.actor"])
        index["byId"][identity(1)]["attributes"]["changed"] = True
        self.assertNotIn("changed", value["elements"][1]["attributes"])

    def test_damage_detection_and_projection_scope(self):
        source = golden()
        for name in mutations():
            result = verify_graph_index(mutate(build_graph_index(source), name), source)
            self.assertEqual(result["valid"], name in ("none", "body"), name)
        self.assertTrue(verify_graph_index(build_graph_index(source), source)["valid"])

    def test_invalid_source_is_not_hidden_by_a_damaged_index(self):
        with self.assertRaises(ValidationError) as caught:
            verify_graph_index(None, {"graphRevision": "graph:x", "elements": None})
        self.assertEqual(caught.exception.path, "/elements")

    def test_checked_package_connection(self):
        value = package_index()
        snapshot = graph_index_snapshot(build_graph_index(value["input"]))
        self.assertEqual(len(snapshot["elements"]), 3)
        self.assertEqual(snapshot["rootDigest"], read_package_files(value["files"])["revision"]["rootDigest"])
        self.assertEqual(canonical_json(snapshot), canonical_json(graph_index_snapshot(build_graph_index(value["input"]))))


if __name__ == "__main__":
    unittest.main()
