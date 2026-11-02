"""Independent report structure checks; not proof of a query against a Graph."""

from canonical import TIMESTAMP, canonical_json, entry_key, unicode_text
from record_validation import GRAPH_ID
from schema_validation import DIGEST, SCHEMA_ID, STABLE_ID, ValidationError, pointer, require


STRUCTURE = "REPORT_STRUCTURE_INVALID"
ORDER = "REPORT_ORDER_INVALID"
TRACE_QUERIES = {"why-artifact-exists", "governing-decision", "decision-evidence", "goal-achievement-evidence", "observation-triggered-change"}
TRACE_STATUSES = {"complete", "partial", "waived", "stale", "broken"}
TRACE_REQUIRED = "format queryId graphRevision schemaLockDigest focusId evaluatedAt status paths missing".split()
HOP_FIELDS = "fromId predicate toId fromRevision toRevision".split()


def fields(record, required, optional=(), path=""):
    require(type(record) is dict, STRUCTURE, path)
    for field in required:
        require(field in record, STRUCTURE, pointer(path, field))
    allowed = set(required) | set(optional)
    for field in record:
        require(field in allowed, STRUCTURE, pointer(path, field))


def report_text(record, field, path="", pattern=None):
    value = record.get(field)
    location = pointer(path, field)
    require(type(value) is str and bool(value), STRUCTURE, location)
    try:
        normalized = unicode_text(value)
    except ValueError:
        raise ValidationError(STRUCTURE, location) from None
    if pattern is not None:
        require(pattern.fullmatch(normalized) is not None, STRUCTURE, location)
    return normalized


def report_time(record, field, path=""):
    value = report_text(record, field, path, TIMESTAMP)
    try:
        canonical_json(value)
    except ValueError:
        raise ValidationError(STRUCTURE, pointer(path, field)) from None


def validate_trace_paths(paths, focus_id):
    require(type(paths) is list, STRUCTURE, "/paths")
    previous = None
    for path_index, trace_path in enumerate(paths):
        path = "/paths/" + str(path_index)
        fields(trace_path, ["hops"], path=path)
        hops = trace_path["hops"]
        require(type(hops) is list and bool(hops), STRUCTURE, path + "/hops")
        previous_endpoints = None
        for hop_index, hop in enumerate(hops):
            hop_path = path + "/hops/" + str(hop_index)
            fields(hop, HOP_FIELDS, path=hop_path)
            for field, pattern in [("fromId", STABLE_ID), ("predicate", None), ("toId", STABLE_ID),
                                   ("fromRevision", DIGEST), ("toRevision", DIGEST)]:
                report_text(hop, field, hop_path, pattern)
            if hop_index == 0:
                require(focus_id in (hop["fromId"], hop["toId"]), STRUCTURE, hop_path)
            endpoints = {(hop["fromId"], hop["fromRevision"]), (hop["toId"], hop["toRevision"])}
            require(previous_endpoints is None or bool(previous_endpoints & endpoints), STRUCTURE, hop_path)
            previous_endpoints = endpoints
        current = canonical_json(trace_path)
        require(previous is None or previous <= current, ORDER, path)
        previous = current


def validate_missing(missing):
    require(type(missing) is list, STRUCTURE, "/missing")
    previous = None
    for index, value in enumerate(missing):
        path = "/missing/" + str(index)
        require(type(value) is str and bool(value), STRUCTURE, path)
        current = unicode_text(value)
        require(previous is None or previous < current, ORDER, path)
        previous = current


def validate_trace_report(report):
    """Check trace shape, connected endpoints, order and status consistency.

    Does not run a query, resolve Graph references or authenticate a waiver.
    Returns the input unchanged; errors use logical JSON pointers.
    """
    fields(report, TRACE_REQUIRED, ["id", "waiverDecisionId"])
    require(report["format"] == "morivyx.trace-report/0.1", STRUCTURE, "/format")
    if "id" in report:
        report_text(report, "id", pattern=STABLE_ID)
    query = report_text(report, "queryId")
    require(query in TRACE_QUERIES, STRUCTURE, "/queryId")
    report_text(report, "graphRevision", pattern=GRAPH_ID)
    report_text(report, "schemaLockDigest", pattern=DIGEST)
    report_text(report, "focusId", pattern=STABLE_ID)
    report_time(report, "evaluatedAt")
    status = report_text(report, "status")
    require(status in TRACE_STATUSES, STRUCTURE, "/status")
    if status == "waived":
        require("waiverDecisionId" in report, STRUCTURE, "/waiverDecisionId")
        report_text(report, "waiverDecisionId", pattern=STABLE_ID)
    else:
        require("waiverDecisionId" not in report, STRUCTURE, "/waiverDecisionId")
    validate_trace_paths(report["paths"], report["focusId"])
    validate_missing(report["missing"])
    if status == "complete":
        require(bool(report["paths"]), STRUCTURE, "/paths")
        require(not report["missing"], STRUCTURE, "/missing")
    if status in ("partial", "waived"):
        require(bool(report["missing"]), STRUCTURE, "/missing")
    return report


DIFF_FIELDS = {
    "entity_added": ["afterRevision"], "entity_revised": ["beforeRevision", "afterRevision"],
    "entity_retired": ["beforeRevision"], "entity_replaced": ["beforeRevision", "afterRevision", "replacementId"],
    "relation_added": ["afterRevision"], "relation_revised": ["beforeRevision", "afterRevision"],
    "relation_retired": ["beforeRevision"], "decision_changed": ["beforeRevision", "afterRevision", "aspect"],
    "goal_changed": ["beforeRevision", "afterRevision", "aspect"],
    "trace_quality_changed": ["queryId", "beforeStatus", "afterStatus"],
    "provenance_changed": ["beforeRevision", "afterRevision"],
    "external_digest_changed": ["beforeRevision", "afterRevision"], "schema_changed": [],
    "unknown_extension_changed": ["beforeRevision", "afterRevision"],
}


def validate_diff_entry(entry, index):
    path = "/entries/" + str(index)
    require(type(entry) is dict, STRUCTURE, path)
    kind = report_text(entry, "kind", path)
    require(kind in DIFF_FIELDS, STRUCTURE, path + "/kind")
    fields(entry, ["kind", "targetId", *DIFF_FIELDS[kind]], path=path)
    report_text(entry, "targetId", path, SCHEMA_ID if kind == "schema_changed" else STABLE_ID)
    for field in ("beforeRevision", "afterRevision"):
        if field in entry:
            report_text(entry, field, path, DIGEST)
    if "beforeRevision" in entry and "afterRevision" in entry:
        require(entry["beforeRevision"] != entry["afterRevision"], STRUCTURE, path + "/afterRevision")
    if "replacementId" in entry:
        report_text(entry, "replacementId", path, STABLE_ID)
        require(entry["replacementId"] != entry["targetId"], STRUCTURE, path + "/replacementId")
    if kind in ("decision_changed", "goal_changed"):
        aspect = report_text(entry, "aspect", path)
        allowed = {"selection", "evidence", "scope"} if kind == "decision_changed" else {"criterion", "achievement"}
        require(aspect in allowed, STRUCTURE, path + "/aspect")
    if kind == "trace_quality_changed":
        query = report_text(entry, "queryId", path)
        before = report_text(entry, "beforeStatus", path)
        after = report_text(entry, "afterStatus", path)
        require(query in TRACE_QUERIES, STRUCTURE, path + "/queryId")
        require(before in TRACE_STATUSES and after in TRACE_STATUSES, STRUCTURE, path)
        require(before != after, STRUCTURE, path + "/afterStatus")


def validate_diff_entries(entries):
    require(type(entries) is list, STRUCTURE, "/entries")
    previous = None
    for index, entry in enumerate(entries):
        validate_diff_entry(entry, index)
        current = entry_key(entry)
        require(previous is None or previous < current, ORDER, "/entries/" + str(index))
        previous = current


def _validate_diff_report(report, migration):
    digest_fields = ["sourceSchemaLockDigest", "targetSchemaLockDigest"] if migration else ["schemaLockDigest"]
    required = ["format", "baseRevision", "targetRevision", *digest_fields, "evaluatedAt", "entries"]
    fields(report, required, ["id"])
    format_id = "morivyx.migration-semantic-diff/0.1" if migration else "morivyx.semantic-diff/0.1"
    require(report["format"] == format_id, STRUCTURE, "/format")
    if "id" in report:
        report_text(report, "id", pattern=STABLE_ID)
    for field in ("baseRevision", "targetRevision"):
        report_text(report, field, pattern=GRAPH_ID)
    values = [report_text(report, field, pattern=DIGEST) for field in digest_fields]
    if migration:
        require(values[0] != values[1], STRUCTURE, "/targetSchemaLockDigest")
    report_time(report, "evaluatedAt")
    validate_diff_entries(report["entries"])
    if migration:
        require(any(entry["kind"] == "schema_changed" for entry in report["entries"]),
                "MIGRATION_SEMANTIC_DIFF_MISMATCH", "/entries")
    return report


def validate_semantic_diff_report(report):
    """Validate diff structure and logical order, without comparing Graphs."""
    return _validate_diff_report(report, False)


def validate_migration_semantic_diff_report(report):
    """Validate a schema-changing diff record; do not validate or apply a plan."""
    return _validate_diff_report(report, True)


EXTERNAL_ISSUE_ORDER = [
    "EXTERNAL_REFERENCE_INCOMPLETE", "EXTERNAL_DIGEST_RULE_UNSUPPORTED", "EXTERNAL_SOURCE_UNAVAILABLE",
    "EXTERNAL_TARGET_MISSING", "EXTERNAL_VERSION_CHANGED", "EXTERNAL_DIGEST_CHANGED",
]
EXTERNAL_ISSUES_BY_STATUS = {
    "current": set(), "stale": {"EXTERNAL_VERSION_CHANGED", "EXTERNAL_DIGEST_CHANGED"},
    "missing": {"EXTERNAL_TARGET_MISSING"}, "unavailable": {"EXTERNAL_SOURCE_UNAVAILABLE"},
    "invalid": {"EXTERNAL_REFERENCE_INCOMPLETE", "EXTERNAL_DIGEST_RULE_UNSUPPORTED"},
}
RETRIEVAL_FIELDS = "status comparedAt digest digestRule externalVersion method reason".split()


def report_nullable_text(record, field, path=""):
    return None if field in record and record[field] is None else report_text(record, field, path)


def validate_external_identity(identity, path, lifecycle, invalid):
    required = ["id", "revision", *(["lifecycle"] if lifecycle else [])]
    fields(identity, required, path=path)
    if invalid:
        for field in required:
            report_nullable_text(identity, field, path)
    else:
        report_text(identity, "id", path, STABLE_ID)
        report_text(identity, "revision", path, DIGEST)
        if lifecycle:
            report_text(identity, "lifecycle", path)


def validate_external_retrieval(retrieval, status):
    path = "/retrieval"
    if retrieval is None:
        require(status == "invalid", STRUCTURE, path)
        return
    if status == "invalid":
        fields(retrieval, ["status", "comparedAt"], RETRIEVAL_FIELDS, path)
        for field in retrieval:
            report_nullable_text(retrieval, field, path)
        return
    expected = "resolved" if status in ("current", "stale") else status
    extra = {"resolved": ["digest", "digestRule"], "missing": ["method"], "unavailable": ["reason"]}[expected]
    fields(retrieval, ["status", "comparedAt", *extra], ["externalVersion"] if expected == "resolved" else [], path)
    actual = report_text(retrieval, "status", path)
    require(actual in ("resolved", "missing", "unavailable") and actual == expected, STRUCTURE, path + "/status")
    report_time(retrieval, "comparedAt", path)
    if actual == "resolved":
        report_text(retrieval, "digest", path, DIGEST)
        report_text(retrieval, "digestRule", path)
        if "externalVersion" in retrieval:
            report_text(retrieval, "externalVersion", path)
    else:
        report_text(retrieval, "method" if actual == "missing" else "reason", path)


def validate_external_issues(issues, status):
    require(type(issues) is list, STRUCTURE, "/issues")
    previous, codes = -1, []
    for index, issue in enumerate(issues):
        path = "/issues/" + str(index)
        fields(issue, ["code"], path=path)
        code = report_text(issue, "code", path)
        require(code in EXTERNAL_ISSUE_ORDER, STRUCTURE, path + "/code")
        position = EXTERNAL_ISSUE_ORDER.index(code)
        require(position > previous, ORDER, path)
        previous = position
        codes.append(code)
    allowed = EXTERNAL_ISSUES_BY_STATUS[status]
    require(all(code in allowed for code in codes) and ((status == "current" and not codes) or (
        status != "current" and bool(codes))), STRUCTURE, "/issues")


def validate_external_artifact_report(report):
    """Validate comparison evidence shape, not retrieved content authenticity.

    Invalid-status reports may preserve malformed or null evidence as required
    by the frozen contract; that does not make the evidence usable or trusted.
    """
    required = "format graphRevision artifact externalSource relation retrieval comparedAt status issues".split()
    fields(report, required, ["id"])
    require(report["format"] == "morivyx.external-artifact-report/0.1", STRUCTURE, "/format")
    if "id" in report:
        report_text(report, "id", pattern=STABLE_ID)
    status = report_text(report, "status")
    require(status in EXTERNAL_ISSUES_BY_STATUS, STRUCTURE, "/status")
    invalid = status == "invalid"
    if invalid:
        report_nullable_text(report, "graphRevision")
        report_nullable_text(report, "comparedAt")
    else:
        report_text(report, "graphRevision", pattern=GRAPH_ID)
        report_time(report, "comparedAt")
    for field in ("artifact", "externalSource", "relation"):
        validate_external_identity(report[field], "/" + field, field == "artifact", invalid)
    retrieval = report["retrieval"]
    validate_external_retrieval(retrieval, status)
    compared_at = retrieval.get("comparedAt") if type(retrieval) is dict else None
    require(report["comparedAt"] == compared_at, STRUCTURE, "/comparedAt")
    validate_external_issues(report["issues"], status)
    return report


def validate_report(report):
    """Dispatch all four logical formats; no filesystem access or trust grant."""
    validators = {
        "morivyx.trace-report/0.1": ("trace-report", validate_trace_report),
        "morivyx.semantic-diff/0.1": ("semantic-diff", validate_semantic_diff_report),
        "morivyx.migration-semantic-diff/0.1": ("migration-semantic-diff", validate_migration_semantic_diff_report),
        "morivyx.external-artifact-report/0.1": ("external-artifact-report", validate_external_artifact_report),
    }
    format_id = report.get("format") if type(report) is dict else None
    require(type(format_id) is str and format_id in validators, "REPORT_FORMAT_UNSUPPORTED", "/format")
    report_type, validate = validators[format_id]
    return {"type": report_type, "report": validate(report)}
