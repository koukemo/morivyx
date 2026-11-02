import copy
from contextlib import redirect_stderr
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import package_migration

from canonical import digest
from package_migration import PackageMigrationError, plan_package_migration
from package_records import read_package_files
from package_validation import validate_package_files
from semantic_diff import create_migration_semantic_diff
from test_changeset_apply import operation
from test_graph_validation import entity, identity, seal
from test_migration_apply import actual_target_input
from test_package_core_validation import files_for
from test_yaml_authoring import yaml
from yaml_records import read_yaml, write_yaml


def request():
    value = actual_target_input()
    result = {k: value["input"][k] for k in ("migration", "changeSet", "plannedSemanticDiff", "candidateElements", "resultingRevision")}
    result.update(sourceFiles=value["originalFiles"], targetSchemaLock=value["targetSchemaLock"], targetSchemaSources=value["targetSchemaSources"])
    return result


def replan(value, elements):
    source = read_package_files(value["sourceFiles"])
    target = digest("schema-lock", value["targetSchemaLock"])["digest"]
    root = digest("root", elements)["digest"]
    value["changeSet"].update(baseRevision=source["revision"]["id"], schemaLockDigest=target, resultingRootDigest=root)
    value["resultingRevision"].update(parentRevision=source["revision"]["id"], schemaLockDigest=target, rootDigest=root)
    value["migration"].update(baseRevision=source["revision"]["id"], sourceSchemaLockDigest=source["calculatedSchemaLockDigest"],
                              targetSchemaLockDigest=target, resultingRootDigest=root)
    value["plannedSemanticDiff"] = create_migration_semantic_diff({
        "id": value["plannedSemanticDiff"]["id"], "evaluatedAt": value["plannedSemanticDiff"]["evaluatedAt"],
        "baseRevision": source["revision"]["id"], "targetRevision": value["resultingRevision"]["id"],
        "sourceSchemaLock": source["schemaLock"], "targetSchemaLock": value["targetSchemaLock"],
        "sourceSchemaLockDigest": source["calculatedSchemaLockDigest"], "targetSchemaLockDigest": target,
        "baseElements": source["elements"], "targetElements": elements})
    value["migration"]["plannedSemanticDiffDigest"] = digest("migration-semantic-diff", value["plannedSemanticDiff"])["digest"]


def extension_request():
    value = request()
    base = read_package_files(value["sourceFiles"])
    before = seal({**base["elements"][0], "extensions": {"example/retained": {"nested": ["unknown", False, {"value": "kept"}]}}})
    after = seal({**value["candidateElements"][0], "extensions": copy.deepcopy(before["extensions"])})
    value["sourceFiles"] = files_for([before])
    value["candidateElements"][0] = after
    value["changeSet"]["operations"][0] = operation("revise", before, after)
    replan(value, value["candidateElements"])
    return value


def learning_request(lifecycle):
    value = request()
    before = entity(1, "core.learning", lifecycle="active")
    after = seal({**before, "typeVersion": "0.2", "lifecycle": lifecycle})
    value["sourceFiles"] = files_for([before])
    value["candidateElements"] = [after]
    value["changeSet"]["operations"] = [operation("revise", before, after)]
    replan(value, [after])
    return value


def cases():
    out = []

    def add(name, value=None, mutate=None, error=None, path="/"):
        value = request() if value is None else copy.deepcopy(value)
        if mutate:
            mutate(value)
        out.append({"name": name, "input": value, "expected": {"accepted": True} if error is None else {
            "accepted": False, "error": {"code": "PACKAGE_MIGRATION_" + error, "path": path}}})

    add("synthetic-schema-0.1-to-0.2")
    add("unknown-extension-retained", extension_request())
    pending = request()
    for directory, record in [("migrations", pending["migration"]), ("ledger", pending["changeSet"]), ("reports", pending["plannedSemanticDiff"])]:
        pending["sourceFiles"][directory + "/" + record["id"][9:] + ".yaml"] = write_yaml(record)
    add("already-stored-identical-plan", pending)
    p = next(p for p in pending["sourceFiles"] if p.startswith("reports/"))
    pending["sourceFiles"]["reports/retained-alias.yaml"] = pending["sourceFiles"].pop(p)
    add("already-stored-report-alias", pending)
    retired = request()
    before = read_package_files(retired["sourceFiles"])["elements"][0]
    retired["candidateElements"] = []
    retired["changeSet"]["operations"] = [operation("retire", before)]
    replan(retired, [])
    add("explicit-retirement", retired)
    add("allowed-learning-transition", learning_request("superseded"))
    add("forbidden-learning-transition", learning_request("draft"), error="TARGET_INVALID", path="/targetSchemaSources")
    for field, replacement in [("targetValidation", {"valid": True, "issues": []}), ("currentElements", []), ("currentRevision", {}), ("secret-field", "never echo")]:
        add("untrusted-declaration-" + field, mutate=lambda v, f=field, r=replacement: v.update({f: r}), error="INPUT_INVALID")
    for field in request():
        add("missing-" + field, mutate=lambda v, f=field: v.pop(f), error="INPUT_INVALID")
    for name, mutate in [
        ("missing-source-schema", lambda v: v["sourceFiles"].pop("schemas/morivyx.core@0.1.yaml")),
        ("source-revision", lambda v: v["sourceFiles"].update({"revision.yaml": "bad"})),
        ("source-path", lambda v: v["sourceFiles"].update({"../secret": "never echo"})),
        ("source-surrogate-key", lambda v: v["sourceFiles"].update({"reports/\ud800.yaml": "bad"})),
        ("source-surrogate-value", lambda v: v["sourceFiles"].update({"revision.yaml": "\ud800"})),
    ]:
        add(name, mutate=mutate, error="SOURCE_INVALID", path="/sourceFiles")
    for name, mutate, path in [
        ("missing-target-schema", lambda v: v.update(targetSchemaSources={}), "/targetSchemaSources"),
        ("modified-target-schema", lambda v: v["targetSchemaSources"].update({"morivyx.core@0.2.yaml": "bad"}), "/targetSchemaSources"),
        ("extra-target-schema", lambda v: v["targetSchemaSources"].update({"extra.yaml": "bad"}), "/targetSchemaSources"),
        ("bad-target-lock", lambda v: v.update(targetSchemaLock={}), "/targetSchemaLock"),
    ]:
        add(name, mutate=mutate, error="TARGET_SCHEMA_INVALID", path=path)
    add("source-binding", mutate=lambda v: v["migration"].update(sourceSchemaLockDigest="sha256:" + "0"*64), error="SOURCE_BINDING_INVALID", path="/migration")
    add("target-binding", mutate=lambda v: v["targetSchemaLock"]["schemas"][0].update(version="0.3"), error="TARGET_SCHEMA_INVALID", path="/targetSchemaSources")
    add("legacy-report-format", mutate=lambda v: v["plannedSemanticDiff"].update(format="morivyx.semantic-diff/0.1"), error="PLAN_INVALID", path="/plannedSemanticDiff")
    add("report-without-id", mutate=lambda v: v["plannedSemanticDiff"].pop("id"), error="PLAN_INVALID", path="/plannedSemanticDiff")
    add("report-digest-mismatch", mutate=lambda v: v["migration"].update(plannedSemanticDiffDigest="sha256:" + "0"*64), error="PLAN_INVALID", path="/plannedSemanticDiff")
    altered = request()
    altered["plannedSemanticDiff"]["entries"] = [e for e in altered["plannedSemanticDiff"]["entries"] if e["kind"] != "entity_added"]
    altered["migration"]["plannedSemanticDiffDigest"] = digest("migration-semantic-diff", altered["plannedSemanticDiff"])["digest"]
    add("resealed-incomplete-plan", altered, error="PLAN_MISMATCH", path="/plannedSemanticDiff")
    add("missing-candidates", mutate=lambda v: v.update(candidateElements=[]), error="APPLICATION_INVALID", path="/changeSet")
    add("bad-candidate-digest", mutate=lambda v: v["candidateElements"][0].update(revision="sha256:" + "0"*64), error="APPLICATION_INVALID", path="/changeSet")
    add("bad-result-root", mutate=lambda v: v["resultingRevision"].update(rootDigest="sha256:" + "0"*64), error="APPLICATION_INVALID", path="/changeSet")
    conflict = copy.deepcopy(pending)
    path = next(p for p in conflict["sourceFiles"] if p.startswith("migrations/"))
    record = read_yaml(conflict["sourceFiles"][path]);record["rulesDigest"] = "sha256:" + "0"*64
    conflict["sourceFiles"][path] = write_yaml(record)
    add("existing-plan-conflict", conflict, error="RECORD_CONFLICT", path="/migration")
    invalid_schema = request()
    definition = read_yaml(invalid_schema["targetSchemaSources"]["morivyx.core@0.2.yaml"])
    actor = next(e for e in definition["entityTypes"] if e["typeId"] == "core.actor")
    actor["requiredAttributes"] = sorted([*actor["requiredAttributes"], "mustExist"])
    invalid_schema["targetSchemaSources"]["morivyx.core@0.2.yaml"] = yaml(definition)
    invalid_schema["targetSchemaLock"]["schemas"][0]["digest"] = digest("schema", definition)["digest"]
    replan(invalid_schema, invalid_schema["candidateElements"])
    add("actual-target-schema-fails", invalid_schema, error="TARGET_INVALID", path="/targetSchemaSources")
    immutable = request()
    definition = read_yaml(immutable["targetSchemaSources"].pop("morivyx.core@0.2.yaml"))
    definition["version"] = "0.1"
    next(e for e in definition["entityTypes"] if e["typeId"] == "core.actor")["optionalAttributes"] = ["compatibilityMarker"]
    immutable["targetSchemaSources"]["morivyx.core@0.1.yaml"] = yaml(definition)
    immutable["targetSchemaLock"]["schemas"][0].update(version="0.1", digest=digest("schema", definition)["digest"])
    for candidate in immutable["candidateElements"]:
        candidate["typeVersion"] = "0.1";seal(candidate)
    for op in immutable["changeSet"]["operations"]:
        op["afterRevision"] = next(e["revision"] for e in immutable["candidateElements"] if e["id"] == op["targetId"])
    replan(immutable, immutable["candidateElements"])
    add("same-schema-version-with-different-content", immutable, error="TARGET_SCHEMA_INVALID", path="/targetSchemaLock")
    for name, transform in [("dropped-extension", lambda r: r.pop("extensions")),
                             ("changed-extension-order", lambda r: r["extensions"]["example/retained"]["nested"].reverse())]:
        value = extension_request();after = value["candidateElements"][0];transform(after);seal(after)
        value["changeSet"]["operations"][0]["afterRevision"] = after["revision"]
        replan(value, value["candidateElements"])
        add(name, value, error="EXTENSION_LOSS", path="/candidateElements")
    replay = request();replay["sourceFiles"] = plan_package_migration(replay)["files"]
    add("already-applied-plan", replay, error="SOURCE_BINDING_INVALID", path="/migration")
    return out


class PackageMigrationTests(unittest.TestCase):
    def test_corpus_and_input_ownership(self):
        for case in cases():
            with self.subTest(case=case["name"]):
                before = copy.deepcopy(case["input"])
                if case["expected"]["accepted"]:
                    result = plan_package_migration(case["input"])
                    self.assertTrue(validate_package_files(result["files"], previous_files=case["input"]["sourceFiles"])["valid"])
                    result["files"].clear();result["checks"]["signaturesValidated"] = True
                else:
                    with self.assertRaises(PackageMigrationError) as error:
                        plan_package_migration(case["input"])
                    self.assertEqual({"accepted": False, "error": {"code": error.exception.code, "path": error.exception.path}}, case["expected"])
                self.assertEqual(case["input"], before)

    def test_extension_values_and_original_input_remain(self):
        value = extension_request();result = plan_package_migration(value)
        original = read_package_files(value["sourceFiles"])["elements"][0]
        revised = next(e for e in read_package_files(result["files"])["elements"] if e["id"] == original["id"])
        self.assertEqual(revised["extensions"], original["extensions"])
        self.assertTrue(result["checks"]["plannedDiffRecalculated"])
        self.assertFalse(result["checks"]["adoptionAuthorityValidated"])

    def test_cli_uses_strict_bounded_json_and_static_errors(self):
        command = [sys.executable, "-B", str(Path(__file__).with_name("package_migration.py"))]
        result = subprocess.run(command, input=json.dumps(request()), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr);self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), plan_package_migration(request()))
        for args, raw, code in [([], b'{"secret":"never echo"}', "INPUT_INVALID"),
                                (["secret-argument"], b"{}", "INPUT_INVALID"),
                                ([], b'{"sourceFiles":{},"sourceFiles":{}}', "INPUT_INVALID"),
                                ([], b" " * (8*1024*1024+1), "LIMIT_EXCEEDED")]:
            result = subprocess.run([*command, *args], input=raw, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1);self.assertEqual(result.stdout, b"")
            self.assertEqual(json.loads(result.stderr), {"error": {"code": "PACKAGE_MIGRATION_" + code, "path": "/"}})
        diagnostic = StringIO()
        with patch.object(package_migration, "read_request_bytes", side_effect=OSError("secret stream failure")), redirect_stderr(diagnostic):
            self.assertEqual(package_migration.main([]), 1)
        self.assertEqual(json.loads(diagnostic.getvalue()), {"error": {"code": "PACKAGE_MIGRATION_INPUT_INVALID", "path": "/"}})


if __name__ == "__main__":
    unittest.main()
