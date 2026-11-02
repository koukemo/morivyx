import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from canonical import digest
from package_records import read_package_files, write_package_files
from schema_validation import ValidationError
from test_package_records import inputs
from yaml_records import read_yaml, write_yaml


NEW_ID = "urn:uuid:ffffffff-ffff-4fff-8fff-fffffffffff1"
OTHER_ID = "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


def base_files():
    return {path: source.decode("utf-8") for path, source in inputs().items()}


def refresh(files):
    elements = []
    for path in files:
        if path.startswith(("graph/entities/", "graph/relations/")):
            record = read_yaml(files[path])
            record["revision"] = digest("revision", record)["digest"]
            files[path] = write_yaml(record)
            elements.append(record)
    revision = read_yaml(files["revision.yaml"])
    revision["schemaLockDigest"] = digest("schema-lock", read_yaml(files["schema.lock.yaml"]))["digest"]
    revision["rootDigest"] = digest("root", elements)["digest"]
    files["revision.yaml"] = write_yaml(revision)


def empty_files(identity="graph:empty"):
    lock = {"format": "morivyx.schema-lock/0.1", "stableIdScheme": "urn-uuid-v4", "digestAlgorithm": "sha256", "schemas": []}
    revision = {"format": "morivyx.graph-revision/0.1", "id": identity, "parentRevision": None,
                "schemaLockDigest": digest("schema-lock", lock)["digest"], "rootDigest": digest("root", [])["digest"]}
    return {"schema.lock.yaml": write_yaml(lock), "revision.yaml": write_yaml(revision)}


def cases():
    base = base_files()
    entity = next(p for p in base if p.startswith("graph/entities/"))
    approval = next(p for p in base if p.startswith("approvals/"))
    change = next(p for p in base if p.startswith("ledger/"))
    migration = next(p for p in base if p.startswith("migrations/"))
    report = next(p for p in base if p.startswith("reports/"))
    result = [{"name": "base", "files": base, "accepted": True}]

    def add(name, path, transform, accepted=False, code=None):
        files = copy.deepcopy(base)
        files[path] = write_yaml(transform(read_yaml(files[path])))
        refresh(files)
        result.append({"name": name, "files": files, "accepted": accepted, "code": code})

    for name, value in [("empty", "graph:empty"), ("graph-nel", "graph:allowed\u0085"), ("graph-rs", "graph:allowed\u001c")]:
        result.append({"name": name, "files": empty_files(value), "accepted": True})
    add("core-version-unresolved", entity, lambda r: {**r, "typeVersion": "9"}, True)
    for filename in ("別名.yaml", ".yaml", "00000000-0000-4000-8000-000000000999.yaml"):
        files = copy.deepcopy(base)
        files["reports/" + filename] = files.pop(report)
        result.append({"name": "report-alias-" + filename, "files": files, "accepted": True})
    files = copy.deepcopy(base)
    files["reports/duplicate.yaml"] = files[report]
    result.append({"name": "report-duplicate-alias", "files": files, "accepted": False})

    add("header-lock-unknown", "schema.lock.yaml", lambda r: {**r, "extra": 1}, code="SCHEMA_LOCK_INVALID")
    add("header-lock-duplicate", "schema.lock.yaml", lambda r: {**r, "schemas": [*r["schemas"], r["schemas"][0]]}, code="SCHEMA_LOCK_ORDER_INVALID")
    add("header-lock-version", "schema.lock.yaml", lambda r: {**r, "schemas": [{**r["schemas"][0], "version": False}]}, code="SCHEMA_LOCK_INVALID")
    add("header-lock-digest", "schema.lock.yaml", lambda r: {**r, "schemas": [{**r["schemas"][0], "digest": "sha256:" + "A" * 64}]}, code="SCHEMA_LOCK_INVALID")
    add("header-self-parent", "revision.yaml", lambda r: {**r, "parentRevision": r["id"]}, code="GRAPH_REVISION_INVALID")
    add("header-graph-space", "revision.yaml", lambda r: {**r, "id": "graph:bad space"}, code="GRAPH_REVISION_INVALID")
    add("header-unknown", "revision.yaml", lambda r: {**r, "extra": 1}, code="GRAPH_REVISION_INVALID")
    for name, transform in [
        ("missing-provenance", lambda r: {k: v for k, v in r.items() if k != "provenance"}),
        ("actor", lambda r: {**r, "provenance": {**r["provenance"], "actor": False}}),
        ("review", lambda r: {**r, "reviewState": "unknown"}),
        ("attributes", lambda r: {**r, "attributes": []}),
        ("kind", lambda r: {**r, "kind": "unknown"}),
        ("type", lambda r: {**r, "type": ""}),
    ]:
        add("element-" + name, entity, transform, code="GRAPH_ELEMENT_INVALID")
    add("approval-operation", approval, lambda r: {**r, "operation": []}, code="APPROVAL_INVALID")
    add("approval-actor", approval, lambda r: {**r, "actor": False}, code="APPROVAL_INVALID")
    add("approval-time", approval, lambda r: {**r, "approvedAt": "not-time"}, code="APPROVAL_INVALID")
    grant = read_yaml(base[approval])
    revoke = {**grant, "id": NEW_ID, "operation": "revoke", "revokes": grant["id"]}
    for name, records in [
        ("missing", [{**revoke, "revokes": OTHER_ID}]),
        ("target", [{**revoke, "targetId": OTHER_ID}]),
        ("revocation", [revoke, {**revoke, "id": NEW_ID[:-1] + "2", "revokes": NEW_ID}]),
    ]:
        files = copy.deepcopy(base)
        for record in records:
            files["approvals/" + record["id"][9:] + ".yaml"] = write_yaml(record)
        result.append({"name": "ledger-" + name, "files": files, "accepted": False, "code": "APPROVAL_INVALID"})
    add("changeset-operation-array", change, lambda r: {**r, "operations": [{**r["operations"][0], "op": [r["operations"][0]["op"]]}]}, code="CHANGESET_INVALID")
    add("changeset-empty", change, lambda r: {**r, "operations": []}, code="CHANGESET_INVALID")
    add("changeset-actor", change, lambda r: {**r, "provenance": {**r["provenance"], "actor": False}}, code="CHANGESET_INVALID")
    add("migration-missing", migration, lambda r: {**r, "changeSetId": OTHER_ID}, code="MIGRATION_CHANGESET_MISSING")
    add("migration-root", migration, lambda r: {**r, "resultingRootDigest": "sha256:" + "c" * 64}, code="MIGRATION_CHANGESET_MISMATCH")
    add("migration-schema", migration, lambda r: {**r, "sourceSchemaLockDigest": r["targetSchemaLockDigest"]}, code="MIGRATION_SCHEMA_UNCHANGED")
    add("migration-method", migration, lambda r: {**r, "provenance": {**r["provenance"], "method": ""}}, code="MIGRATION_INVALID")
    add("report-status", report, lambda r: {**r, "status": "unknown"}, code="REPORT_STRUCTURE_INVALID")
    add("report-id-missing", report, lambda r: {k: v for k, v in r.items() if k != "id"}, code="REPORT_ID_REQUIRED")
    mixed = copy.deepcopy(next(c["files"] for c in result if c["name"] == "element-actor"))
    lock = read_yaml(mixed["schema.lock.yaml"])
    mixed["schema.lock.yaml"] = write_yaml({**lock, "extra": 1})
    refresh(mixed)
    result.append({"name": "header-first-diagnostic", "files": mixed, "accepted": False, "code": "SCHEMA_LOCK_INVALID"})
    return result


class PackageValidationTests(unittest.TestCase):
    def test_corpus_acceptance_and_input_preservation(self):
        for case in cases():
            before = copy.deepcopy(case["files"])
            with self.subTest(name=case["name"]):
                if case["accepted"]:
                    read_package_files(case["files"])
                else:
                    with self.assertRaises(ValueError):
                        read_package_files(case["files"])
                self.assertEqual(case["files"], before)

    def test_structural_diagnostics_are_not_hidden_by_digest_checks(self):
        for case in cases():
            if not case.get("code"):
                continue
            with self.subTest(name=case["name"]), self.assertRaises(ValidationError) as caught:
                read_package_files(case["files"])
            self.assertEqual(caught.exception.code, case["code"])

    def test_empty_graph_and_unicode_graph_identifiers_round_trip(self):
        for identity in ("graph:empty", "graph:allowed\u0085", "graph:allowed\u001c"):
            files = empty_files(identity)
            self.assertEqual(write_package_files(read_package_files(files)), files)

    def test_binding_diagnostics_identify_revocations_and_migrations(self):
        for case in cases():
            if not case["name"].startswith(("ledger-", "migration-")):
                continue
            with self.subTest(name=case["name"]), self.assertRaises(ValidationError) as caught:
                read_package_files(case["files"])
            self.assertTrue(caught.exception.path.startswith(("/approvals/", "/changeSetId", "/resultingRootDigest", "/targetSchemaLockDigest", "/provenance/")))

    def test_report_aliases_keep_content_identity_and_canonical_output_names(self):
        base = read_package_files(base_files())
        expected = base["reports"][0]
        for case in cases():
            if not case["name"].startswith("report-alias-"):
                continue
            package = read_package_files(case["files"])
            self.assertEqual(package["reports"], [expected])
            output = write_package_files(package)
            self.assertIn("reports/" + expected["report"]["id"][9:] + ".yaml", output)

    def test_validation_scope_does_not_claim_schema_or_graph_meaning(self):
        case = next(c for c in cases() if c["name"] == "core-version-unresolved")
        result = read_package_files(case["files"])
        self.assertEqual(result["validation"]["scope"], "record-structures-digests-and-bindings")
        for field in ("recordStructuresValidated", "approvalLedgerValidated", "migrationBindingsValidated", "reportsValidated"):
            self.assertTrue(result["validation"][field])
        for field in ("schemaValidated", "graphReferencesValidated", "signaturesValidated"):
            self.assertFalse(result["validation"][field])
        self.assertNotIn("valid", result)

    def test_write_rechecks_claimed_validation_without_mutating_input(self):
        package = read_package_files(base_files())
        grant = package["approvals"][0]
        package["approvals"].append({**grant, "id": NEW_ID, "operation": "revoke", "revokes": OTHER_ID})
        before = copy.deepcopy(package)
        with self.assertRaises(ValidationError):
            write_package_files(package)
        self.assertEqual(package, before)

    def test_cli_rejects_invalid_structure_without_partial_export_or_file_changes(self):
        files = next(c["files"] for c in cases() if c["name"] == "changeset-operation-array")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name, source in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source)
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("package_records.py")), str(root), "--export"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            for name, source in files.items():
                self.assertEqual((root / name).read_text(), source)


if __name__ == "__main__":
    unittest.main()
