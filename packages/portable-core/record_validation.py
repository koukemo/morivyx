"""Independent structure checks for package headers and proposed changes."""

import math
import re

from canonical import TIMESTAMP, canonical_json, unicode_text
from schema_validation import DIGEST, SPACE, STABLE_ID, ValidationError, pointer, require


GRAPH_ID = re.compile(rf"graph:[^{SPACE}]+")
OPERATION_RULES = {
    "create": (["afterRevision"], ["beforeRevision", "replacementId"]),
    "revise": (["beforeRevision", "afterRevision"], ["replacementId"]),
    "retire": (["beforeRevision"], ["afterRevision", "replacementId"]),
    "replace": (["beforeRevision", "afterRevision", "replacementId"], []),
    "revoke": ([], ["beforeRevision", "afterRevision", "replacementId"]),
}


def mapping(value, fields, code, path=""):
    require(type(value) is dict, code, path)
    if fields is not None:
        for key in value:
            require(key in fields, code, pointer(path, key))


def text(value, code, path, pattern=None):
    require(type(value) is str and bool(value), code, path)
    if pattern is not None:
        require(pattern.fullmatch(value) is not None, code, path)


def timestamp(value, code, path):
    text(value, code, path, TIMESTAMP)
    try:
        canonical_json(value)
    except ValueError:
        raise ValidationError(code, path) from None


def validate_schema_lock(lock):
    code = "SCHEMA_LOCK_INVALID"
    mapping(lock, {"format", "stableIdScheme", "digestAlgorithm", "schemas"}, code)
    require(lock.get("format") == "morivyx.schema-lock/0.1", "PACKAGE_FORMAT_UNSUPPORTED", "/format")
    require(lock.get("stableIdScheme") == "urn-uuid-v4", "STABLE_ID_SCHEME_UNSUPPORTED", "/stableIdScheme")
    require(lock.get("digestAlgorithm") == "sha256", "DIGEST_ALGORITHM_UNSUPPORTED", "/digestAlgorithm")
    require(type(lock.get("schemas")) is list, code, "/schemas")
    previous = None
    for index, entry in enumerate(lock["schemas"]):
        path = "/schemas/" + str(index)
        mapping(entry, {"schemaId", "version", "digest"}, code, path)
        for field in ("schemaId", "version", "digest"):
            text(entry.get(field), code, pointer(path, field), DIGEST if field == "digest" else None)
        current = tuple(unicode_text(entry[field]) for field in ("schemaId", "version"))
        require(previous is None or previous < current, "SCHEMA_LOCK_ORDER_INVALID", path)
        previous = current
    return lock


def _revision_keys(value):
    indices = sorted((key for key in value if type(key) is str and len(key) <= 10 and
                      re.fullmatch(r"(?:0|[1-9][0-9]*)", key) and int(key) < 4294967295), key=int)
    indexed = set(indices)
    return (*indices, *(key for key in value if key not in indexed))


def _revision_truthy(value):
    if value is None or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and not (type(value) is float and math.isnan(value))
    return type(value) is not str or bool(value)


def _revision_number_text(value):
    """Render binary64 path values with the source runtime's decimal thresholds."""
    try:
        value = float(value)
    except OverflowError:
        value = math.inf if value > 0 else -math.inf
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    value = abs(value)
    source = repr(value).lower()
    mantissa, exponent = source.split("e") if "e" in source else (source, "0")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).rstrip("0")
    position = len(whole) + int(exponent)
    if 1e-6 <= value < 1e21:
        if position <= 0:
            return sign + "0." + "0" * -position + digits
        if position >= len(digits):
            return sign + digits + "0" * (position - len(digits))
        return sign + digits[:position] + "." + digits[position:]
    power = position - 1
    return sign + digits[0] + ("." + digits[1:] if len(digits) > 1 else "") + "e" + ("+" if power >= 0 else "-") + str(abs(power))


def _revision_path_text(value):
    if type(value) is str:
        return value
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        return _revision_number_text(value)
    if type(value) is list:
        return ",".join("" if child is None else _revision_path_text(child) for child in value)
    if type(value) is dict and "toString" not in value:
        return "[object Object]"
    # A JSON data property cannot be called as Object.prototype.toString.
    # Do not inspect attributes or invoke conversion methods on host objects.
    raise TypeError("Cannot convert the source path to a primitive value")


def validate_graph_revision(revision, file_path=""):
    """Return the unchanged record; attach an optional raw source path to diagnostics."""
    code = "GRAPH_REVISION_INVALID"
    try:
        mapping(revision, None, code)
        fields = {"format", "id", "parentRevision", "rootDigest", "schemaLockDigest"}
        for key in _revision_keys(revision):
            require(key in fields, code, pointer("", key))
        require(revision.get("format") == "morivyx.graph-revision/0.1", code, "/format")
        text(revision.get("id"), code, "/id", GRAPH_ID)
        require("parentRevision" in revision, code, "/parentRevision")
        if revision["parentRevision"] is not None:
            text(revision["parentRevision"], code, "/parentRevision", GRAPH_ID)
            require(revision["parentRevision"] != revision["id"], code, "/parentRevision")
        for field in ("rootDigest", "schemaLockDigest"):
            text(revision.get(field), code, pointer("", field), DIGEST)
    except ValidationError as error:
        if _revision_truthy(file_path):
            error.path = _revision_path_text(file_path) + "#" + error.path if error.path else file_path
            error.args = (code + ": " + error.path,) if type(error.path) is str else (code,)
        raise
    return revision


def validate_change_set(change_set):
    code = "CHANGESET_INVALID"
    mapping(change_set, set("format id baseRevision resultingRevision resultingRootDigest schemaLockDigest operations provenance recordedAt".split()), code)
    require(change_set.get("format") == "morivyx.changeset/0.1", code, "/format")
    for field, pattern in [("id", STABLE_ID), ("baseRevision", GRAPH_ID), ("resultingRevision", GRAPH_ID),
                           ("resultingRootDigest", DIGEST), ("schemaLockDigest", DIGEST)]:
        text(change_set.get(field), code, pointer("", field), pattern)
    operations = change_set.get("operations")
    require(type(operations) is list and bool(operations), code, "/operations")
    for index, operation in enumerate(operations):
        path = "/operations/" + str(index)
        mapping(operation, {"op", "targetId", "beforeRevision", "afterRevision", "replacementId"}, code, path)
        name = operation.get("op")
        require(type(name) is str and name in OPERATION_RULES, code, path + "/op")
        required, forbidden = OPERATION_RULES[name]
        text(operation.get("targetId"), code, path + "/targetId", STABLE_ID)
        for field in required:
            require(field in operation, code, pointer(path, field))
        for field in forbidden:
            require(field not in operation, code, pointer(path, field))
        for field in ("beforeRevision", "afterRevision", "replacementId"):
            if field in operation:
                text(operation[field], code, pointer(path, field), STABLE_ID if field == "replacementId" else DIGEST)
        if "replacementId" in operation:
            require(operation["replacementId"] != operation["targetId"], code, path + "/replacementId")
    require(not any(op["op"] == "revoke" for op in operations) or len(operations) == 1, code, "/operations")
    provenance = change_set.get("provenance")
    mapping(provenance, None, code, "/provenance")
    text(provenance.get("method"), code, "/provenance/method")
    text(provenance.get("actor"), code, "/provenance/actor", STABLE_ID)
    timestamp(provenance.get("recordedAt"), code, "/provenance/recordedAt")
    timestamp(change_set.get("recordedAt"), code, "/recordedAt")
    return change_set
