import copy
import json
import unittest

from package_records import read_package_files
from report_records import read_report_source
from schema_registry import resolve_schema_registry
from schema_validation import ValidationError
from test_package_records import inputs
from test_schema_registry import LOCK, NAME, SOURCE
from yaml_authoring import ROOT_ORDERS, read_authoring_yaml
from yaml_records import read_yaml


def emit(value, indent=0):
    prefix = " " * indent
    if type(value) is dict and value:
        lines = []
        for key, entry in value.items():
            key = json.dumps(key, ensure_ascii=False)
            if type(entry) in (dict, list) and entry:
                lines.append(prefix + key + ":")
                lines.extend(emit(entry, indent + 2))
            else:
                lines.append(prefix + key + ": " + json.dumps(entry, ensure_ascii=False))
        return lines
    if type(value) is list and value:
        lines = []
        for entry in value:
            nested = emit(entry, indent + 2)
            lines.append(prefix + "- " + nested[0][indent + 2:])
            lines.extend(nested[1:])
        return lines
    return [prefix + json.dumps(value, ensure_ascii=False)]


def yaml(value):
    return "\n".join(emit(value)) + "\n"


def cases():
    out = []

    def add(name, value, code=None, path=None):
        out.append({"name": name, "source": yaml(value), "accepted": code is None, "code": code, "path": path})

    for format_id, order in ROOT_ORDERS.items():
        record = {key: format_id if key == "format" else "v" for key in order}
        add(format_id + "-ascending", record)
        # Cross-runtime tests compare every neighboring inversion with the
        # product's independently supplied order, not this table alone.
        for index in range(len(order) - 1):
            keys = order[:]
            keys[index:index + 2] = reversed(keys[index:index + 2])
            add(format_id + "-root-" + str(index), {key: record[key] for key in keys},
                "PACKAGE_AUTHORING_ORDER_INVALID", "/" + order[index])
    nested = [
        ("morivyx.git-graph/0.1", "attributes", "alpha beta", False),
        ("morivyx.git-graph/0.1", "provenance", "method actor recordedAt alpha beta", False),
        ("morivyx.schema-lock/0.1", "schemas", "schemaId version digest", True),
        ("morivyx.changeset/0.1", "operations", "op targetId beforeRevision afterRevision replacementId", True),
        ("morivyx.changeset/0.1", "provenance", "method actor recordedAt alpha beta", False),
        ("morivyx.migration/0.1", "provenance", "method actor recordedAt alpha beta", False),
        ("morivyx.semantic-diff/0.1", "entries", "kind targetId beforeRevision afterRevision replacementId aspect queryId beforeStatus afterStatus", True),
        ("morivyx.migration-semantic-diff/0.1", "entries", "kind targetId beforeRevision afterRevision replacementId aspect queryId beforeStatus afterStatus", True),
        ("morivyx.external-artifact-report/0.1", "artifact", "id revision lifecycle", False),
        ("morivyx.external-artifact-report/0.1", "externalSource", "id revision lifecycle", False),
        ("morivyx.external-artifact-report/0.1", "relation", "id revision lifecycle", False),
        ("morivyx.external-artifact-report/0.1", "retrieval", "status comparedAt digest digestRule externalVersion method reason", False),
        ("morivyx.schema/0.1", "entityTypes", "typeId requiredAttributes optionalAttributes lifecycle", True),
        ("morivyx.schema/0.1", "relationTypes", "predicate sourceTypes targetTypes minCount maxCount cycle", True),
        ("morivyx.schema/0.1", "authoringOrders", "root attributes provenance", False),
        ("morivyx.decision-creation-request/0.1", "attributes", "alpha beta", False),
        ("morivyx.decision-revision-request/0.1", "attributes", "alpha beta", False),
    ]
    for format_id, key, words, sequence in nested:
        keys = words.split()
        for index in range(-1, len(keys) - 1):
            order = keys[:]
            if index >= 0:
                order[index:index + 2] = reversed(order[index:index + 2])
            entry = {field: "v" for field in order}
            add(format_id + "-" + key + "-" + str(index), {"format": format_id, key: [entry] if sequence else entry},
                "PACKAGE_AUTHORING_ORDER_INVALID" if index >= 0 else None,
                "/" + key + ("/0" if sequence else "") + "/" + keys[index] if index >= 0 else None)
    graph = "morivyx.git-graph/0.1"
    trace = "morivyx.trace-report/0.1"
    schema = "morivyx.schema/0.1"
    external = "morivyx.external-artifact-report/0.1"
    for source, accepted in [({"a": [{"é": "v", "\ue000": "x", "\U00010000": "y"}]}, True),
                             ({"a": [{"\U00010000": "y", "\ue000": "x"}]}, False)]:
        add("extensions-unicode-" + str(accepted), {"format": graph, "extensions": source},
            None if accepted else "PACKAGE_AUTHORING_ORDER_INVALID", None if accepted else "/extensions/a/0/\ue000")
    add("extensions-pointer", {"format": graph, "extensions": {"a/b~c": {"z": 0, "a": 1}}}, "PACKAGE_AUTHORING_ORDER_INVALID", "/extensions/a~1b~0c/a")
    add("extensions-list-order-preserved", {"format": graph, "extensions": {"x": ["z", "a", "a"]}})
    add("attribute-child-map-not-sorted-by-profile", {"format": graph, "attributes": {"x": {"z": 1, "a": 2}}})
    add("known-root-unknown-keys-not-reordered", {"z": 1, "format": graph, "a": 2, "kind": "entity"})
    add("provenance-known-after-extra", {"format": graph, "provenance": {"alpha": "a", "actor": "v"}}, "PACKAGE_AUTHORING_ORDER_INVALID", "/provenance/actor")
    for field in ("artifact", "externalSource", "relation"):
        for key in ("id", "revision", "lifecycle"):
            value = {"format": external, field: {key: None}, "status": "invalid"}
            allowed = key != "lifecycle" or field == "artifact"
            add("null-identity-" + field + "-" + key, value, None if allowed else "PACKAGE_NULL_INVALID", None if allowed else "/" + field + "/" + key)
    for key in "status comparedAt digest digestRule externalVersion method reason".split():
        add("null-retrieval-" + key, {"format": external, "retrieval": {key: None}, "status": "invalid"})
    for key in ("graphRevision", "retrieval", "comparedAt"):
        add("null-external-" + key, {"format": external, key: None, "status": "invalid"})
    add("null-parent", {"format": "morivyx.graph-revision/0.1", "parentRevision": None})
    add("null-schema-count", {"format": schema, "relationTypes": [{"maxCount": None}]})
    add("null-extension", {"format": graph, "extensions": {"a": [None]}})
    add("null-extension-root", {"format": graph, "extensions": None}, "PACKAGE_NULL_INVALID", "/extensions")
    add("null-attribute", {"format": graph, "attributes": {"a": None}}, "PACKAGE_NULL_INVALID", "/attributes/a")
    add("null-external-current", {"format": external, "graphRevision": None, "status": "current"}, "PACKAGE_NULL_INVALID", "/graphRevision")
    add("null-unknown-format", {"format": "unknown", "z": None, "a": None})
    for missing in ([], ["a"], ["a", "z"], ["z", "a"], ["a", "a"], ["e\u0301", "é"], ["\ue000", "\U00010000"], ["\U00010000", "\ue000"], ["a", False, "z"]):
        strings = [v for v in missing if type(v) is str]
        normalized = [v.replace("e\u0301", "é") for v in strings]
        accepted = all(a < b for a, b in zip(normalized, normalized[1:]))
        bad = next((i for i in range(1, len(normalized)) if normalized[i - 1] >= normalized[i]), None)
        add("missing-" + repr(missing), {"format": trace, "missing": missing}, None if accepted else "PACKAGE_SET_ORDER_INVALID", None if accepted else "/missing/" + str(bad))
    for key, identity, sets in [("entityTypes", "typeId", ("requiredAttributes", "optionalAttributes", "lifecycle")),
                                ("relationTypes", "predicate", ("sourceTypes", "targetTypes"))]:
        add("schema-map-set-" + key, {"format": schema, key: [{identity: "z"}, {identity: "a"}]}, "PACKAGE_SET_ORDER_INVALID", "/" + key + "/1/" + identity)
        for field in sets:
            add("schema-nested-set-" + field, {"format": schema, key: [{identity: "a", field: ["z", "a"]}]}, "PACKAGE_SET_ORDER_INVALID", "/" + key + "/0/" + field + "/1")
    add("review-state-set", {"format": schema, "reviewStates": ["z", "a"]}, "PACKAGE_SET_ORDER_INVALID", "/reviewStates/1")
    add("trace-hop-order", {"format": trace, "paths": [{"hops": [{"fromId": "a", "fromRevision": "b", "toId": "c"}]}]}, "PACKAGE_AUTHORING_ORDER_INVALID", "/paths/0/hops/0/toId")
    add("trace-path-order-unknown-ignored", {"format": trace, "paths": [{"extra": "v", "hops": []}]})
    add("schema-root-authoring-list-is-sequence", {"format": schema, "authoringOrders": {"root": ["z", "a"]}})
    return out


class YamlAuthoringTests(unittest.TestCase):
    def test_corpus_and_diagnostics(self):
        for case in cases():
            before = case["source"]
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    read_authoring_yaml(case["source"])
                else:
                    with self.assertRaises(ValidationError) as caught:
                        read_authoring_yaml(case["source"])
                    self.assertEqual((caught.exception.code, caught.exception.path), (case["code"], case["path"]))
                self.assertEqual(case["source"], before)

    def test_syntax_reader_still_preserves_out_of_order_fields(self):
        source = 'id: "x"\nformat: "morivyx.graph-revision/0.1"\n'
        self.assertEqual(list(read_yaml(source)), ["id", "format"])
        with self.assertRaises(ValidationError):
            read_authoring_yaml(source)

    def test_package_rejects_order_without_changing_logical_digest(self):
        files = inputs()
        lines = files["revision.yaml"].decode().splitlines(True)
        files["revision.yaml"] = "".join([lines[1], lines[0], *lines[2:]])
        before = copy.deepcopy(files)
        with self.assertRaises(ValidationError) as caught:
            read_package_files(files)
        self.assertEqual(caught.exception.path, "/format")
        self.assertEqual(files, before)

    def test_registry_preserves_bad_source_and_reports_conflict(self):
        lines = SOURCE.splitlines(True)
        source = "".join([lines[1], lines[0], *lines[2:]])
        files = {**inputs(), "schemas/" + NAME: source}
        package = read_package_files(files)
        self.assertEqual(package["schemaSources"][NAME], source)
        self.assertTrue(package["validation"]["recordAuthoringValidated"])
        self.assertFalse(package["validation"]["schemaValidated"])
        self.assertEqual(resolve_schema_registry(LOCK, package["schemaSources"])["issues"][0]["code"], "SCHEMA_LOCK_CONFLICT")

    def test_standalone_report_checks_authoring_before_structure(self):
        with self.assertRaises(ValidationError) as caught:
            read_report_source('id: "x"\nformat: "morivyx.trace-report/0.1"\n')
        self.assertEqual(caught.exception.code, "PACKAGE_AUTHORING_ORDER_INVALID")

    def test_unknown_format_and_incomplete_records_are_not_semantic_verdicts(self):
        self.assertEqual(read_authoring_yaml('format: "unknown"\nx: null\n'), {"format": "unknown", "x": None})
        self.assertEqual(read_authoring_yaml('format: "morivyx.approval/0.1"\n'), {"format": "morivyx.approval/0.1"})

    def test_bounded_syntax_rejections_still_apply(self):
        for source in (b"\xff\n", "x: null", "x: [1]\n", "x: 01\n", "x: \"a\" # comment\n", "x: \"a\"\r\n", "x: &value \"a\"\n"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                read_authoring_yaml(source)


if __name__ == "__main__":
    unittest.main()
