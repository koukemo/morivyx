"""Prepare existing Decision creation/revision records without persisting them.

The pure functions accept already checked logical package contents. The CLI
reads bounded file mappings with the existing Python package reader. Neither
preparation nor that reader authenticates actors or authorizes adoption.
"""

import copy
import json
import sys

from canonical import canonical_json, digest, load_json
from package_records import read_package_files
from record_validation import GRAPH_ID, timestamp, validate_change_set, validate_graph_revision
from schema_validation import STABLE_ID, ValidationError, validate_graph_element
from stdin_transport import read_bounded_stdin

LIMIT = 8 * 1024 * 1024
FIELDS = {"format", "decisionId", "attributes", "changeSetId", "resultingRevision", "actor", "recordedAt"}


def require(condition, code, path):
    if not condition:
        raise ValidationError(code, path)


def validate_request(request, operation):
    code = "DECISION_" + operation + "_REQUEST_INVALID"
    require(type(request) is dict, code, "")
    for field in request:
        require(field in FIELDS, code, "/" + field.replace("~", "~0").replace("/", "~1"))
    kind = "creation" if operation == "CREATION" else "revision"
    require(request.get("format") == "morivyx.decision-" + kind + "-request/0.1", code, "/format")
    def text(field, pattern):
        value = request.get(field)
        require(type(value) is str and pattern.fullmatch(value) is not None, code, "/" + field)
    text("decisionId", STABLE_ID)
    require(type(request.get("attributes")) is dict, code, "/attributes")
    try:
        canonical_json(request["attributes"])
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValidationError(code, "/attributes") from None
    text("changeSetId", STABLE_ID)
    require(request["changeSetId"] != request["decisionId"], code, "/changeSetId")
    text("resultingRevision", GRAPH_ID)
    text("actor", STABLE_ID)
    timestamp(request.get("recordedAt"), code, "/recordedAt")
    return request


def package_records(contents):
    result = []
    for field in ("elements", "approvals", "changeSets", "migrations"):
        if type(contents.get(field)) is list:
            result.extend(contents[field])
    for entry in contents.get("reports", []) if type(contents.get("reports")) is list else []:
        nested = entry.get("report") if type(entry) is dict else None
        result.append(nested if nested is not None else entry)
    return result


def checked(validator, value, path):
    try:
        validator(value)
    except ValidationError as error:
        raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None


def prepare(contents, request, operation, *, _clone=copy.deepcopy):
    validate_request(request, operation)
    prefix = "DECISION_" + operation + "_"
    require(type(contents) is dict and type(contents.get("elements")) is list, prefix + "PACKAGE_INVALID", "/package")
    elements = contents["elements"]
    records = package_records(contents)
    if operation == "CREATION":
        require(not any(type(record) is dict and record.get("id") == request["decisionId"] for record in records), prefix + "ID_EXISTS", "/decisionId")
    else:
        decision = next((entry for entry in elements if entry.get("id") == request["decisionId"]), None)
        require(decision is not None, prefix + "TARGET_MISSING", "/decisionId")
        require(decision["kind"] == "entity" and decision["type"] == "core.decision", prefix + "TARGET_INVALID", "/decisionId")
        require(decision["lifecycle"] in ("draft", "active"), prefix + "LIFECYCLE_INVALID", "/decisionId")
    require(not any(type(record) is dict and record.get("id") == request["changeSetId"] for record in records), prefix + "CHANGESET_ID_EXISTS", "/changeSetId")
    require(request["resultingRevision"] != contents["revision"]["id"], prefix + "RESULT_INVALID", "/resultingRevision")
    provenance = {"method": "asserted", "actor": request["actor"], "recordedAt": request["recordedAt"]}
    if operation == "CREATION":
        lock = contents.get("schemaLock")
        schemas = lock.get("schemas") if type(lock) is dict else None
        schema = next((entry for entry in schemas if entry.get("schemaId") == "morivyx.core"), None) if type(schemas) is list else None
        require(schema is not None, prefix + "SCHEMA_MISSING", "/package/schema.lock.yaml#/schemas")
        candidate = {"format": "morivyx.git-graph/0.1", "kind": "entity", "id": request["decisionId"], "type": "core.decision",
                     "typeVersion": schema["version"], "lifecycle": "draft", "reviewState": "unreviewed"}
    else:
        candidate = _clone(decision)
    candidate["attributes"] = _clone(request["attributes"])
    candidate["reviewState"] = "unreviewed"
    candidate["provenance"] = _clone(provenance)
    candidate["revision"] = digest("revision", candidate)["digest"]
    checked(validate_graph_element, candidate, "/candidateElement")
    resulting_elements = elements + [candidate] if operation == "CREATION" else [candidate if entry["id"] == candidate["id"] else entry for entry in elements]
    root = digest("root", resulting_elements)["digest"]
    change = {"op": "create" if operation == "CREATION" else "revise", "targetId": candidate["id"]}
    if operation == "REVISION":
        change["beforeRevision"] = decision["revision"]
    change["afterRevision"] = candidate["revision"]
    change_set = {"format": "morivyx.changeset/0.1", "id": request["changeSetId"], "baseRevision": contents["revision"]["id"],
                  "resultingRevision": request["resultingRevision"], "resultingRootDigest": root, "schemaLockDigest": contents["calculatedSchemaLockDigest"],
                  "operations": [change], "provenance": provenance, "recordedAt": request["recordedAt"]}
    revision = {"format": "morivyx.graph-revision/0.1", "id": request["resultingRevision"], "parentRevision": contents["revision"]["id"],
                "rootDigest": root, "schemaLockDigest": contents["calculatedSchemaLockDigest"]}
    checked(validate_change_set, change_set, "/changeSet")
    checked(validate_graph_revision, revision, "/resultingRevision")
    return {"candidateElement": candidate, "changeSet": change_set, "resultingRevision": revision}


def prepare_decision_creation(contents, request):
    return prepare(contents, request, "CREATION")


def prepare_decision_revision(contents, request):
    return prepare(contents, request, "REVISION")


def _decision_clone(value):
    """Copy JSON-visible values with heap frames, retaining spelling and order.

    This helper belongs to the separate file API. Legacy preparation retains
    its deepcopy behavior and the bounded CLI retains its transport limits.
    """
    if type(value) not in (dict, list):
        return value
    result = {} if type(value) is dict else []
    pending = [(value, result)]
    while pending:
        source, target = pending.pop()
        entries = source.items() if type(source) is dict else enumerate(source)
        for key, item in entries:
            copied = ({} if type(item) is dict else []) if type(item) in (dict, list) else item
            if type(target) is dict:
                target[key] = copied
            else:
                target.append(copied)
            if type(item) in (dict, list):
                pending.append((item, copied))
    return result


def _decision_truth(value):
    from record_validation import _revision_truthy
    return _revision_truthy(value)


def _decision_text(value):
    """Diagnostic String coercion for JSON-visible requestPath values."""
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        from record_validation import _revision_number_text
        return _revision_number_text(value)
    if type(value) is dict:
        if "toString" in value:
            raise TypeError("Cannot convert object to primitive value")
        return "[object Object]"
    if type(value) is list:
        return ",".join("" if item is None else _decision_text(item) for item in value)
    return str(value)


def _decision_validate(request, operation, request_path):
    from record_validation import _revision_keys
    try:
        ordered = {key: request[key] for key in _revision_keys(request)} if type(request) is dict else request
        validate_request(ordered, operation)
    except ValidationError as error:
        location = (_decision_text(request_path) + "#" + error.path if error.path else request_path) if _decision_truth(request_path) else error.path
        located = ValidationError(error.code, location if type(location) is str else "")
        located.path = location
        raise located from None


def _write_decision_package(input_value, operation):
    # Capture root fields at invocation. Nested request values intentionally
    # retain their references until the second validation after reading base.
    value = input_value if type(input_value) is dict else {}
    base, output = value.get("basePath"), value.get("outputPath")
    request, request_path = value.get("request"), value.get("requestPath", "")
    try:
        _decision_validate(request, operation, request_path)
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def write():
        from package_records import _read_package_api
        from package_apply import _write_decision_applied
        contents = await _read_package_api(base)
        _decision_validate(request, operation, request_path)
        try:
            prepared = prepare(contents, request, operation, _clone=_decision_clone)
        except ValidationError as error:
            located = {"ID_EXISTS", "TARGET_MISSING", "TARGET_INVALID", "LIFECYCLE_INVALID", "CHANGESET_ID_EXISTS", "RESULT_INVALID"}
            if error.code.removeprefix("DECISION_" + operation + "_") in located and _decision_truth(request_path):
                raise ValidationError(error.code, _decision_text(request_path) + "#" + error.path) from None
            raise
        result = await _write_decision_applied(base, output, prepared)
        return {**result, "decisionId": request["decisionId"],
                "decisionRevision": prepared["candidateElement"]["revision"], "changeSetId": request["changeSetId"]}
    return write()


def write_created_decision_package(input_value=None):
    """Return an awaitable that creates a Decision in a new package root."""
    return _write_decision_package(input_value, "CREATION")


def write_revised_decision_package(input_value=None):
    """Return an awaitable that revises a Decision in a new package root."""
    return _write_decision_package(input_value, "REVISION")


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("unexpected arguments")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        if type(value) is not dict or set(value) != {"operation", "packageFiles", "request"} or value["operation"] not in ("create", "revise"):
            raise ValueError("invalid request")
        operation = "CREATION" if value["operation"] == "create" else "REVISION"
        validate_request(value["request"], operation)
        contents = read_package_files(value["packageFiles"])
        output = json.dumps(prepare(contents, value["request"], operation), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(output.encode("utf-8")) + 1 > LIMIT:
            raise ValueError("output exceeds limit")
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError, OverflowError):
        print('{"error":{"code":"DECISION_PREPARATION_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
