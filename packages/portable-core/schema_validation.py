"""Independent validators for Schema declarations and Graph element structure.

These components do not validate Graph relations, lifecycle transitions,
approvals, reports or signatures. They do not grant adoption authority.
"""

import math
from pathlib import Path
import re

from canonical import TIMESTAMP, canonical_json, digest, unicode_text
from yaml_records import read_yaml


SCHEMA_ID = re.compile(r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*")
# Preserve the frozen validator's ECMAScript whitespace class. Python's \s
# additionally matches characters such as NEL and record separators.
SPACE = r"\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
TYPE_ID = re.compile(rf"[^{SPACE}./]+(?:\.[^{SPACE}./]+)+")
EXTENSION_KEY = re.compile(rf"[^{SPACE}/]+/[^{SPACE}/]+")
STABLE_ID = re.compile(r"urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SCHEMA_FIELDS = set("format schemaId version stableIdScheme digestAlgorithm reviewStates entityTypes relationTypes authoringOrders".split())
ELEMENT_FIELDS = set("format kind id type typeVersion revision lifecycle reviewState attributes provenance extensions".split())
CORE_DIGEST = "sha256:f3bfeb8caaaf7ef46c847dd23c16845fedf6cd1c4547e75bd607961c995c90da"


class ValidationError(ValueError):
    def __init__(self, code, path):
        self.code, self.path = code, path
        super().__init__(code + ": " + path)


def pointer(path, field):
    return path + "/" + str(field).replace("~", "~0").replace("/", "~1")


def require(condition, code, path):
    if not condition:
        raise ValidationError(code, path)


def text(value, code, path, pattern=None):
    require(type(value) is str and bool(value), code, path)
    try:
        unicode_text(value)
    except ValueError:
        raise ValidationError(code, path) from None
    if pattern is not None:
        require(pattern.fullmatch(value) is not None, code, path)


def mapping(value, code, path, allowed=None):
    require(type(value) is dict, code, path)
    if allowed is not None:
        for key in value:
            require(type(key) is str and key in allowed, code, pointer(path, key))


def string_set(value, code, path, nonempty=False, pattern=None):
    require(type(value) is list and (not nonempty or bool(value)), code, path)
    previous = None
    for index, item in enumerate(value):
        child = pointer(path, index)
        text(item, code, child, pattern)
        normalized = unicode_text(item)
        require(previous is None or previous < normalized, code, child)
        previous = normalized


def safe_integer(value):
    return type(value) in (int, float) and abs(value) <= 9007199254740991 and (
        type(value) is int or (math.isfinite(value) and value.is_integer())
    )


def validate_schema_definition(definition):
    code = "SCHEMA_DEFINITION_INVALID"
    mapping(definition, code, "", SCHEMA_FIELDS)
    require(definition.get("format") == "morivyx.schema/0.1", code, "/format")
    text(definition.get("schemaId"), code, "/schemaId", SCHEMA_ID)
    text(definition.get("version"), code, "/version", VERSION)
    require(definition.get("stableIdScheme") == "urn-uuid-v4", code, "/stableIdScheme")
    require(definition.get("digestAlgorithm") == "sha256", code, "/digestAlgorithm")
    string_set(definition.get("reviewStates"), code, "/reviewStates", nonempty=True)
    for field, identity in [("entityTypes", "typeId"), ("relationTypes", "predicate")]:
        entries = definition.get(field)
        require(type(entries) is list, code, "/" + field)
        previous = None
        for index, entry in enumerate(entries):
            path = pointer("/" + field, index)
            allowed = set("typeId requiredAttributes optionalAttributes lifecycle".split()) if field == "entityTypes" else set(
                "predicate sourceTypes targetTypes minCount maxCount cycle".split())
            mapping(entry, code, path, allowed)
            text(entry.get(identity), code, pointer(path, identity), TYPE_ID if field == "entityTypes" else None)
            if field == "entityTypes":
                string_set(entry.get("requiredAttributes"), code, pointer(path, "requiredAttributes"))
                if "optionalAttributes" in entry:
                    string_set(entry["optionalAttributes"], code, pointer(path, "optionalAttributes"), nonempty=True)
                    required = {unicode_text(v) for v in entry["requiredAttributes"]}
                    for item_index, item in enumerate(entry["optionalAttributes"]):
                        require(unicode_text(item) not in required, code, pointer(pointer(path, "optionalAttributes"), item_index))
                string_set(entry.get("lifecycle"), code, pointer(path, "lifecycle"), nonempty=True)
            else:
                for endpoint in ("sourceTypes", "targetTypes"):
                    string_set(entry.get(endpoint), code, pointer(path, endpoint), nonempty=True, pattern=TYPE_ID)
                minimum, maximum = entry.get("minCount"), entry.get("maxCount")
                require(safe_integer(minimum) and minimum >= 0, code, pointer(path, "minCount"))
                require("maxCount" in entry and (maximum is None or (
                    safe_integer(maximum) and maximum >= minimum)), code, pointer(path, "maxCount"))
                require(entry.get("cycle") in ("allowed", "forbidden", "not_applicable"), code, pointer(path, "cycle"))
            current = unicode_text(entry[identity])
            require(previous is None or previous < current, code, pointer(path, identity))
            previous = current
    orders = definition.get("authoringOrders")
    mapping(orders, code, "/authoringOrders", {"root", "attributes", "provenance"})
    for field in ("root", "attributes", "provenance"):
        path = pointer("/authoringOrders", field)
        values = orders.get(field)
        require(type(values) is list and (field == "attributes" or bool(values)), code, path)
        seen = set()
        for index, item in enumerate(values):
            child = pointer(path, index)
            text(item, code, child)
            normalized = unicode_text(item)
            require(normalized not in seen, code, child)
            seen.add(normalized)
    return definition


def validate_graph_element(element):
    code = "GRAPH_ELEMENT_INVALID"
    mapping(element, code, "", ELEMENT_FIELDS)
    require(element.get("format") == "morivyx.git-graph/0.1", code, "/format")
    require(element.get("kind") in ("entity", "relation"), code, "/kind")
    text(element.get("id"), code, "/id", STABLE_ID)
    text(element.get("type"), code, "/type", TYPE_ID)
    for field in ("typeVersion", "lifecycle"):
        text(element.get(field), code, pointer("", field))
    text(element.get("revision"), code, "/revision", DIGEST)
    require(element.get("reviewState") in ("unreviewed", "proposed", "approved", "rejected"), code, "/reviewState")
    mapping(element.get("attributes"), code, "/attributes")
    provenance = element.get("provenance")
    mapping(provenance, code, "/provenance")
    text(provenance.get("method"), code, "/provenance/method")
    text(provenance.get("actor"), code, "/provenance/actor", STABLE_ID)
    recorded = provenance.get("recordedAt")
    text(recorded, code, "/provenance/recordedAt", TIMESTAMP)
    try:
        canonical_json(recorded)
    except ValueError:
        raise ValidationError(code, "/provenance/recordedAt") from None
    if "extensions" in element:
        mapping(element["extensions"], code, "/extensions")
        for key in element["extensions"]:
            text(key, code, pointer("/extensions", key), EXTENSION_KEY)
    return element


def load_core_schema():
    """Load the bundled, digest-pinned Core declaration without product code."""
    path = Path(__file__).with_name("core-schema.yaml")
    with path.open("rb") as stream:
        source = stream.read(8 * 1024 * 1024 + 1)
    schema = read_yaml(source)
    validate_schema_definition(schema)
    if digest("schema", schema)["digest"] != CORE_DIGEST:
        raise ValidationError("SCHEMA_DEFINITION_DIGEST_MISMATCH", "/core-schema.yaml")
    return schema
