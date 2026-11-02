"""Plan an explicit package migration using actual source and target Schemas.

No data-file I/O, adoption, rules execution or implicit conversion is performed.
The returned mapping is a proposed new package, not an adopted revision.
"""

from copy import deepcopy
import json
import sys

from canonical import canonical_json, digest, load_json
from changeset_apply import apply_change_set
from migration_apply import apply_migration, planned_diff
from migration_validation import validate_migration_change_set
from package_records import read_package_files
from package_validation import _validate_checked_contents, validate_package_files
from portable_cli import read_request_bytes
from record_validation import validate_schema_lock
from report_records import serialize_report_yaml
from schema_registry import resolve_schema_registry
from semantic_diff import create_migration_semantic_diff
from yaml_records import write_yaml


FIELDS = {"sourceFiles", "targetSchemaLock", "targetSchemaSources", "migration", "changeSet",
          "plannedSemanticDiff", "candidateElements", "resultingRevision"}


class PackageMigrationError(ValueError):
    def __init__(self, suffix, path="/"):
        self.code, self.path = "PACKAGE_MIGRATION_" + suffix, path
        super().__init__(self.code)


def fail(suffix, path="/"):
    raise PackageMigrationError(suffix, path)


def stage(suffix, path, function):
    try:
        return function()
    except (ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError):
        fail(suffix, path)


def bounded_input(value, active=None, depth=0):
    if depth > 128:
        fail("INPUT_INVALID")
    if value is None or type(value) in (str, int, float, bool):
        return
    if type(value) not in (dict, list):
        fail("INPUT_INVALID")
    active = set() if active is None else active
    if id(value) in active:
        fail("INPUT_INVALID")
    active.add(id(value))
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            fail("INPUT_INVALID")
        for entry in value.values():
            bounded_input(entry, active, depth + 1)
    else:
        for entry in value:
            bounded_input(entry, active, depth + 1)
    active.remove(id(value))


def plan_package_migration(value):
    """Return a detached proposed package; validate all declarations against data."""
    bounded_input(value)
    if type(value) is not dict or set(value) != FIELDS:
        fail("INPUT_INVALID")
    files = value["sourceFiles"]
    if type(files) is not dict or any(type(p) is not str or type(s) is not str for p, s in files.items()):
        fail("SOURCE_INVALID", "/sourceFiles")
    stage("SOURCE_INVALID", "/sourceFiles", lambda: [(p.encode("utf-8"), s.encode("utf-8")) for p, s in files.items()])
    source = stage("SOURCE_INVALID", "/sourceFiles", lambda: read_package_files(files))
    validation = stage("SOURCE_INVALID", "/sourceFiles", lambda: _validate_checked_contents(source))
    if validation["valid"] is not True:
        fail("SOURCE_INVALID", "/sourceFiles")
    lock, sources = value["targetSchemaLock"], value["targetSchemaSources"]
    stage("TARGET_SCHEMA_INVALID", "/targetSchemaLock", lambda: validate_schema_lock(lock))
    target_digest = stage("TARGET_SCHEMA_INVALID", "/targetSchemaLock", lambda: digest("schema-lock", lock)["digest"])
    old_schemas = {(s["schemaId"], s["version"]): s["digest"] for s in source["schemaLock"]["schemas"]}
    if any((s["schemaId"], s["version"]) in old_schemas and old_schemas[(s["schemaId"], s["version"])] != s["digest"] for s in lock["schemas"]):
        fail("TARGET_SCHEMA_INVALID", "/targetSchemaLock")
    registry = stage("TARGET_SCHEMA_INVALID", "/targetSchemaSources", lambda: resolve_schema_registry(lock, sources))
    if registry["issues"] or any(type(s) is not str for s in sources.values()):
        fail("TARGET_SCHEMA_INVALID", "/targetSchemaSources")
    migration, change = value["migration"], value["changeSet"]
    stage("PLAN_INVALID", "/migration", lambda: validate_migration_change_set(migration, change))
    if migration["sourceSchemaLockDigest"] != source["calculatedSchemaLockDigest"]:
        fail("SOURCE_BINDING_INVALID", "/migration")
    if migration["targetSchemaLockDigest"] != target_digest:
        fail("TARGET_BINDING_INVALID", "/targetSchemaLock")
    report = value["plannedSemanticDiff"]
    stage("PLAN_INVALID", "/plannedSemanticDiff", lambda: planned_diff(migration, report))
    if "id" not in report:
        fail("PLAN_INVALID", "/plannedSemanticDiff")
    application_input = {"changeSet": change, "currentRevision": source["revision"],
                         "currentElements": source["elements"], "candidateElements": value["candidateElements"],
                         "resultingRevision": value["resultingRevision"],
                         "sourceSchemaLockDigest": source["calculatedSchemaLockDigest"], "targetSchemaLockDigest": target_digest}
    application = stage("APPLICATION_INVALID", "/changeSet", lambda: apply_change_set(application_input))
    targets = {e["id"]: e for e in application["elements"]}
    replacements = {op["targetId"]: op["replacementId"] for op in change["operations"] if op["op"] == "replace"}
    for element in source["elements"]:
        old = element.get("extensions", {})
        if not old:
            continue
        current = targets.get(replacements.get(element["id"], element["id"]), {}).get("extensions", {})
        if any(key not in current or canonical_json(body) != canonical_json(current[key]) for key, body in old.items()):
            fail("EXTENSION_LOSS", "/candidateElements")
    calculated = stage("PLAN_INVALID", "/plannedSemanticDiff", lambda: create_migration_semantic_diff({
        "id": report["id"], "evaluatedAt": report["evaluatedAt"],
        "baseRevision": source["revision"]["id"], "targetRevision": application["revision"]["id"],
        "sourceSchemaLock": source["schemaLock"], "targetSchemaLock": lock,
        "sourceSchemaLockDigest": source["calculatedSchemaLockDigest"], "targetSchemaLockDigest": target_digest,
        "baseElements": source["elements"], "targetElements": application["elements"]}))
    if canonical_json(calculated) != canonical_json(report):
        fail("PLAN_MISMATCH", "/plannedSemanticDiff")
    result = {p: s for p, s in files.items() if not p.startswith(("graph/", "schemas/"))}
    result.update({"schema.lock.yaml": write_yaml(lock), "revision.yaml": write_yaml(application["revision"])})
    result.update({"schemas/" + p: s for p, s in sources.items()})
    previous_elements = {e["id"]: e for e in source["elements"]}
    for element in application["elements"]:
        p = "graph/" + ("entities/" if element["kind"] == "entity" else "relations/") + element["id"][9:] + ".yaml"
        old = previous_elements.get(element["id"])
        result[p] = files[p] if old is not None and canonical_json(old) == canonical_json(element) else write_yaml(element)
    by_id = {}
    for collection in ("elements", "approvals", "changeSets", "migrations", "reports"):
        for entry in source[collection]:
            record = entry["report"] if collection == "reports" else entry
            by_id[record["id"]] = record
    for field, directory, record in [("migration", "migrations", migration), ("changeSet", "ledger", change),
                                      ("plannedSemanticDiff", "reports", report)]:
        existing = by_id.get(record["id"])
        if existing is not None:
            if canonical_json(existing) != canonical_json(record):
                fail("RECORD_CONFLICT", "/" + field)
            continue
        result[directory + "/" + record["id"][9:] + ".yaml"] = stage("PLAN_INVALID", "/" + field,
            lambda: serialize_report_yaml(record) if directory == "reports" else write_yaml(record))
    target_validation = stage("TARGET_INVALID", "/targetSchemaSources", lambda: validate_package_files(result, previous_files=files))
    if target_validation["valid"] is not True:
        fail("TARGET_INVALID", "/targetSchemaSources")
    applied = stage("APPLICATION_INVALID", "/migration", lambda: apply_migration({
        **application_input, "migration": migration, "plannedSemanticDiff": report, "targetValidation": target_validation}))
    return deepcopy({"files": result, "source": {"graphRevision": source["revision"]["id"],
                     "rootDigest": source["revision"]["rootDigest"], "schemaLockDigest": source["calculatedSchemaLockDigest"]},
        "target": {"graphRevision": applied["revision"]["id"], "rootDigest": applied["rootDigest"], "schemaLockDigest": target_digest},
        "migrationDigest": applied["migrationDigest"], "plannedSemanticDiffDigest": applied["plannedSemanticDiffDigest"],
        "checks": {"sourceSchemaAndGraphValidated": True, "targetSchemaAndGraphValidated": True,
                   "lifecycleTransitionsCompared": True, "plannedDiffRecalculated": True,
                   "historyAncestryValidated": False, "rulesAndMappingAuthenticated": False,
                   "adoptionAuthorityValidated": False, "signaturesValidated": False}})


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if args:
            fail("INPUT_INVALID")
        raw = stage("LIMIT_EXCEEDED", "/", lambda: read_request_bytes(sys.stdin.buffer))
        value = stage("INPUT_INVALID", "/", lambda: load_json(raw.decode("utf-8", errors="strict")))
        result = plan_package_migration(value)
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError, KeyError, IndexError, OSError, OverflowError, RecursionError) as error:
        known = isinstance(error, PackageMigrationError)
        print(json.dumps({"error": {"code": error.code if known else "PACKAGE_MIGRATION_INPUT_INVALID",
                                   "path": error.path if known else "/"}}, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
