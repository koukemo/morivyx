import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from canonical import digest
from package_validation import validate_package, validate_package_files
from schema_validation import ValidationError
from test_graph_validation import SCHEMA, entity, extra_schema, identity, relation, seal
from test_package_validation import empty_files, refresh
from test_schema_registry import NAME, SOURCE
from test_yaml_authoring import yaml
from yaml_records import read_yaml, write_yaml


def files_for(elements, approvals=None, schemas=None):
    schemas = [(NAME, SOURCE)] if schemas is None else schemas
    definitions = [read_yaml(source) for _name, source in schemas]
    lock = {"format": "morivyx.schema-lock/0.1", "stableIdScheme": "urn-uuid-v4", "digestAlgorithm": "sha256",
            "schemas": sorted([{"schemaId": schema["schemaId"], "version": schema["version"], "digest": digest("schema", schema)["digest"]}
                               for schema in definitions], key=lambda value: (value["schemaId"], value["version"]))}
    files = empty_files("graph:package-validation")
    files["schema.lock.yaml"] = write_yaml(lock)
    for name, source in schemas:
        files["schemas/" + name] = source
    for element in elements:
        directory = "graph/entities/" if element["kind"] == "entity" else "graph/relations/"
        files[directory + element["id"][9:] + ".yaml"] = write_yaml(element)
    for approval in approvals or []:
        files["approvals/" + approval["id"][9:] + ".yaml"] = write_yaml(approval)
    refresh(files)
    return files


def grant(target, index=9000, **changes):
    value = {"format": "morivyx.approval/0.1", "id": identity(index), "actor": identity(1),
             "targetId": target["id"], "targetRevision": target["revision"], "operation": "approve", "scope": "single-revision",
             "approvedAt": "2026-10-27T00:00:00Z", "recordedAt": "2026-10-27T00:00:00Z"}
    return {**value, **changes}


def cases():
    a, b = entity(1), entity(2)
    out = []

    def add(name, elements=None, approvals=None, schemas=None):
        out.append({"name": name, "files": files_for([a] if elements is None else elements, approvals, schemas)})

    add("actor")
    add("empty-core", [])
    add("empty-lock-and-graph", [], schemas=[])
    for definition in SCHEMA["entityTypes"]:
        add("entity-type-" + definition["typeId"], [entity(1, definition["typeId"])])
    for name, changes in [("type-version", {"typeVersion": "9"}), ("unknown-type", {"type": "unknown.type"}),
                          ("missing-attributes", {"attributes": {}}), ("unknown-lifecycle", {"lifecycle": "unknown"})]:
        add(name, [entity(1, **changes)])
    add("relation-valid", [a, b, relation(3, a["id"], "depends_on", b["id"])])
    add("relation-missing-target", [a, relation(3, a["id"], "depends_on", b["id"])])
    add("relation-unknown-predicate", [a, b, relation(3, a["id"], "unknown", b["id"])])
    edge = relation(3, a["id"], "depends_on", b["id"])
    for field in ("source", "target", "predicate"):
        for value in ([], {}, False, 0):
            modified = copy.deepcopy(edge)
            modified["attributes"][field] = value
            add("relation-" + field + "-" + repr(value), [a, b, seal(modified)])
    add("relation-self-cycle", [a, relation(3, a["id"], "depends_on", a["id"])])
    add("relation-cycle", [a, b, edge, relation(4, b["id"], "depends_on", a["id"])])
    definitions = [(NAME, SOURCE), ("example.test@0.1.yaml", yaml(extra_schema()))]
    custom_edge = relation(3, a["id"], "link", b["id"], "example.link")
    add("multiple-schemas", [a, b, custom_edge], schemas=definitions)
    add("multiple-schemas-cycle", [a, b, custom_edge, relation(4, b["id"], "link", a["id"], "example.link")], schemas=definitions)
    target = entity(2, reviewState="approved")
    approval = grant(target)
    add("approval-missing", [a, target])
    add("approval-present", [a, target], [approval])
    add("approval-other-revision", [a, target], [grant(target, targetRevision="sha256:" + "0" * 64)])
    add("approval-revoked", [a, target], [approval, grant(target, 9001, operation="revoke", revokes=approval["id"])])
    decision = entity(2, "core.decision", lifecycle="accepted")
    add("decision-unjustified", [a, decision])
    add("decision-governing", [a, decision, relation(3, decision["id"], "governs", a["id"])])
    for name in ("missing", "malformed", "reordered", "different-version", "different-digest", "unlocked"):
        files = files_for([entity(1, type="unknown.type")])
        path = "schemas/" + NAME
        if name == "missing":
            del files[path]
        elif name == "malformed":
            files[path] = "bad: [\n"
        elif name == "reordered":
            lines = SOURCE.splitlines(True)
            files[path] = "".join([lines[1], lines[0], *lines[2:]])
        elif name == "different-version":
            files[path] = SOURCE.replace('version: "0.1"', 'version: "0.2"')
        elif name == "different-digest":
            files[path] = SOURCE.replace('"actorKind"', '"changedKind"')
        else:
            files["schemas/unlocked.yaml"] = SOURCE
        out.append({"name": "schema-" + name, "files": files})
    return out


class PackageCoreValidationTests(unittest.TestCase):
    def test_complete_corpus_preserves_inputs(self):
        for case in cases():
            before = copy.deepcopy(case["files"])
            with self.subTest(name=case["name"]):
                result = validate_package_files(case["files"])
                self.assertEqual(result["valid"], not result["issues"])
                self.assertEqual(case["files"], before)

    def test_schema_failures_suppress_later_graph_diagnostics_without_fallback(self):
        for case in cases():
            if not case["name"].startswith("schema-"):
                continue
            result = validate_package_files(case["files"])
            self.assertFalse(result["valid"])
            self.assertTrue(all(issue["phase"] == 2 for issue in result["issues"]))
            self.assertFalse(result["validation"]["schemaLockBindingValidated"])
            self.assertFalse(result["validation"]["graphConstraintsValidated"])

    def test_valid_empty_and_invalid_core_reports_are_distinct(self):
        outcomes = {case["name"]: validate_package_files(case["files"]) for case in cases()}
        for name in ("actor", "empty-core", "empty-lock-and-graph", "relation-valid", "approval-present"):
            self.assertTrue(outcomes[name]["valid"], name)
        for name in ("type-version", "unknown-type", "missing-attributes", "relation-missing-target", "approval-missing", "approval-revoked"):
            self.assertFalse(outcomes[name]["valid"], name)

    def test_malformed_preflight_fails_before_semantic_output(self):
        with self.assertRaises(ValidationError):
            validate_package_files(files_for([entity(1, reviewState="unknown")]))
        files = files_for([entity(1)])
        revision = read_yaml(files["revision.yaml"])
        files["revision.yaml"] = write_yaml({**revision, "rootDigest": "sha256:" + "0" * 64})
        with self.assertRaises(ValueError):
            validate_package_files(files)
        files = files_for([entity(1)])
        record = read_yaml(files["revision.yaml"])
        files["revision.yaml"] = write_yaml({**record, "parentRevision": record["id"]})
        with self.assertRaises(ValidationError):
            validate_package_files(files)

    def test_scoped_flags_do_not_claim_signature_authority_or_full_compatibility(self):
        result = validate_package_files(files_for([entity(1)]))
        self.assertEqual(result["validation"]["scope"], "package-records-schema-and-graph-constraints")
        for field, value in result["validation"].items():
            if field.endswith("Validated"):
                self.assertEqual(value, field not in ("approvalAuthorityValidated", "signaturesValidated", "packageValidated"), field)

    def test_disk_and_cli_return_reports_and_exit_status_without_source_changes(self):
        for case in [next(c for c in cases() if c["name"] == name) for name in ("actor", "type-version", "schema-missing")]:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                for name, source in case["files"].items():
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(source)
                result = validate_package(root)
                cli = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("package_validation.py")), str(root)], capture_output=True, text=True)
                self.assertEqual(cli.returncode, 0 if result["valid"] else 1)
                self.assertEqual(cli.stderr, "")
                self.assertEqual(json.loads(cli.stdout), result)
                for name, source in case["files"].items():
                    self.assertEqual((root / name).read_text(), source)


if __name__ == "__main__":
    unittest.main()
