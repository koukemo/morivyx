"""Rebuild in-memory indexes; verification compares only their projection."""

import copy

from canonical import canonical_json, digest, unicode_text
from record_validation import GRAPH_ID, text
from schema_validation import STABLE_ID, ValidationError, validate_graph_element


INPUT = "INDEX_SOURCE_INVALID"


def fail(path):
    raise ValidationError(INPUT, path)


def append(index, key, identity):
    index.setdefault(unicode_text(key), []).append(unicode_text(identity))


def sorted_lists(index):
    return {key: sorted(set(values)) for key, values in sorted(index.items())}


def build_graph_index(value):
    """Check structure and body revisions, then derive maps without persistence."""
    value = value if type(value) is dict else {}
    text(value.get("graphRevision"), INPUT, "/graphRevision", GRAPH_ID)
    elements = value.get("elements")
    if type(elements) is not list:
        fail("/elements")
    for position, element in enumerate(elements):
        path = "/elements/" + str(position)
        try:
            validate_graph_element(element)
        except ValidationError as error:
            fail(path + error.path)
        try:
            revision = digest("revision", element)["digest"]
        except (ValueError, TypeError, RecursionError):
            fail(path)
        if element["revision"] != revision:
            fail(path + "/revision")
    by_id, by_type, outgoing, incoming = {}, {}, {}, {}
    ordered = sorted(enumerate(elements), key=lambda pair: pair[1]["id"])
    for position, element in ordered:
        identity = unicode_text(element["id"])
        if identity in by_id:
            fail("/elements/" + str(position) + "/id")
        by_id[identity] = copy.deepcopy(element)
        append(by_type, element["type"], identity)
    for position, element in ordered:
        if element["kind"] != "relation":
            continue
        attributes = element["attributes"]
        for field in ("source", "target"):
            endpoint = attributes.get(field)
            if type(endpoint) is not str or STABLE_ID.fullmatch(endpoint) is None or unicode_text(endpoint) not in by_id:
                fail("/elements/" + str(position) + "/attributes/" + field)
        append(outgoing, attributes["source"], element["id"])
        append(incoming, attributes["target"], element["id"])
    return {"graphRevision": unicode_text(value["graphRevision"]), "rootDigest": digest("root", elements)["digest"],
            "byId": by_id, "byType": sorted_lists(by_type), "outgoing": sorted_lists(outgoing), "incoming": sorted_lists(incoming)}


def graph_index_snapshot(index):
    """Return the existing ordered projection, excluding cached element bodies."""
    return {"graphRevision": index["graphRevision"], "rootDigest": index["rootDigest"],
            "elements": [{"id": identity, **{field: element[field] for field in ("kind", "type", "revision")}}
                         for identity, element in index["byId"].items()],
            "types": [{"type": type_id, "elementIds": list(identities)} for type_id, identities in index["byType"].items()],
            "outgoing": [{"sourceId": identity, "relationIds": list(identities)} for identity, identities in index["outgoing"].items()],
            "incoming": [{"targetId": identity, "relationIds": list(identities)} for identity, identities in index["incoming"].items()]}


def verify_graph_index(index, source):
    """Compare index projections; valid here is not whole-package validation."""
    expected = build_graph_index(source)
    try:
        valid = canonical_json(graph_index_snapshot(index)) == canonical_json(graph_index_snapshot(expected))
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        valid = False
    return {"valid": valid, "graphRevision": expected["graphRevision"], "rootDigest": expected["rootDigest"]}


async def rebuild_package_index(path):
    """Read a package and return an index projection without persisting it."""
    from package_records import _read_package_api
    package = await _read_package_api(path)
    elements = package["elements"]
    identities = {unicode_text(element["id"]) for element in elements}
    by_type, outgoing, incoming = {}, {}, {}
    for position, element in enumerate(elements):
        append(by_type, element["type"], element["id"])
        if element["kind"] != "relation":
            continue
        for field in ("source", "target"):
            endpoint = element["attributes"].get(field)
            if type(endpoint) is not str or STABLE_ID.fullmatch(endpoint) is None or unicode_text(endpoint) not in identities:
                fail("/elements/" + str(position) + "/attributes/" + field)
        append(outgoing, element["attributes"]["source"], element["id"])
        append(incoming, element["attributes"]["target"], element["id"])
    return {"valid": True, "index": {
        "graphRevision": unicode_text(package["revision"]["id"]), "rootDigest": package["calculatedRootDigest"],
        "elements": [{field: element[field] for field in ("id", "kind", "type", "revision")} for element in elements],
        "types": [{"type": key, "elementIds": values} for key, values in sorted_lists(by_type).items()],
        "outgoing": [{"sourceId": key, "relationIds": values} for key, values in sorted_lists(outgoing).items()],
        "incoming": [{"targetId": key, "relationIds": values} for key, values in sorted_lists(incoming).items()]}}
