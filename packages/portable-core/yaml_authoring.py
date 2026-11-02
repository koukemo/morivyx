"""Authoring policies over the bounded YAML syntax; no structural/Graph verdict."""

import re

from schema_validation import ValidationError
from yaml_records import ORDERS, field_order, read_yaml


ROOT_ORDERS = {key: value.split() for key, value in ORDERS.items()}
ROOT_ORDERS.update({
    "morivyx.schema/0.1": "format schemaId version stableIdScheme digestAlgorithm reviewStates entityTypes relationTypes authoringOrders".split(),
    "morivyx.decision-creation-request/0.1": "format decisionId attributes changeSetId resultingRevision actor recordedAt".split(),
    "morivyx.decision-revision-request/0.1": "format decisionId attributes changeSetId resultingRevision actor recordedAt".split(),
})


def child(path, key):
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def known_order(value, order, path, prefixed=False):
    if type(value) is not dict:
        return
    positions = {key: index for index, key in enumerate(order)}
    previous, unknown, extra = -1, None, False
    for key in value:
        if key in positions:
            position = positions[key]
            if position <= previous or (prefixed and extra):
                raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
            previous = position
        elif prefixed:
            if unknown is not None and unknown >= key:
                raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
            unknown, extra = key, True


def sorted_map(value, path, recursive=False):
    if type(value) is list and recursive:
        for index, entry in enumerate(value):
            sorted_map(entry, child(path, index), True)
    if type(value) is not dict:
        return
    previous = None
    for key, entry in value.items():
        if previous is not None and previous >= key:
            raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
        previous = key
    if recursive:
        for key, entry in value.items():
            sorted_map(entry, child(path, key), True)


def sequence_order(root, key, order, path=""):
    if type(root) is not dict or type(root.get(key)) is not list:
        return
    for index, entry in enumerate(root[key]):
        known_order(entry, order, child(child(path, key), index))


def authoring_order(record, format_id):
    known_order(record, ROOT_ORDERS[format_id], "")
    if format_id in ("morivyx.git-graph/0.1", "morivyx.decision-creation-request/0.1", "morivyx.decision-revision-request/0.1"):
        sorted_map(record.get("attributes"), "/attributes")
    if format_id in ("morivyx.git-graph/0.1", "morivyx.changeset/0.1", "morivyx.migration/0.1"):
        known_order(record.get("provenance"), "method actor recordedAt".split(), "/provenance", True)
    if format_id == "morivyx.git-graph/0.1":
        sorted_map(record.get("extensions"), "/extensions", True)
    if format_id == "morivyx.schema-lock/0.1":
        sequence_order(record, "schemas", field_order(format_id, ("schemas", "*")))
    if format_id == "morivyx.changeset/0.1":
        sequence_order(record, "operations", field_order(format_id, ("operations", "*")))
    if format_id == "morivyx.trace-report/0.1":
        sequence_order(record, "paths", ["hops"])
        if type(record.get("paths")) is list:
            for index, entry in enumerate(record["paths"]):
                sequence_order(entry, "hops", field_order(format_id, ("paths", "*", "hops", "*")), child("/paths", index))
    if format_id in ("morivyx.semantic-diff/0.1", "morivyx.migration-semantic-diff/0.1"):
        sequence_order(record, "entries", field_order(format_id, ("entries", "*")))
    if format_id == "morivyx.external-artifact-report/0.1":
        for key in ("artifact", "externalSource", "relation", "retrieval"):
            known_order(record.get(key), field_order(format_id, (key,)), child("", key))
        sequence_order(record, "issues", ["code"])
    if format_id == "morivyx.schema/0.1":
        sequence_order(record, "entityTypes", "typeId requiredAttributes optionalAttributes lifecycle".split())
        sequence_order(record, "relationTypes", "predicate sourceTypes targetTypes minCount maxCount cycle".split())
        known_order(record.get("authoringOrders"), "root attributes provenance".split(), "/authoringOrders")


def null_allowed(format_id, path, status):
    if format_id == "morivyx.graph-revision/0.1":
        return path == "/parentRevision"
    if format_id == "morivyx.schema/0.1":
        return re.fullmatch(r"/relationTypes/[0-9]+/maxCount", path) is not None
    if format_id == "morivyx.git-graph/0.1":
        return path.startswith("/extensions/")
    if format_id == "morivyx.external-artifact-report/0.1" and status == "invalid":
        return path in ("/graphRevision", "/retrieval", "/comparedAt", "/artifact/lifecycle") or re.fullmatch(
            r"/(?:artifact|externalSource|relation)/(?:id|revision)|/retrieval/(?:status|comparedAt|digest|digestRule|externalVersion|method|reason)", path) is not None
    return False


def null_policy(value, format_id, status, path=""):
    if value is None and not null_allowed(format_id, path, status):
        raise ValidationError("PACKAGE_NULL_INVALID", path)
    if type(value) is dict:
        for key, entry in value.items():
            null_policy(entry, format_id, status, child(path, key))
    elif type(value) is list:
        for index, entry in enumerate(value):
            null_policy(entry, format_id, status, child(path, index))


def string_set(value, path):
    if type(value) is not list:
        return
    previous = None
    for index, entry in enumerate(value):
        if type(entry) is not str:
            continue
        if previous is not None and previous >= entry:
            raise ValidationError("PACKAGE_SET_ORDER_INVALID", child(path, index))
        previous = entry


def map_set(value, identity, nested, path):
    if type(value) is not list:
        return
    previous = None
    for index, entry in enumerate(value):
        if type(entry) is not dict:
            continue
        location = child(path, index)
        current = entry.get(identity)
        if type(current) is str:
            if previous is not None and previous >= current:
                raise ValidationError("PACKAGE_SET_ORDER_INVALID", child(location, identity))
            previous = current
        for key in nested:
            string_set(entry.get(key), child(location, key))


def read_authoring_yaml(source):
    """Read supported block syntax and check authoring policies for known formats.

    Missing fields, unknown keys and incorrect semantic types belong to record
    validators. Unknown formats receive only the bounded syntax checks.
    """
    record = read_yaml(source)
    format_id = record.get("format")
    if type(format_id) is not str or format_id not in ROOT_ORDERS:
        return record
    authoring_order(record, format_id)
    null_policy(record, format_id, record.get("status"))
    if format_id == "morivyx.trace-report/0.1":
        string_set(record.get("missing"), "/missing")
    elif format_id == "morivyx.schema/0.1":
        string_set(record.get("reviewStates"), "/reviewStates")
        map_set(record.get("entityTypes"), "typeId", ("requiredAttributes", "optionalAttributes", "lifecycle"), "/entityTypes")
        map_set(record.get("relationTypes"), "predicate", ("sourceTypes", "targetTypes"), "/relationTypes")
    return record
