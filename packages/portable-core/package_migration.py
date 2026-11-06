"""Plan a migration or write its checked result to a new package root.

The planner and its CLI perform no data-file I/O. The separate writer owns its
staging and output. Neither path authenticates adoption, rules or mappings.
"""

import asyncio
from copy import deepcopy
import json
import os
import re
import shutil
import sys
from uuid import uuid4

from canonical import canonical_json, digest, load_json, timestamp_text, unicode_text
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
from yaml_records import write_yaml, yaml_quote, plain_key
from ledger_store import _diagnostics, _metadata, _validate, _write, read_ledger_package, write_change_set, write_migration
from package_apply import _output_root, _inside, _write_synced, _remove_file, _remove_tree, _verified, _graph_result
from graph_validation import validate_graph
from report_records import prepare_report
from report_validation import validate_report
from schema_validation import ValidationError, validate_graph_element, validate_schema_definition
from semantic_diff import structural_entries, schema_change_entries


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


def _writer_fail(code, path):
    raise ValidationError(code, path)


def _writer_plan_report(report):
    code = "MIGRATION_SEMANTIC_DIFF_MISMATCH"
    if type(report) is dict and report.get("format") != "morivyx.migration-semantic-diff/0.1":
        _writer_fail(code, "/plannedSemanticDiff/format")
    try:
        checked = validate_report(report)
        if checked["type"] != "migration-semantic-diff":
            _writer_fail(code, "/format")
    except ValidationError as error:
        _writer_fail(code, "/plannedSemanticDiff" + error.path)


def _writer_schema_source(record):
    """Serialize the validated target definition without altering shared layouts."""
    orders = {
        (): "format schemaId version stableIdScheme digestAlgorithm reviewStates entityTypes relationTypes authoringOrders".split(),
        ("entityTypes", "*"): "typeId requiredAttributes optionalAttributes lifecycle".split(),
        ("relationTypes", "*"): "predicate sourceTypes targetTypes minCount maxCount cycle".split(),
        ("authoringOrders",): "root attributes provenance".split(),
    }
    canonical_json(record)
    def normalize(value, path=()):
        if type(value) is dict:
            entries = {unicode_text(key): item for key, item in value.items()}
            order = orders.get(path, [])
            keys = sorted(entries, key=lambda key: (order.index(key), "") if key in order else (len(order), key))
            return {key: normalize(entries[key], path + (key,)) for key in keys}
        if type(value) is list:
            return [normalize(item, path + ("*",)) for item in value]
        if type(value) is str:
            return timestamp_text(unicode_text(value))
        if value is None and path != ("relationTypes", "*", "maxCount"):
            _writer_fail("YAML_SERIALIZATION_INVALID", "/" + "/".join(path))
        return value
    def inline(value):
        return yaml_quote(value) if type(value) is str else canonical_json(value)
    def render(value, indent):
        prefix = " " * indent
        if type(value) is dict and value:
            lines = []
            for key, child in value.items():
                key = key if plain_key(key) and not re.search(r"[\x7f-\x9f]", key) else yaml_quote(key)
                if len(key.encode("utf-16-le")) // 2 > 1024:
                    lines.append(prefix + "? " + key)
                    entry = prefix + ":"
                else:
                    entry = prefix + key + ":"
                if type(child) in (dict, list) and child:
                    lines.append(entry)
                    lines.extend(render(child, indent + 2))
                else:
                    lines.append(entry + " " + inline(child))
            return lines
        if type(value) is list and value:
            lines = []
            for child in value:
                nested = render(child, indent + 2)
                lines.append(prefix + "- " + nested[0][indent + 2:])
                lines.extend(nested[1:])
            return lines
        return [prefix + inline(value)]
    source = "\n".join(render(normalize(record), 0)) + "\n"
    # Match the reference scalar escapes, retaining real YAML record bytes.
    def escape(match):
        slashes, code = match.groups()
        if len(slashes) % 2 == 0:
            return match[0]
        number = int(code, 16)
        replacement = chr(number) if number in (0x2028, 0x2029) else "\\" + {0: "0", 7: "a", 11: "v", 27: "e"}.get(number, "x" + code[-2:])
        return slashes[:-1] + replacement
    return re.sub(r"(\\+)u(00[01][0-9a-f]|202[89])", escape, source)


def _writer_write_schema(path, record):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(_writer_schema_source(record).encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())


def _writer_target_schemas(lock, definitions):
    _validate(validate_schema_lock, lock, "/targetSchemaLock")
    code = "MIGRATION_TARGET_SCHEMA_MISMATCH"
    if type(definitions) is not list:
        _writer_fail(code, "/targetSchemaDefinitions")
    schemas = {}
    for index, definition in enumerate(definitions):
        path = "/targetSchemaDefinitions/" + str(index)
        _validate(validate_schema_definition, definition, path)
        key = definition["schemaId"] + "@" + definition["version"]
        if key in schemas:
            _writer_fail(code, path + "/schemaId")
        schemas[key] = definition
    if len(schemas) != len(lock["schemas"]):
        _writer_fail(code, "/targetSchemaDefinitions")
    for index, locked in enumerate(lock["schemas"]):
        definition = schemas.get(locked["schemaId"] + "@" + locked["version"])
        if definition is None or digest("schema", definition)["digest"] != locked["digest"]:
            _writer_fail(code, "/targetSchemaLock/schemas/" + str(index) + "/digest")
    return list(schemas.values())


def _writer_read_package(path):
    try:
        return read_ledger_package(path)
    except ValidationError as error:
        # The original reader rejects a populated root flow collection before
        # reporting its missing closing delimiter. Preserve that precedence in
        # this writer without changing the already published ledger reader.
        if error.code == "PACKAGE_YAML_INVALID" and type(error.path) is str and "#" not in error.path:
            metadata = _metadata(path)
            if _inside(metadata, error.path) and os.path.isfile(error.path) and not os.path.islink(error.path):
                with open(error.path, "r", encoding="utf-8") as stream:
                    source = stream.read()
                first = next((line.lstrip() for line in source.split("\n") if line.strip() and not line.lstrip().startswith("#")), "")
                if re.match(r"[\[{]\s*[^\]\}#\s]", first):
                    _writer_fail("PACKAGE_AUTHORING_PROFILE_INVALID", error.path)
        raise


@_diagnostics
def _write_migrated(value, output):
    base_path = value.get("basePath")
    base = _writer_read_package(base_path)
    candidates = value.get("candidateElements", [])
    if type(candidates) is list:
        for index, candidate in enumerate(candidates):
            _validate(validate_graph_element, candidate, "/candidateElements/" + str(index))
    migration, change = value.get("migration"), value.get("changeSet")
    report, lock = value.get("plannedSemanticDiff"), value.get("targetSchemaLock")
    definitions = value.get("targetSchemaDefinitions")
    validate_migration_change_set(migration, change)
    _writer_plan_report(report)
    schemas = _writer_target_schemas(lock, definitions)
    target_digest = digest("schema-lock", lock)["digest"]
    if target_digest != migration["targetSchemaLockDigest"]:
        _writer_fail("MIGRATION_TARGET_SCHEMA_MISMATCH", "/targetSchemaLock")
    actual = [entry for entry in report["entries"] if entry["kind"] == "schema_changed"]
    if canonical_json(actual) != canonical_json(schema_change_entries(base["schemaLock"], lock)):
        _writer_fail("MIGRATION_SEMANTIC_DIFF_MISMATCH", "/plannedSemanticDiff/entries")
    application = {"changeSet": change, "currentRevision": base["revision"],
                   "sourceSchemaLockDigest": migration["sourceSchemaLockDigest"],
                   "targetSchemaLockDigest": migration["targetSchemaLockDigest"],
                   "currentElements": base["elements"], "candidateElements": candidates,
                   "resultingRevision": value.get("resultingRevision")}
    provisional = apply_change_set(application)
    actual = [entry for entry in report["entries"] if entry["kind"] not in ("schema_changed", "trace_quality_changed")]
    if canonical_json(actual) != canonical_json(structural_entries(base["elements"], provisional["elements"])):
        _writer_fail("MIGRATION_SEMANTIC_DIFF_MISMATCH", "/plannedSemanticDiff/entries")
    target_validation = validate_graph(graph_revision=provisional["revision"]["id"], schema_lock_digest=target_digest,
        schemas=schemas, elements=provisional["elements"], previous_elements=base["elements"], approvals=base["approvals"])
    applied = apply_migration({**application, "migration": migration, "plannedSemanticDiff": report,
                               "targetValidation": target_validation})
    existing = []
    for collection, record, kind, code, path in (
        ("changeSets", change, "changeset", "CHANGESET_ALREADY_EXISTS", "/changeSet/id"),
        ("migrations", migration, "migration", "MIGRATION_ALREADY_EXISTS", "/migration/id"),
        ("reports", report, "migration-semantic-diff", "REPORT_ALREADY_EXISTS", "/plannedSemanticDiff/id"),
    ):
        records = [entry["report"] for entry in base[collection]] if collection == "reports" else base[collection]
        old = next((entry for entry in records if entry.get("id") == record.get("id")), None)
        if old is not None and digest(kind, old) != digest(kind, record):
            _writer_fail(code, path)
        existing.append(old)
    base_real = os.path.realpath(os.path.dirname(_metadata(base_path)), strict=True)
    parent = os.path.dirname(output)
    ancestor, missing = parent, []
    while True:
        try:
            parent_real = os.path.join(os.path.realpath(ancestor, strict=True), *reversed(missing))
            break
        except FileNotFoundError:
            missing.append(os.path.basename(ancestor))
            previous = os.path.dirname(ancestor)
            if previous == ancestor:
                raise
            ancestor = previous
    if _inside(base_real, os.path.join(parent_real, os.path.basename(output))):
        _writer_fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    os.makedirs(parent, exist_ok=True)
    temporary = os.path.join(parent, f".{os.path.basename(output)}-{os.getpid()}-{uuid4()}.tmp")
    metadata = os.path.join(temporary, ".morivyx")
    temporary_created = claimed = False
    try:
        os.mkdir(temporary)
        temporary_created = True
        shutil.copytree(_metadata(base_path), metadata, symlinks=False)
        _remove_file(os.path.join(metadata, "index.json"))
        for name in ("graph", "schemas"):
            _remove_tree(os.path.join(metadata, name))
        for name in ("revision.yaml", "schema.lock.yaml"):
            _remove_file(os.path.join(metadata, name))
        for directory in ("graph/entities", "graph/relations", "schemas"):
            os.makedirs(os.path.join(metadata, directory))
        for element in applied["elements"]:
            directory = "entities" if element["kind"] == "entity" else "relations"
            _write_synced(os.path.join(metadata, "graph", directory, element["id"][9:] + ".yaml"), element)
        _write_synced(os.path.join(metadata, "revision.yaml"), applied["revision"])
        _write_synced(os.path.join(metadata, "schema.lock.yaml"), lock)
        for definition in definitions:
            _writer_write_schema(os.path.join(metadata, "schemas", definition["schemaId"] + "@" + definition["version"] + ".yaml"), definition)
        if existing[0] is None:
            write_change_set(temporary, change)
        if existing[1] is None:
            write_migration(temporary, migration)
        if existing[2] is None:
            if "id" not in report:
                _writer_fail("REPORT_ID_REQUIRED", "/id")
            _write(temporary, report, "reports", prepare_report, "reports", "REPORT_ALREADY_EXISTS", "migration-semantic-diff")
        verified = _writer_read_package(temporary)
        _verified(verified, applied, change)
        stored_migration = next((row for row in verified["migrations"] if row["id"] == migration["id"]), None)
        stored_report = next((row["report"] for row in verified["reports"] if row["report"]["id"] == report["id"]), None)
        if (verified["calculatedSchemaLockDigest"] != target_digest or stored_migration is None or
                digest("migration", stored_migration) != digest("migration", migration) or stored_report is None or
                digest("migration-semantic-diff", stored_report) != digest("migration-semantic-diff", report)):
            _writer_fail("PACKAGE_OUTPUT_MISMATCH", "/outputPath/.morivyx")
        output_validation = _graph_result(verified)
        if output_validation["valid"] is not True or any(output_validation[key] != target_validation[key] for key in ("graphRevision", "schemaLockDigest", "rootDigest")):
            _writer_fail("MIGRATION_TARGET_VALIDATION_FAILED", "/outputPath")
        try:
            os.mkdir(output)
            claimed = True
        except FileExistsError:
            _writer_fail("PACKAGE_OUTPUT_EXISTS", output)
        os.rename(metadata, os.path.join(output, ".morivyx"))
        shutil.rmtree(temporary)
    except BaseException:
        if temporary_created:
            _remove_tree(temporary)
        if claimed:
            _remove_tree(output)
        raise
    return {"valid": True, "outputPath": output, "metadataPath": os.path.join(output, ".morivyx"),
            "graphRevision": applied["revision"]["id"], "rootDigest": applied["rootDigest"],
            "elementCount": len(applied["elements"]), "changeSetId": change["id"], "migrationId": migration["id"],
            "plannedSemanticDiffId": report["id"], "schemaLockDigest": target_digest}


def write_migrated_package(input_value=None):
    """Capture root fields now; return an awaitable checked save operation.

    Nested records retain their references until validation, matching the
    original writer. Filesystem isolation against hostile races is unproven.
    """
    fields = ("basePath", "outputPath", "migration", "changeSet", "plannedSemanticDiff", "candidateElements",
              "resultingRevision", "targetSchemaLock", "targetSchemaDefinitions")
    try:
        value = {key: input_value[key] for key in fields if key in input_value} if type(input_value) is dict else {}
        output = _output_root(value.get("basePath"), value.get("outputPath"))
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        return _write_migrated(value, output)
    return save()


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
