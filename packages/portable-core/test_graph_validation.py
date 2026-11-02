import copy
import unittest

from canonical import digest
from graph_validation import validate_graph
from schema_validation import ValidationError, load_core_schema


SCHEMA = load_core_schema()


def identity(index):
    return f"urn:uuid:00000000-0000-4000-8000-{index:012x}"


def seal(element):
    element["revision"] = digest("revision", element)["digest"]
    return element


def entity(index, type_id="core.actor", **changes):
    definition = next(entry for entry in SCHEMA["entityTypes"] if entry["typeId"] == type_id)
    value = {
        "format": "morivyx.git-graph/0.1", "kind": "entity", "id": identity(index),
        "type": type_id, "typeVersion": "0.1", "lifecycle": "draft", "reviewState": "unreviewed",
        "attributes": {field: "synthetic" for field in definition["requiredAttributes"]},
        "provenance": {"method": "asserted", "actor": identity(1), "recordedAt": "2026-10-27T00:00:00Z"},
    }
    value.update(changes)
    return seal(value)


def relation(index, source, predicate, target, type_id=None):
    value = entity(index)
    value.update(kind="relation", type=type_id or "core." + predicate,
                 attributes={"source": source, "predicate": predicate, "target": target})
    return seal(value)


def extra_schema():
    return {**copy.deepcopy(SCHEMA), "schemaId": "example.test", "entityTypes": [], "relationTypes": [{
        "predicate": "link", "sourceTypes": ["core.actor"], "targetTypes": ["core.actor"],
        "minCount": 0, "maxCount": None, "cycle": "forbidden",
    }]}


def check(elements, schemas=None, **options):
    return validate_graph(graph_revision="graph:synthetic", schema_lock_digest="sha256:" + "0" * 64,
                          schemas=schemas or [SCHEMA], elements=elements, **options)


def approval(element, index=9000, **changes):
    value = {"id": identity(index), "actor": identity(1), "targetId": element["id"],
             "targetRevision": element["revision"], "operation": "approve", "scope": "single-revision",
             "approvedAt": "2026-10-27T00:00:00Z", "recordedAt": "2026-10-27T00:00:00Z"}
    value.update(changes)
    return value


class GraphValidationTests(unittest.TestCase):
    def test_schema_attribute_state_and_version_checks(self):
        original = [entity(1)]
        before = copy.deepcopy(original)
        self.assertTrue(check(original)["valid"])
        self.assertEqual(original, before)
        for changes, path in [({"type": "unknown.type"}, "/type"), ({"typeVersion": "9"}, "/typeVersion"),
                              ({"lifecycle": "unknown"}, "/lifecycle"),
                              ({"attributes": {"actorKind": "human"}}, "/attributes/name"),
                              ({"attributes": {"actorKind": "human", "name": "synthetic", "extra": 1}}, "/attributes/extra")]:
            value = entity(1, **changes)
            with self.subTest(path=path):
                self.assertIn(path, [i["path"] for i in check([value])["issues"]])

    def test_duplicate_identity_and_revision(self):
        a, b = entity(1), entity(2)
        b["revision"] = a["revision"]
        self.assertIn("/revision", [i["path"] for i in check([a, b])["issues"]])
        self.assertIn("/id", [i["path"] for i in check([a, copy.deepcopy(a)])["issues"]])

    def test_endpoint_existence_and_allowed_type(self):
        a = entity(1)
        missing = relation(2, identity(999), "depends_on", a["id"])
        self.assertIn("RELATION_TARGET_MISSING", [i["code"] for i in check([a, missing])["issues"]])
        decision = entity(3, "core.decision")
        wrong = relation(4, decision["id"], "governs", a["id"])
        self.assertIn("RELATION_TYPE_DISALLOWED", [i["code"] for i in check([a, decision, wrong])["issues"]])
        for field in ("source", "target", "predicate"):
            for value in ([], {}, False, True, 0, 1):
                invalid = relation(2, a["id"], "depends_on", a["id"])
                invalid["attributes"][field] = value
                seal(invalid)
                with self.subTest(field=field, value=value):
                    self.assertFalse(check([a, invalid])["valid"])

    def test_cardinality_decision_evidence_and_artifact_producers(self):
        verification = entity(1, "core.verification")
        self.assertIn("/relations/against", [i["path"] for i in check([verification])["issues"]])
        decision = entity(2, "core.decision", lifecycle="accepted")
        paths = [i["path"] for i in check([decision])["issues"]]
        self.assertIn("/relations/supported_by", paths)
        self.assertIn("/relations/challenged_by", paths)
        observation = entity(3, "core.observation")
        decision["attributes"]["challengeReview"] = "synthetic review marker"
        seal(decision)
        supported = relation(4, decision["id"], "supported_by", observation["id"])
        self.assertTrue(check([decision, observation, supported])["valid"])
        artifact = entity(5, "core.artifact")
        executions = [entity(i, "core.execution") for i in (6, 7)]
        produces = [relation(10 + i, e["id"], "produces", artifact["id"]) for i, e in enumerate(executions)]
        self.assertIn("/relations/produces", [i["path"] for i in check([artifact, *executions, *produces])["issues"]])

    def test_duplicate_relations_and_allowed_and_forbidden_cycles(self):
        a, b = entity(1), entity(2)
        forward = relation(3, a["id"], "depends_on", b["id"])
        reverse = relation(4, b["id"], "depends_on", a["id"])
        self.assertTrue(check([a, b, forward, reverse])["valid"])
        duplicate = relation(5, a["id"], "depends_on", b["id"])
        self.assertIn("RELATION_DUPLICATE", [i["code"] for i in check([a, b, forward, duplicate])["issues"]])
        cycle = [relation(3, a["id"], "link", b["id"], "example.link"),
                 relation(4, b["id"], "link", a["id"], "example.link")]
        issues = check([a, b, *cycle], schemas=[SCHEMA, extra_schema()])["issues"]
        self.assertEqual([(i["elementId"], i["relatedId"]) for i in issues if i["code"] == "CYCLE_FORBIDDEN"], [(a["id"], b["id"])])
        self_loop = relation(3, a["id"], "link", a["id"], "example.link")
        self.assertEqual(check([a, self_loop], schemas=[SCHEMA, extra_schema()])["issues"][0]["code"], "CYCLE_FORBIDDEN")

    def test_lifecycle_history_is_not_rewritten(self):
        before = entity(1, "core.learning", lifecycle="active")
        current = entity(1, "core.learning", lifecycle="draft")
        self.assertIn("LIFECYCLE_TRANSITION", [i["code"] for i in check([current], previous_elements=[before])["issues"]])
        allowed = entity(1, "core.learning", lifecycle="superseded")
        self.assertTrue(check([allowed], previous_elements=[before])["valid"])

    def test_approval_target_revision_and_revocation(self):
        target = entity(1, reviewState="approved")
        self.assertIn("APPROVAL_REQUIRED", [i["code"] for i in check([target])["issues"]])
        grant = approval(target)
        self.assertTrue(check([target], approvals=[grant])["valid"])
        wrong = approval(target, targetRevision="sha256:" + "f" * 64)
        self.assertFalse(check([target], approvals=[wrong])["valid"])
        revoke = approval(target, index=9001, operation="revoke", revokes=grant["id"])
        self.assertFalse(check([target], approvals=[grant, revoke])["valid"])
        incomplete = approval(target, actor="")
        self.assertIn("PROVENANCE_REQUIRED", [i["code"] for i in check([target], approvals=[incomplete])["issues"]])

    def test_diagnostics_and_root_do_not_depend_on_input_order(self):
        a, b = entity(1), entity(2)
        relations = [relation(3, a["id"], "depends_on", identity(999)),
                     relation(4, a["id"], "depends_on", identity(999))]
        self.assertEqual(check([a, b, *relations]), check([*reversed(relations), b, a]))

    def test_long_cycle_uses_iterative_traversal(self):
        size = 2000
        nodes = [entity(i + 1) for i in range(size)]
        edges = [relation(size + i + 1, nodes[i]["id"], "link", nodes[(i + 1) % size]["id"], "example.link") for i in range(size)]
        result = check([*nodes, *edges], schemas=[SCHEMA, extra_schema()])
        self.assertEqual([i["code"] for i in result["issues"]], ["CYCLE_FORBIDDEN"])

    def test_structure_and_validation_scope_remain_explicit(self):
        bad = entity(1)
        del bad["provenance"]
        with self.assertRaises(ValidationError):
            check([bad])
        result = check([entity(1)])
        self.assertEqual(result["validation"]["scope"], "graph-structure-and-constraints")
        self.assertFalse(any(v for k, v in result["validation"].items() if k.endswith("Validated")))


if __name__ == "__main__":
    unittest.main()
