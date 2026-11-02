"""Generate existing diff reports from projections; no Graph/trust verdict.

Element revisions are caller declarations, not recomputed from element contents.
Trace quality changes are supplied by the caller; this module runs no queries.
"""

from canonical import canonical_json, digest, entry_key, unicode_text
from record_validation import GRAPH_ID, text, timestamp
from report_validation import TRACE_QUERIES, TRACE_STATUSES
from schema_validation import DIGEST, STABLE_ID, ValidationError


UNSET = object()
INPUT = "SEMANTIC_DIFF_INPUT_INVALID"


def fail(code, path):
    raise ValidationError(code, path)


def sorted_entries(entries):
    result = sorted((dict(entry) for entry in entries), key=entry_key)
    for index in range(1, len(result)):
        if entry_key(result[index - 1]) == entry_key(result[index]):
            fail("SEMANTIC_DIFF_ENTRY_DUPLICATE", "/entries/" + str(index))
    return result


def element_projection(elements, field):
    seen = set()
    for index, element in enumerate(elements):
        path = "/" + field + "/" + str(index)
        if type(element) is not dict:
            fail(INPUT, path)
        text(element.get("id"), INPUT, path + "/id", STABLE_ID)
        if element["id"] in seen:
            fail(INPUT, path + "/id")
        seen.add(element["id"])
        if element.get("kind") not in ("entity", "relation"):
            fail(INPUT, path + "/kind")
        text(element.get("revision"), INPUT, path + "/revision", DIGEST)


def structural_entries(base_elements, target_elements):
    base = {unicode_text(element["id"]): element for element in base_elements}
    target = {unicode_text(element["id"]): element for element in target_elements}
    entries = []
    for identity in sorted(base.keys() | target.keys()):
        before, after = base.get(identity), target.get(identity)
        if before is None:
            entries.append({"kind": after["kind"] + "_added", "targetId": identity, "afterRevision": after["revision"]})
        elif after is None:
            entries.append({"kind": before["kind"] + "_retired", "targetId": identity, "beforeRevision": before["revision"]})
        elif before["revision"] == after["revision"]:
            continue
        elif before["kind"] != after["kind"]:
            entries.extend([{"kind": before["kind"] + "_retired", "targetId": identity, "beforeRevision": before["revision"]},
                            {"kind": after["kind"] + "_added", "targetId": identity, "afterRevision": after["revision"]}])
        else:
            entries.append({"kind": after["kind"] + "_revised", "targetId": identity,
                            "beforeRevision": before["revision"], "afterRevision": after["revision"]})
    return sorted_entries(entries)


def trace_entries(changes):
    entries = []
    for index, change in enumerate(changes):
        path = "/traceChanges/" + str(index)
        if type(change) is not dict:
            fail(INPUT, path)
        text(change.get("targetId"), INPUT, path + "/targetId", STABLE_ID)
        if any(type(change.get(field)) is not str or change[field] not in allowed for field, allowed in (
            ("queryId", TRACE_QUERIES), ("beforeStatus", TRACE_STATUSES), ("afterStatus", TRACE_STATUSES)
        )):
            fail(INPUT, path)
        if change["beforeStatus"] != change["afterStatus"]:
            entries.append({"kind": "trace_quality_changed", "targetId": unicode_text(change["targetId"]),
                            **{field: change[field] for field in ("queryId", "beforeStatus", "afterStatus")}})
    return entries


def create_semantic_diff(value):
    """Return a deterministic same-lock report from declared element projections."""
    value = value if type(value) is dict else {}
    for field in ("baseRevision", "targetRevision"):
        text(value.get(field), INPUT, "/" + field, GRAPH_ID)
    text(value.get("schemaLockDigest"), INPUT, "/schemaLockDigest", DIGEST)
    timestamp(value.get("evaluatedAt"), INPUT, "/evaluatedAt")
    if "id" in value:
        text(value["id"], INPUT, "/id", STABLE_ID)
    arrays = {"baseElements": value.get("baseElements"), "targetElements": value.get("targetElements"),
              "traceChanges": value.get("traceChanges", [])}
    for field, array in arrays.items():
        if type(array) is not list:
            fail(INPUT, "/" + field)
    element_projection(arrays["baseElements"], "baseElements")
    element_projection(arrays["targetElements"], "targetElements")
    entries = sorted_entries([*structural_entries(arrays["baseElements"], arrays["targetElements"]), *trace_entries(arrays["traceChanges"])])
    return {"format": "morivyx.semantic-diff/0.1", **({"id": value["id"]} if "id" in value else {}),
            **{field: value[field] for field in ("baseRevision", "targetRevision", "schemaLockDigest", "evaluatedAt")}, "entries": entries}


def schema_entries(lock, path):
    if type(lock) is not dict or type(lock.get("schemas")) is not list:
        fail(INPUT, path + "/schemas")
    entries = {}
    for entry in lock["schemas"]:
        if type(entry) is not dict or type(entry.get("schemaId")) is not str or not entry["schemaId"]:
            fail(INPUT, path + "/schemas")
        identity = unicode_text(entry["schemaId"])
        if identity in entries:
            fail(INPUT, path + "/schemas")
        entries[identity] = entry
    return entries


def schema_change_entries(source_lock, target_lock):
    source = schema_entries(source_lock, "/sourceSchemaLock")
    target = schema_entries(target_lock, "/targetSchemaLock")
    entries = []
    for identity in sorted(source.keys() | target.keys()):
        if identity not in source or identity not in target or canonical_json(source[identity]) != canonical_json(target[identity]):
            entries.append({"kind": "schema_changed", "targetId": identity})
    if not entries:
        fail(INPUT, "/targetSchemaLock/schemas")
    return entries


def verify_lock(lock, declared, path):
    try:
        actual = digest("schema-lock", lock)["digest"]
    except (ValueError, TypeError, KeyError, RecursionError):
        fail("SCHEMA_LOCK_CONFLICT", path)
    if actual != declared:
        fail("SCHEMA_LOCK_CONFLICT", path)


def create_migration_semantic_diff(value):
    """Check both lock digests and report structural and Schema-entry changes."""
    value = value if type(value) is dict else {}
    for side in ("source", "target"):
        verify_lock(value.get(side + "SchemaLock", UNSET), value.get(side + "SchemaLockDigest", UNSET), "/" + side + "SchemaLockDigest")
    if value["sourceSchemaLockDigest"] == value["targetSchemaLockDigest"]:
        fail("SCHEMA_LOCK_CONFLICT", "/targetSchemaLockDigest")
    common = {field: value[field] for field in ("baseRevision", "targetRevision", "evaluatedAt", "baseElements", "targetElements", "traceChanges", "id") if field in value}
    common["schemaLockDigest"] = value["targetSchemaLockDigest"]
    report = create_semantic_diff(common)
    entries = sorted_entries([*report["entries"], *schema_change_entries(value["sourceSchemaLock"], value["targetSchemaLock"])])
    return {"format": "morivyx.migration-semantic-diff/0.1", **({"id": report["id"]} if "id" in report else {}),
            "baseRevision": report["baseRevision"], "targetRevision": report["targetRevision"],
            "sourceSchemaLockDigest": value["sourceSchemaLockDigest"], "targetSchemaLockDigest": value["targetSchemaLockDigest"],
            "evaluatedAt": report["evaluatedAt"], "entries": entries}
