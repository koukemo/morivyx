import copy
import unittest

from canonical import canonical_json, digest
from changeset_apply import apply_change_set
from migration_apply import apply_migration
from package_records import read_package_files, write_package_files
from package_validation import validate_package_files
from report_records import prepare_report, read_report_source, serialize_report_yaml
from schema_validation import ValidationError
from semantic_diff import create_migration_semantic_diff, create_semantic_diff
from test_changeset_apply import frame, golden as change_golden, operation
from test_graph_validation import entity, identity, seal
from test_migration_apply import actual_target_input
from test_package_records import inputs
from test_package_core_validation import files_for
from test_report_records import MIGRATION, NORMAL


QUERIES = "why-artifact-exists governing-decision decision-evidence goal-achievement-evidence observation-triggered-change".split()
STATUSES = "complete partial waived stale broken".split()


def projection(index, kind="entity", revision="a"):
    return {"id": identity(index), "kind": kind, "revision": "sha256:" + revision * 64}


def ordinary():
    return {"baseRevision": "graph:base", "targetRevision": "graph:target", "schemaLockDigest": "sha256:" + "a" * 64,
            "evaluatedAt": "2026-10-28T00:00:00Z", "baseElements": [], "targetElements": []}


def migration():
    source = {"format": "morivyx.schema-lock/0.1", "stableIdScheme": "urn-uuid-v4", "digestAlgorithm": "sha256",
              "schemas": [{"schemaId": "example.core", "version": "0.1", "digest": "sha256:" + "a" * 64}]}
    target = copy.deepcopy(source)
    target["schemas"][0]["version"] = "0.2"
    value = ordinary()
    value.pop("schemaLockDigest")
    value.update(sourceSchemaLock=source, targetSchemaLock=target)
    reseal(value)
    return value


def reseal(value):
    for side in ("source", "target"):
        if side + "SchemaLock" in value:
            value[side + "SchemaLockDigest"] = digest("schema-lock", value[side + "SchemaLock"])["digest"]


def golden_inputs():
    value = change_golden()
    after = apply_change_set(value)
    normal = {field: NORMAL[field] for field in ("baseRevision", "targetRevision", "schemaLockDigest", "evaluatedAt")}
    normal.update(baseElements=value["currentElements"], targetElements=after["elements"],
                  traceChanges=[{key: value for key, value in NORMAL["entries"][-1].items() if key != "kind"}])
    source = read_package_files(inputs())["schemaLock"]
    target = copy.deepcopy(source)
    target["schemas"][0].update(version="0.2", digest="sha256:fd354ccf8058f143f9355a727321de0eb2b9dfed2bd8d3203d3e628aeb4588b1")
    migrated = {field: MIGRATION[field] for field in ("baseRevision", "targetRevision", "sourceSchemaLockDigest", "targetSchemaLockDigest", "evaluatedAt")}
    migrated.update(sourceSchemaLock=source, targetSchemaLock=target, baseElements=value["currentElements"], targetElements=after["elements"])
    return normal, migrated


def actual_migration_generation_input():
    value = actual_target_input()
    original = read_package_files(value["originalFiles"])
    result = apply_migration(value["input"])
    planned = value["input"]["plannedSemanticDiff"]
    return {"id": planned["id"], "baseRevision": planned["baseRevision"], "targetRevision": planned["targetRevision"],
            "sourceSchemaLock": original["schemaLock"], "targetSchemaLock": value["targetSchemaLock"],
            "sourceSchemaLockDigest": planned["sourceSchemaLockDigest"], "targetSchemaLockDigest": planned["targetSchemaLockDigest"],
            "evaluatedAt": planned["evaluatedAt"], "baseElements": original["elements"], "targetElements": result["elements"]}


def package_comparisons():
    files = files_for([entity(1)])
    source = read_package_files(files)
    a = source["elements"][0]
    revised = seal({**a, "attributes": {**a["attributes"], "name": "revised"}})
    created = entity(2)
    value = frame([a], [revised, created], [operation("revise", a, revised), operation("create", after=created)], [revised, created])
    value["currentRevision"] = source["revision"]
    value["changeSet"]["baseRevision"] = source["revision"]["id"]
    value["resultingRevision"]["parentRevision"] = source["revision"]["id"]
    lock = source["calculatedSchemaLockDigest"]
    value["schemaLockDigest"] = value["changeSet"]["schemaLockDigest"] = value["resultingRevision"]["schemaLockDigest"] = lock
    result = apply_change_set(value)
    target = copy.deepcopy(source)
    target["elements"], target["revision"] = result["elements"], result["revision"]
    target["changeSets"].append(value["changeSet"])
    target = read_package_files(write_package_files(target))
    normal_input = {"id": identity(9020), "baseRevision": source["revision"]["id"], "targetRevision": target["revision"]["id"],
                    "schemaLockDigest": lock, "evaluatedAt": "2026-10-28T00:00:00Z", "baseElements": source["elements"], "targetElements": target["elements"]}
    normal_report = create_semantic_diff(normal_input)
    target["reports"].append(prepare_report(normal_report))
    comparisons = [{"migration": False, "originalFiles": files, "outputFiles": write_package_files(target), "input": normal_input, "report": normal_report}]
    migrated = actual_target_input()
    migrated_input = actual_migration_generation_input()
    report = create_migration_semantic_diff(migrated_input)
    migrated["input"]["plannedSemanticDiff"] = report
    migrated["input"]["migration"]["plannedSemanticDiffDigest"] = digest("migration-semantic-diff", report)["digest"]
    result = apply_migration(migrated["input"])
    target = read_package_files(migrated["originalFiles"])
    target["schemaLock"], target["schemaSources"] = migrated["targetSchemaLock"], migrated["targetSchemaSources"]
    target["elements"], target["revision"] = result["elements"], result["revision"]
    target["changeSets"].append(migrated["input"]["changeSet"])
    target["migrations"].append(migrated["input"]["migration"])
    target["reports"].append(prepare_report(report))
    comparisons.append({"migration": True, "originalFiles": migrated["originalFiles"], "outputFiles": write_package_files(target), "input": migrated_input, "report": report})
    return comparisons


def cases():
    normal, migrated = golden_inputs()
    out = [{"name": "normal-golden", "migration": False, "input": normal, "accepted": True},
           {"name": "migration-golden", "migration": True, "input": migrated, "accepted": True},
           {"name": "actual-migration-graph", "migration": True, "input": actual_migration_generation_input(), "accepted": True}]

    def add(name, changes, accepted=True, migrates=False, refresh=False, base=None):
        value = copy.deepcopy(base if base is not None else migration() if migrates else ordinary())
        changes(value)
        if refresh:
            reseal(value)
        out.append({"name": name, "migration": migrates, "input": value, "accepted": accepted})

    a, b, edge = projection(1), projection(2), projection(3, "relation")
    for name, before, after in [
        ("empty", [], []), ("entity-added", [], [a]), ("entity-retired", [a], []),
        ("entity-revised", [a], [projection(1, revision="b")]), ("relation-added", [], [edge]),
        ("relation-retired", [edge], []), ("relation-revised", [edge], [projection(3, "relation", "b")]),
        ("kind-change", [a], [projection(1, "relation", "b")]),
        ("same-revision-declaration", [a], [projection(1, "relation")]),
        ("input-order", [edge, b, a], [projection(2, revision="b"), projection(4), projection(3, "relation", "b")]),
    ]:
        add(name, lambda v, x=before, y=after: v.update(baseElements=x, targetElements=y))
    add("same-graph-id", lambda v: v.update(targetRevision=v["baseRevision"]))
    add("optional-id", lambda v: v.update(id=identity(9000)))
    add("equivalent-time-offset", lambda v: v.update(evaluatedAt="2026-10-28T09:00:00+09:00"))
    add("unicode-graph-id", lambda v: v.update(baseRevision="graph:e\u0301", targetRevision="graph:é"))
    add("ecma-nel-id", lambda v: v.update(baseRevision="graph:allowed\u0085"))
    for query in QUERIES:
        for before in STATUSES:
            for after in STATUSES:
                add("trace-" + query + "-" + before + "-" + after,
                    lambda v, q=query, x=before, y=after: v.update(traceChanges=[{"targetId": a["id"], "queryId": q, "beforeStatus": x, "afterStatus": y}]))
    for field in ("baseRevision", "targetRevision", "schemaLockDigest", "evaluatedAt", "id"):
        for invalid in (None, False, [], "bad"):
            add(field + "-" + repr(invalid), lambda v, f=field, x=invalid: v.update({f: x}), False)
    add("bad-calendar-time", lambda v: v.update(evaluatedAt="2026-02-30T00:00:00Z"), False)
    add("bad-time-zone", lambda v: v.update(evaluatedAt="2026-10-28T00:00:00+14:01"), False)
    add("graph-space", lambda v: v.update(baseRevision="graph:bad space"), False)
    for field in ("baseElements", "targetElements", "traceChanges"):
        for invalid in (None, {}, False, "bad"):
            add(field + "-" + repr(invalid), lambda v, f=field, x=invalid: v.update({f: x}), False)
    for field in ("baseElements", "targetElements"):
        for invalid in (None, [], False, "bad", {}, {**a, "id": "bad"}, {**a, "kind": []}, {**a, "revision": False}):
            add(field + "-entry-" + repr(invalid), lambda v, f=field, x=invalid: v.update({f: [x]}), False)
        add(field + "-duplicate", lambda v, f=field: v.update({f: [a, a]}), False)
    trace = {"targetId": a["id"], "queryId": QUERIES[0], "beforeStatus": "partial", "afterStatus": "complete"}
    for invalid in (None, [], False, {}, {**trace, "targetId": "bad"}, {**trace, "queryId": []}, {**trace, "beforeStatus": "bad"}, {**trace, "afterStatus": False}):
        add("trace-entry-" + repr(invalid), lambda v, x=invalid: v.update(traceChanges=[x]), False)
    add("trace-duplicate", lambda v: v.update(traceChanges=[trace, {**trace, "beforeStatus": "stale"}]), False)
    add("trace-no-change-duplicates", lambda v: v.update(traceChanges=[{**trace, "beforeStatus": "complete"}] * 2))
    for side in ("source", "target"):
        for invalid in (None, [], False, {}, "bad"):
            add(side + "-lock-" + repr(invalid), lambda v, s=side, x=invalid: v.update({s + "SchemaLock": x}), False, True)
            add(side + "-lock-resealed-" + repr(invalid), lambda v, s=side, x=invalid: v.update({s + "SchemaLock": x}), False, True, True)
        add(side + "-lock-missing", lambda v, s=side: v.pop(s + "SchemaLock"), False, True)
        add(side + "-digest-wrong", lambda v, s=side: v.update({s + "SchemaLockDigest": "sha256:" + "0" * 64}), False, True)
        for invalid in (None, {}, [False], [{}], [{"schemaId": ""}], [{"schemaId": False}], [{"schemaId": "é"}, {"schemaId": "e\u0301"}]):
            add(side + "-schema-entries-" + repr(invalid), lambda v, s=side, x=invalid: v[s + "SchemaLock"].update(schemas=x), False, True, True)
    add("same-lock", lambda v: v.update(targetSchemaLock=copy.deepcopy(v["sourceSchemaLock"])), False, True, True)
    add("metadata-only-lock-change", lambda v: v.update(targetSchemaLock={**copy.deepcopy(v["sourceSchemaLock"]), "stableIdScheme": "other"}), False, True, True)
    extra = {"schemaId": "example.extra", "version": "0.1", "digest": "sha256:" + "e" * 64}
    add("schema-added", lambda v: v["targetSchemaLock"]["schemas"].append(extra), True, True, True)
    add("schema-removed", lambda v: v["targetSchemaLock"].update(schemas=[]), True, True, True)
    add("schema-added-from-empty", lambda v: v["sourceSchemaLock"].update(schemas=[]), True, True, True)
    add("schema-digest-changed", lambda v: v["targetSchemaLock"]["schemas"][0].update(digest="sha256:" + "b" * 64), True, True, True)
    add("migration-trace-change", lambda v: v.update(traceChanges=[trace]), True, True)
    for invalid in (None, [], False):
        out.append({"name": "input-" + repr(invalid), "migration": False, "input": invalid, "accepted": False})
        out.append({"name": "migration-input-" + repr(invalid), "migration": True, "input": invalid, "accepted": False})
    return out


def generate(case):
    return (create_migration_semantic_diff if case["migration"] else create_semantic_diff)(case["input"])


class SemanticDiffGenerationTests(unittest.TestCase):
    def test_golden_reports_and_digests(self):
        normal, migrated = golden_inputs()
        self.assertEqual(create_semantic_diff(normal), NORMAL)
        self.assertEqual(create_migration_semantic_diff(migrated), MIGRATION)
        self.assertEqual(digest("semantic-diff", NORMAL)["digest"], "sha256:8d05635012d207209a197cb68cface531db5f2970e5e4ce4f60ae35f2b25d66b")
        self.assertEqual(digest("migration-semantic-diff", MIGRATION)["digest"], "sha256:58cd060db029a17b8095c8fd8b8d55841792004a565ebebe4976993ada791090")

    def test_corpus_acceptance_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["input"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    generate(case)
                else:
                    with self.assertRaises(ValueError):
                        generate(case)
                self.assertEqual(case["input"], before)

    def test_generated_reports_round_trip_with_normalized_logical_values(self):
        for case in cases():
            if case["accepted"]:
                report = generate(case)
                checked = read_report_source(serialize_report_yaml(report))
                self.assertEqual(canonical_json(checked["report"]), canonical_json(report), case["name"])
                self.assertEqual(checked["digest"], digest(checked["type"], report)["digest"])

    def test_diagnostics_point_to_projection_trace_and_schema_failures(self):
        expected = {"baseElements-duplicate": ("SEMANTIC_DIFF_INPUT_INVALID", "/baseElements/1/id"),
                    "trace-duplicate": ("SEMANTIC_DIFF_ENTRY_DUPLICATE", "/entries/1"),
                    "source-digest-wrong": ("SCHEMA_LOCK_CONFLICT", "/sourceSchemaLockDigest"),
                    "metadata-only-lock-change": ("SEMANTIC_DIFF_INPUT_INVALID", "/targetSchemaLock/schemas")}
        for case in cases():
            if case["name"] in expected:
                with self.assertRaises(ValidationError) as caught:
                    generate(case)
                self.assertEqual((caught.exception.code, caught.exception.path), expected[case["name"]])

    def test_unchanged_trace_statuses_are_omitted_and_duplicate_changes_rejected(self):
        for status in STATUSES:
            value = ordinary()
            value["traceChanges"] = [{"targetId": identity(1), "queryId": QUERIES[0], "beforeStatus": status, "afterStatus": status}]
            self.assertEqual(create_semantic_diff(value)["entries"], [])

    def test_output_is_detached_and_declared_revisions_are_not_authenticated(self):
        case = next(case for case in cases() if case["name"] == "same-revision-declaration")
        self.assertEqual(generate(case)["entries"], [])
        value = golden_inputs()[0]
        before = copy.deepcopy(value)
        report = create_semantic_diff(value)
        report["entries"][0]["targetId"] = identity(999)
        self.assertEqual(value, before)
        self.assertNotIn("valid", report)

    def test_generated_plan_matches_actual_migration_example(self):
        generated = create_migration_semantic_diff(actual_migration_generation_input())
        self.assertEqual(generated, actual_target_input()["input"]["plannedSemanticDiff"])
        for value in package_comparisons():
            self.assertTrue(validate_package_files(value["originalFiles"])["valid"])
            self.assertTrue(validate_package_files(value["outputFiles"])["valid"])


if __name__ == "__main__":
    unittest.main()
