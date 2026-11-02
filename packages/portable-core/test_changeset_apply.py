import copy
import json
from pathlib import Path
import unittest

from canonical import digest
from changeset_apply import apply_change_set
from schema_validation import ValidationError
from test_graph_validation import entity, identity, seal
from test_package_records import inputs
from package_records import read_package_files


LOCK = "sha256:" + "a" * 64
OTHER_LOCK = "sha256:" + "b" * 64
KNOWN = identity(8999)


def operation(name, before=None, after=None, target=None):
    result = {"op": name, "targetId": target or (before or after)["id"]}
    if before is not None:
        result["beforeRevision"] = before["revision"]
    if after is not None:
        result["afterRevision"] = after["revision"]
    if name == "replace":
        result["replacementId"] = after["id"]
    return result


def frame(current, candidates, operations, expected, target_lock=LOCK):
    root = digest("root", expected)["digest"]
    change = {"format": "morivyx.changeset/0.1", "id": identity(9000),
              "baseRevision": "graph:apply-current", "resultingRevision": "graph:apply-next",
              "resultingRootDigest": root, "schemaLockDigest": target_lock, "operations": operations,
              "provenance": {"method": "generated", "actor": identity(1), "recordedAt": "2026-10-28T00:00:00Z"},
              "recordedAt": "2026-10-28T00:00:00Z"}
    return {"changeSet": change, "schemaLockDigest": LOCK, "currentElements": copy.deepcopy(current), "candidateElements": copy.deepcopy(candidates),
            "currentRevision": {"format": "morivyx.graph-revision/0.1", "id": change["baseRevision"], "parentRevision": None,
                                "rootDigest": digest("root", current)["digest"], "schemaLockDigest": LOCK},
            "resultingRevision": {"format": "morivyx.graph-revision/0.1", "id": change["resultingRevision"],
                                  "parentRevision": change["baseRevision"], "rootDigest": root, "schemaLockDigest": target_lock}}


def golden():
    base = read_package_files(inputs())
    revised = copy.deepcopy(base["elements"][0])
    revised["attributes"]["stringValues"][2] = "revised"
    revised = seal(revised)
    created = {"format": "morivyx.git-graph/0.1", "kind": "entity", "id": "urn:uuid:550e8400-e29b-41d4-a716-446655440004",
               "type": "core.observation", "typeVersion": "0.1", "lifecycle": "draft", "reviewState": "unreviewed",
               "attributes": {"observedAt": "2026-07-31T04:00:00Z", "recordedAt": "2026-07-31T04:05:00Z", "stringValues": ["third"]},
               "provenance": {"method": "observed", "actor": "urn:uuid:550e8400-e29b-41d4-a716-446655440001", "recordedAt": "2026-07-31T04:05:00Z"}}
    created = seal(created)
    path = Path(__file__).resolve().parents[1] / "kernel/test/fixtures/changeset-digest-vector.json"
    change = json.loads(json.loads(path.read_text())["expected"]["canonicalJson"])
    change["id"] = "urn:uuid:550e8400-e29b-41d4-a716-446655440005"
    return {"changeSet": change, "currentRevision": base["revision"], "schemaLockDigest": base["calculatedSchemaLockDigest"],
            "currentElements": base["elements"], "candidateElements": [revised, created],
            "resultingRevision": {"format": "morivyx.graph-revision/0.1", "id": change["resultingRevision"],
                                  "parentRevision": change["baseRevision"], "rootDigest": change["resultingRootDigest"], "schemaLockDigest": change["schemaLockDigest"]}}


def cases():
    a, b, c = entity(1), entity(2), entity(3)
    revised = seal({**a, "attributes": {**a["attributes"], "name": "revised"}})
    b_next = seal({**b, "attributes": {**b["attributes"], "name": "next"}})
    create = frame([a], [b], [operation("create", after=b)], [a, b])
    revise = frame([a], [revised], [operation("revise", a, revised)], [revised])
    retire = frame([a], [], [operation("retire", a)], [])
    replace = frame([a], [b], [operation("replace", a, b)], [b])
    revoke = frame([a], [], [{"op": "revoke", "targetId": KNOWN}], [a])
    revoke["knownChangeSetIds"] = [KNOWN]
    out = [{"name": "golden", "input": golden(), "accepted": True}]
    for name, value in [("create", create), ("revise", revise), ("retire-empty", retire), ("replace", replace), ("revoke", revoke),
                        ("create-empty", frame([], [b], [operation("create", after=b)], [b])),
                        ("ordered-chain", frame([], [b, b_next], [operation("create", after=b), operation("revise", b, b_next), operation("retire", b_next)], [])),
                        ("multiple-revisions-same-id", frame([a], [revised, a], [operation("revise", a, revised), operation("revise", revised, a)], [a])),
                        ("sorted-output", frame([c, a], [], [operation("retire", a)], [c]))]:
        out.append({"name": name, "input": value, "accepted": True})

    def add(name, base, transform, accepted=False):
        value = copy.deepcopy(base)
        transform(value)
        out.append({"name": name, "input": value, "accepted": accepted})

    add("no-candidate-field", retire, lambda v: v.pop("candidateElements"), True)
    add("unread-id-options-for-graph-operation", create, lambda v: v.update(knownChangeSetIds=None, appliedChangeSetIds=False), True)
    migration = frame([a], [revised], [operation("revise", a, revised)], [revised], OTHER_LOCK)
    migration["targetSchemaLockDigest"] = OTHER_LOCK
    out.append({"name": "different-schema-boundaries", "input": migration, "accepted": True})
    add("explicit-schema-boundaries-without-default", migration,
        lambda v: (v.pop("schemaLockDigest"), v.update(sourceSchemaLockDigest=LOCK)), True)
    unknown = seal({**b, "type": "unknown.type"})
    out.append({"name": "structural-apply-without-schema-verdict", "input": frame([a], [unknown], [operation("create", after=unknown)], [a, unknown]), "accepted": True})
    for name, value in [("null-input", None), ("array-input", []), ("boolean-input", False)]:
        out.append({"name": name, "input": value, "accepted": False})
    for field in ("changeSet", "currentElements", "currentRevision", "candidateElements", "resultingRevision"):
        for invalid in (None, [], {}, False, "wrong"):
            if field in ("currentElements", "candidateElements") and invalid == []:
                continue
            add(field + "-" + repr(invalid), create, lambda v, f=field, x=invalid: v.update({f: x}))
    add("duplicate-current-id", create, lambda v: v["currentElements"].append(copy.deepcopy(a)))
    add("duplicate-candidate-revision", create, lambda v: v["candidateElements"].append(copy.deepcopy(b)))
    for collection in ("currentElements", "candidateElements"):
        for field in ("id", "revision"):
            add(collection + "-missing-" + field, create, lambda v, k=collection, f=field: v[k][0].pop(f))
        add(collection + "-actor", create, lambda v, k=collection: v[k][0]["provenance"].update(actor=False))
        add(collection + "-digest", create, lambda v, k=collection: v[k][0].update(revision="sha256:" + "0" * 64))
    add("base-id", create, lambda v: v["currentRevision"].update(id="graph:other"))
    add("current-root", create, lambda v: v["currentRevision"].update(rootDigest="sha256:" + "0" * 64))
    add("current-record-unknown-field", create, lambda v: v["currentRevision"].update(extra=1))
    for field in ("schemaLockDigest", "sourceSchemaLockDigest", "targetSchemaLockDigest"):
        add(field + "-null", create, lambda v, f=field: v.update({f: None}))
        add(field + "-wrong", create, lambda v, f=field: v.update({f: OTHER_LOCK}))
    add("missing-candidate", create, lambda v: v.update(candidateElements=[]))
    add("unused-candidate", create, lambda v: v["candidateElements"].append(copy.deepcopy(c)))
    add("create-existing", create, lambda v: v["changeSet"]["operations"][0].update(targetId=a["id"]))
    add("revise-missing", revise, lambda v: v["changeSet"]["operations"][0].update(targetId=b["id"]))
    add("revise-before", revise, lambda v: v["changeSet"]["operations"][0].update(beforeRevision="sha256:" + "0" * 64))
    add("retire-missing", retire, lambda v: v["changeSet"]["operations"][0].update(targetId=b["id"]))
    collision = frame([a, b], [b], [operation("replace", a, b)], [b])
    out.append({"name": "replace-existing", "input": collision, "accepted": False})
    add("resulting-root", create, lambda v: v["changeSet"].update(resultingRootDigest="sha256:" + "0" * 64))
    for field, replacement_value in [("format", "unknown"), ("id", "graph:other"), ("parentRevision", None),
                                     ("rootDigest", "sha256:" + "0" * 64), ("schemaLockDigest", OTHER_LOCK)]:
        add("resulting-record-" + field, create, lambda v, f=field, x=replacement_value: v["resultingRevision"].update({f: x}))
    add("resulting-record-unknown-field", create, lambda v: v["resultingRevision"].update(extra=1))
    add("revoke-self", revoke, lambda v: v["changeSet"]["operations"][0].update(targetId=v["changeSet"]["id"]))
    add("revoke-unknown", revoke, lambda v: v.update(knownChangeSetIds=[]))
    add("revoke-applied", revoke, lambda v: v.update(appliedChangeSetIds=[KNOWN]))
    add("revoke-unused-candidate", revoke, lambda v: v.update(candidateElements=[b]))
    for field in ("knownChangeSetIds", "appliedChangeSetIds"):
        for invalid in (None, {}, [KNOWN, KNOWN], [False], ["invalid"]):
            add(field + "-" + repr(invalid), revoke, lambda v, f=field, x=invalid: v.update({f: x}))
    add("array-operation-name", create, lambda v: v["changeSet"]["operations"][0].update(op=["create"]))
    add("empty-operations", create, lambda v: v["changeSet"].update(operations=[]))
    return out


class ChangeSetApplyTests(unittest.TestCase):
    def test_fixed_golden_result(self):
        result = apply_change_set(golden())
        self.assertEqual(result["rootDigest"], "sha256:323394de2907b95362fa00bd9e8042bf1245da5b0665f14432767d285da1e538")
        self.assertEqual(len(result["elements"]), 3)

    def test_corpus_acceptance_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    result = apply_change_set(case["input"])
                    self.assertEqual(result["rootDigest"], case["input"]["changeSet"]["resultingRootDigest"])
                else:
                    with self.assertRaises(ValueError):
                        apply_change_set(case["input"])
                self.assertEqual(case["input"], before)

    def test_all_five_operations_and_ordered_chains(self):
        accepted = [case for case in cases() if case["accepted"]]
        self.assertEqual({op["op"] for case in accepted for op in case["input"]["changeSet"]["operations"]}, {"create", "revise", "retire", "replace", "revoke"})
        chain = next(case for case in accepted if case["name"] == "ordered-chain")
        self.assertEqual(apply_change_set(chain["input"])["elements"], [])

    def test_returned_values_are_independent_copies(self):
        value = golden()
        before = copy.deepcopy(value)
        result = apply_change_set(value)
        result["elements"][0]["attributes"]["stringValues"].append("changed")
        result["revision"]["id"] = "graph:changed"
        self.assertEqual(value, before)

    def test_diagnostics_identify_boundaries_candidates_and_revocation(self):
        expected = {"current-root": ("CHANGESET_APPLY_INVALID", "/currentRevision/rootDigest"),
                    "candidateElements-digest": ("CHANGESET_CANDIDATE_REVISION_MISMATCH", "/candidateElements/0/revision"),
                    "unused-candidate": ("CHANGESET_PRECONDITION_FAILED", "/candidateElements/1"),
                    "revise-before": ("CHANGESET_PRECONDITION_FAILED", "/operations/0/beforeRevision"),
                    "revoke-applied": ("CHANGESET_REVOKE_INVALID", "/operations/0/targetId"),
                    "resulting-record-parentRevision": ("CHANGESET_RESULT_MISMATCH", "/resultingRevisionRecord/parentRevision")}
        for case in cases():
            if case["name"] in expected:
                with self.assertRaises(ValidationError) as caught:
                    apply_change_set(case["input"])
                self.assertEqual((caught.exception.code, caught.exception.path), expected[case["name"]])

    def test_different_schema_boundaries_and_multiple_candidate_revisions(self):
        for name in ("different-schema-boundaries", "explicit-schema-boundaries-without-default", "multiple-revisions-same-id"):
            case = next(case for case in cases() if case["name"] == name)
            self.assertEqual(apply_change_set(case["input"])["revision"], case["input"]["resultingRevision"])

    def test_result_does_not_claim_graph_meaning_or_authority(self):
        case = next(case for case in cases() if case["name"] == "structural-apply-without-schema-verdict")
        result = apply_change_set(case["input"])
        self.assertEqual(set(result), {"elements", "revision", "rootDigest"})
        self.assertTrue(any(element["type"] == "unknown.type" for element in result["elements"]))


if __name__ == "__main__":
    unittest.main()
