import copy
import hashlib
import json
from pathlib import Path
import unittest

from canonical import digest
from decision_markdown import project_decision_markdown
from schema_validation import ValidationError


VECTOR = json.loads((Path(__file__).resolve().parents[1] / "kernel/test/fixtures/decision-markdown-vector.json").read_text())


def identity(number):
    return "urn:uuid:00000000-0000-4000-8000-" + f"{number:012d}"


def element(number, type_id, attributes=None, kind="entity"):
    value = {"format": "morivyx.git-graph/0.1", "kind": kind, "id": identity(number), "type": type_id,
             "typeVersion": "0.1", "lifecycle": "active", "reviewState": "unreviewed", "attributes": attributes or {},
             "provenance": {"method": "asserted", "actor": identity(900), "recordedAt": "2026-09-01T16:00:00Z"}}
    if number == 1:
        value.update(lifecycle=VECTOR["input"]["decision"]["lifecycle"], reviewState=VECTOR["input"]["decision"]["reviewState"])
    value["revision"] = digest("revision", value)["digest"]
    return value


def fixed_input():
    source = copy.deepcopy(VECTOR["input"])
    decision = element(1, "core.decision", source["decision"]["attributes"])
    entities = [element(entry["suffix"], entry["type"]) for entry in source["entities"]]
    aliases = {entry["alias"]: value["id"] for entry, value in zip(source["entities"], entities)}
    relations = [element(entry["suffix"], "core." + entry["predicate"],
                         {"source": decision["id"], "predicate": entry["predicate"], "target": aliases[entry["to"]]}, "relation")
                 for entry in source["relations"]]
    return {"graphRevision": source["graphRevision"], "decisionId": decision["id"],
            "projectorPackageDigest": source["projectorPackageDigest"], "elements": [decision, *entities, *relations]}


class DecisionMarkdownTests(unittest.TestCase):
    def test_unchanged_node_vector_binds_all_metadata_and_markdown_bytes(self):
        result = project_decision_markdown(fixed_input())
        for field in ("sourceRevision", "rulesDigest", "configurationDigest", "digest"):
            self.assertEqual(result[field], VECTOR["expected"][field])
        self.assertEqual(len(result["markdown"].encode("utf-8")), VECTOR["expected"]["byteLength"])
        self.assertEqual(result["markdown"].count("\n"), VECTOR["expected"]["lineCount"])
        self.assertEqual(result["digest"], "sha256:" + hashlib.sha256(result["markdown"].encode("utf-8")).hexdigest())

    def test_input_order_is_immaterial_and_claimed_revisions_are_not_authenticated(self):
        value = fixed_input()
        before = copy.deepcopy(value)
        expected = project_decision_markdown(value)
        self.assertEqual(value, before)
        value["elements"].reverse()
        for entry in value["elements"]:
            entry["attributes"] = dict(reversed(list(entry["attributes"].items())))
        self.assertEqual(project_decision_markdown(value), expected)
        for entry in value["elements"]:
            entry["revision"] = "sha256:" + "0" * 64
        value["graphRevision"] = "graph:asserted-only"
        claimed = project_decision_markdown(value)
        self.assertEqual(claimed["sourceRevision"], "sha256:" + "0" * 64)
        self.assertEqual(claimed["graphRevision"], "graph:asserted-only")
        self.assertEqual(claimed["projectorPackageDigest"], value["projectorPackageDigest"])
        self.assertNotIn("valid", claimed)

    def test_text_escapes_markup_and_controls_after_normalizing_lines_and_unicode(self):
        value = fixed_input()
        value["elements"][0]["attributes"]["question"] = " \t# \x00e\u0301\r\n[link](url)"
        result = project_decision_markdown(value)
        self.assertIn("&#32;" * 5 + "\\# \\\\u0000é\n\\[link\\]\\(url\\)", result["markdown"])
        self.assertNotIn("\r", result["markdown"])
        self.assertNotIn("\x00", result["markdown"])

    def test_element_root_and_fragment_diagnostics_match_the_node_api(self):
        for replacement, field, expected in [(None, None, "/elements/1"),
                                             (None, "format", "/elements/1#/format"),
                                             (True, "extra/~", "/elements/1#/extra~1~0")]:
            value = fixed_input()
            if field is None:
                value["elements"][1] = replacement
            else:
                value["elements"][1][field] = replacement
            with self.subTest(field=field), self.assertRaises(ValidationError) as caught:
                project_decision_markdown(value)
            self.assertEqual((caught.exception.code, caught.exception.path), ("GRAPH_ELEMENT_INVALID", expected))

    def test_unknown_relations_are_omitted_only_after_all_endpoints_are_checked(self):
        value = fixed_input()
        position, relation = next((i, entry) for i, entry in enumerate(value["elements"]) if entry["kind"] == "relation")
        relation["type"] = "core.other"
        relation["attributes"]["predicate"] = "other"
        self.assertNotIn("（`other`）", project_decision_markdown(value)["markdown"])
        relation["attributes"]["target"] = identity(999)
        with self.assertRaises(ValidationError) as caught:
            project_decision_markdown(value)
        self.assertEqual((caught.exception.code, caught.exception.path),
                         ("DECISION_PROJECTION_INPUT_INVALID", f"/elements/{position}/attributes/target"))


if __name__ == "__main__":
    unittest.main()
