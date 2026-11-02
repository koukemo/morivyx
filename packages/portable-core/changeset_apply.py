"""Apply existing ChangeSet operations to logical values, without persistence.

This checks structure, revision boundaries and digests, not Schema/Graph meaning,
adoption authority, signatures or identity. Returned values are independent copies.
"""

from copy import deepcopy

from canonical import digest
from record_validation import validate_change_set, validate_graph_revision
from schema_validation import STABLE_ID, ValidationError, validate_graph_element


UNSET = object()


def fail(code, path):
    raise ValidationError(code, path)


def revision_record(value, path, code):
    try:
        validate_graph_revision(value)
    except ValidationError as error:
        fail(code, path + error.path)


def stable_ids(values, path):
    if type(values) is not list:
        fail("CHANGESET_APPLY_INVALID", path)
    result = set()
    for index, value in enumerate(values):
        if type(value) is not str or not STABLE_ID.fullmatch(value) or value in result:
            fail("CHANGESET_APPLY_INVALID", path + "/" + str(index))
        result.add(value)
    return result


def element_map(values, name, candidates=False):
    if type(values) is not list:
        fail("CHANGESET_APPLY_INVALID", "/" + name)
    result = {}
    for index, value in enumerate(values):
        path = "/" + name + "/" + str(index)
        if type(value) is not dict or any(type(value.get(key)) is not str for key in ("id", "revision")):
            fail("CHANGESET_APPLY_INVALID", path)
        try:
            validate_graph_element(value)
        except ValidationError as error:
            fail("CHANGESET_APPLY_INVALID", path + error.path)
        if digest("revision", value)["digest"] != value["revision"]:
            fail("CHANGESET_CANDIDATE_REVISION_MISMATCH" if candidates else "CHANGESET_APPLY_INVALID", path + "/revision")
        key = (value["id"], value["revision"]) if candidates else value["id"]
        if key in result:
            fail("CHANGESET_APPLY_INVALID", path if candidates else path + "/id")
        result[key] = (deepcopy(value), index) if candidates else deepcopy(value)
    return result


def apply_change_set(value):
    """Return elements, resulting revision and root digest; never mutate input."""
    value = value if type(value) is dict else {}
    change_set = value.get("changeSet")
    validate_change_set(change_set)
    elements = element_map(value.get("currentElements"), "currentElements")
    current = value.get("currentRevision")
    if type(current) not in (dict, list):
        fail("CHANGESET_APPLY_INVALID", "/currentRevision")
    revision_record(current, "/currentRevision", "CHANGESET_APPLY_INVALID")
    if current["id"] != change_set["baseRevision"]:
        fail("CHANGESET_BASE_REVISION_MISMATCH", "/baseRevision")
    lock = value.get("schemaLockDigest", UNSET)
    source_lock = value.get("sourceSchemaLockDigest", lock)
    target_lock = value.get("targetSchemaLockDigest", lock)
    if current["schemaLockDigest"] != source_lock or change_set["schemaLockDigest"] != target_lock:
        fail("CHANGESET_SCHEMA_LOCK_MISMATCH", "/schemaLockDigest")
    if digest("root", list(elements.values()))["digest"] != current["rootDigest"]:
        fail("CHANGESET_APPLY_INVALID", "/currentRevision/rootDigest")
    candidates = element_map(value.get("candidateElements", []), "candidateElements", True)
    consumed = set()

    def take(identity, revision, path):
        candidate = candidates.get((identity, revision))
        if candidate is None:
            fail("CHANGESET_PRECONDITION_FAILED", path + "/afterRevision")
        element, index = candidate
        consumed.add(index)
        return deepcopy(element)

    operations = change_set["operations"]
    if operations[0]["op"] == "revoke":
        known = stable_ids(value.get("knownChangeSetIds", []), "/knownChangeSetIds")
        applied = stable_ids(value.get("appliedChangeSetIds", []), "/appliedChangeSetIds")
        target = operations[0]["targetId"]
        if target == change_set["id"] or target not in known or target in applied:
            fail("CHANGESET_REVOKE_INVALID", "/operations/0/targetId")
    else:
        for index, operation in enumerate(operations):
            path = "/operations/" + str(index)
            identity, name = operation["targetId"], operation["op"]
            if name == "create":
                if identity in elements:
                    fail("CHANGESET_PRECONDITION_FAILED", path + "/targetId")
                elements[identity] = take(identity, operation["afterRevision"], path)
                continue
            if identity not in elements:
                fail("CHANGESET_PRECONDITION_FAILED", path + "/targetId")
            if elements[identity]["revision"] != operation["beforeRevision"]:
                fail("CHANGESET_PRECONDITION_FAILED", path + "/beforeRevision")
            if name == "revise":
                elements[identity] = take(identity, operation["afterRevision"], path)
            elif name == "retire":
                del elements[identity]
            elif name == "replace":
                replacement = operation["replacementId"]
                if replacement in elements:
                    fail("CHANGESET_PRECONDITION_FAILED", path + "/replacementId")
                candidate = take(replacement, operation["afterRevision"], path)
                del elements[identity]
                elements[replacement] = candidate
    for _element, index in candidates.values():
        if index not in consumed:
            fail("CHANGESET_PRECONDITION_FAILED", "/candidateElements/" + str(index))
    resulting_elements = sorted(elements.values(), key=lambda element: element["id"])
    root = digest("root", resulting_elements)["digest"]
    if root != change_set["resultingRootDigest"]:
        fail("CHANGESET_RESULT_MISMATCH", "/resultingRootDigest")
    resulting = value.get("resultingRevision")
    if type(resulting) not in (dict, list):
        fail("CHANGESET_RESULT_MISMATCH", "/resultingRevisionRecord")
    expected = {"format": "morivyx.graph-revision/0.1", "id": change_set["resultingRevision"],
                "parentRevision": change_set["baseRevision"], "rootDigest": root, "schemaLockDigest": target_lock}
    for field, entry in expected.items():
        if type(resulting) is not dict or resulting.get(field, UNSET) != entry:
            fail("CHANGESET_RESULT_MISMATCH", "/resultingRevisionRecord/" + field)
    revision_record(resulting, "/resultingRevisionRecord", "CHANGESET_RESULT_MISMATCH")
    return {"elements": deepcopy(resulting_elements), "revision": deepcopy(resulting), "rootDigest": root}
