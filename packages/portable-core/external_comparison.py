"""Compare caller-supplied external evidence; no retrieval or authority check."""

from canonical import TIMESTAMP, canonical_json
from record_validation import GRAPH_ID
from schema_validation import DIGEST, validate_graph_element


UNSET = object()
ISSUES = ["EXTERNAL_REFERENCE_INCOMPLETE", "EXTERNAL_DIGEST_RULE_UNSUPPORTED", "EXTERNAL_SOURCE_UNAVAILABLE",
          "EXTERNAL_TARGET_MISSING", "EXTERNAL_VERSION_CHANGED", "EXTERNAL_DIGEST_CHANGED"]
RETRIEVAL_FIELDS = {"resolved": {"status", "comparedAt", "digest", "digestRule", "externalVersion"},
                    "missing": {"status", "comparedAt", "method"}, "unavailable": {"status", "comparedAt", "reason"}}


def mapping(value):
    return value if type(value) is dict else {}


def is_text(value):
    return type(value) is str and bool(value)


def matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def graph_element(value):
    try:
        validate_graph_element(value)
        return True
    except (ValueError, TypeError, RecursionError):
        return False


def identity(value, lifecycle=False):
    record = mapping(value)
    return {field: record[field] if is_text(record.get(field)) else None
            for field in (["id", "revision", "lifecycle"] if lifecycle else ["id", "revision"])}


def normalized_retrieval(value):
    if type(value) is not dict:
        return None
    return {field: value[field] if is_text(value.get(field)) else None
            for field in ["status", "comparedAt", *[key for key in ("digest", "digestRule", "externalVersion", "method", "reason") if key in value]]}


def complete_reference(artifact, external_source, relations):
    attributes, provenance = mapping(mapping(artifact).get("attributes")), mapping(mapping(artifact).get("provenance"))
    if (not graph_element(artifact) or artifact["kind"] != "entity" or artifact["type"] != "core.artifact"
            or not all(is_text(attributes.get(field)) for field in ("artifactKind", "uri"))
            or not matches(attributes.get("digest"), DIGEST) or provenance.get("method") != "imported"
            or not matches(provenance.get("retrievedAt"), TIMESTAMP) or not is_text(provenance.get("digestRule"))
            or ("externalVersion" in attributes and not is_text(attributes["externalVersion"]))):
        return False, None
    source_attributes = mapping(mapping(external_source).get("attributes"))
    if (not graph_element(external_source) or external_source["kind"] != "entity" or external_source["type"] != "core.external-source"
            or not all(is_text(source_attributes.get(field)) for field in ("system", "externalId"))
            or ("snapshotAt" in source_attributes and not matches(source_attributes["snapshotAt"], TIMESTAMP))):
        return False, None
    candidates = [relation for relation in relations if type(relation) is dict and type(relation.get("attributes")) is dict
                  and relation["attributes"].get("predicate") == "derived_from" and relation["attributes"].get("source") == artifact["id"]] if type(relations) is list else []
    if len(candidates) != 1:
        return False, None
    relation = candidates[0]
    return (graph_element(relation) and relation["kind"] == "relation" and relation["type"] == "core.derived_from"
            and relation["attributes"].get("target") == external_source["id"]), relation


def complete_retrieval(value, version):
    if type(value) is not dict or type(value.get("status")) is not str or value["status"] not in RETRIEVAL_FIELDS:
        return False
    status = value["status"]
    if not matches(value.get("comparedAt"), TIMESTAMP) or set(value) - RETRIEVAL_FIELDS[status]:
        return False
    if status in ("missing", "unavailable"):
        return is_text(value.get("method" if status == "missing" else "reason"))
    return (matches(value.get("digest"), DIGEST) and is_text(value.get("digestRule"))
            and ("externalVersion" not in value or is_text(value["externalVersion"]))
            and (version is UNSET or is_text(value.get("externalVersion"))))


def compare_external_artifact_reference(value):
    """Return one of five existing reports from logical evidence, without I/O."""
    root = mapping(value)
    try:
        canonical_json(root)
    except (ValueError, TypeError, RecursionError):
        root = {}
    artifact, source, retrieval = root.get("artifact"), root.get("externalSource"), root.get("retrieval")
    attributes, provenance = mapping(mapping(artifact).get("attributes")), mapping(mapping(artifact).get("provenance"))
    version, rule = attributes.get("externalVersion", UNSET), provenance.get("digestRule")
    complete, relation = complete_reference(artifact, source, root.get("relations"))
    codes = set()
    if not matches(root.get("graphRevision"), GRAPH_ID) or not complete or not complete_retrieval(retrieval, version):
        codes.add(ISSUES[0])
    rules = root.get("supportedDigestRules")
    if is_text(rule) and (type(rules) is not list or not all(is_text(entry) for entry in rules) or rule not in rules
                         or (mapping(retrieval).get("status") == "resolved" and is_text(mapping(retrieval).get("digestRule")) and retrieval["digestRule"] != rule)):
        codes.add(ISSUES[1])
    status = "invalid"
    if not codes:
        status = retrieval["status"]
        if status == "unavailable":
            codes.add(ISSUES[2])
        elif status == "missing":
            codes.add(ISSUES[3])
        else:
            if version is not UNSET and retrieval.get("externalVersion", UNSET) != version:
                codes.add(ISSUES[4])
            if retrieval["digest"] != attributes["digest"]:
                codes.add(ISSUES[5])
            status = "stale" if codes else "current"
    normalized = normalized_retrieval(retrieval)
    return {"format": "morivyx.external-artifact-report/0.1", "graphRevision": root["graphRevision"] if is_text(root.get("graphRevision")) else None,
            "artifact": identity(artifact, True), "externalSource": identity(source), "relation": identity(relation),
            "retrieval": normalized, "comparedAt": normalized["comparedAt"] if normalized is not None else None,
            "status": status, "issues": [{"code": code} for code in ISSUES if code in codes]}
