"""Independent observation of successful imports without revising the artifact."""

import asyncio
from copy import deepcopy

from canonical import TIMESTAMP, canonical_json, digest
from changeset_apply import apply_change_set
from import_snapshot_creation import (_compare_times, _describe, _get,
                                      validate_import_snapshot_creation_request)
from import_snapshot_revision import (COMPARATORS, _has_recorded_run, _member, _records, _truthy,
                                      import_follows_observations, restore_import_baseline)
from ledger_store import read_ledger_package
from package_apply import write_applied_package
from schema_validation import DIGEST, STABLE_ID, ValidationError


IMPORT_PRESENCE_FORMAT = "morivyx.import-presence/0.1"
IMPORT_PRESENCE_EXTENSION = "morivyx.import/presence"
KEYS = set("format artifactId observationId relationId changeSetId actor baseRevision baseRootDigest baselineArtifactRevision resultingRevision observedAt recordedAt manifest runRequest runResult".split())


def _check(condition, suffix):
    if not condition:
        raise ValidationError("IMPORT_PRESENCE_" + suffix, "/presence")


def _digest(kind, value):
    try:
        return digest(kind, value)["digest"]
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise TypeError("invalid logical digest input") from None


def _creation(request):
    return {**{key: value for key, value in request.items() if key not in
               ("observationId", "relationId", "baselineArtifactRevision", "observedAt")},
            "format": "morivyx.import-snapshot-creation/0.1"}


def validate_import_presence_request(request):
    """Validate captured successful-result authoring data and return the input."""
    try:
        _check(len(canonical_json(request).encode("utf-8")) <= 1048576, "INPUT_LIMIT")
        _check(type(request) is dict and set(request) == KEYS, "REQUEST_INVALID")
        ids = [request[key] for key in ("artifactId", "observationId", "relationId", "changeSetId", "actor")]
        _check(request["format"] == IMPORT_PRESENCE_FORMAT and
               all(type(value) is str and STABLE_ID.fullmatch(value) for value in ids) and len(set(ids)) == 5 and
               type(request["baselineArtifactRevision"]) is str and DIGEST.fullmatch(request["baselineArtifactRevision"]) and
               type(request["observedAt"]) is str and TIMESTAMP.fullmatch(request["observedAt"]), "REQUEST_INVALID")
        validate_import_snapshot_creation_request(_creation(request))
        _check(_compare_times(request["observedAt"], request["runResult"]["output"]["retrievedAt"]) >= 0 and
               _compare_times(request["recordedAt"], request["observedAt"]) >= 0, "REQUEST_INVALID")
    except Exception as error:
        if getattr(error, "code", None) == "IMPORT_PRESENCE_INPUT_LIMIT":
            raise
        _check(False, "REQUEST_INVALID")
    return request


def _superseded(base, artifact_id, baseline):
    for value in base["changeSets"]:
        if _truthy(_get(_member(value, "provenance"), "importSnapshot")):
            operations = _get(value, "operations")
            if operations is not None:
                if type(operations) is not list:
                    raise TypeError("operations do not provide array traversal")
                if any(_member(operation, "op") == "revise" and _get(operation, "targetId") == artifact_id and
                       _get(operation, "beforeRevision") == baseline for operation in operations):
                    return True
    return False


def prepare_import_presence(base, input_value):
    """Prepare an observation and relation while retaining the existing artifact."""
    validate_import_presence_request(input_value)
    request = deepcopy(input_value)
    _check(type(base) is dict and type(base.get("elements")) is list and type(base.get("changeSets")) is list, "PACKAGE_INVALID")
    _check(_get(base, "revision", "id") == request["baseRevision"] and _get(base, "revision", "rootDigest") == request["baseRootDigest"], "BASE_MISMATCH")
    ids = [request[key] for key in ("observationId", "relationId", "changeSetId")]
    _check(not any(_get(value, "id") in ids for value in _records(base)), "ID_EXISTS")
    _check(not _has_recorded_run(base, request["runResult"]), "RUN_ALREADY_RECORDED")
    targets = [value for value in base["elements"] if _member(value, "id") == request["artifactId"]]
    _check(len(targets) == 1 and _get(targets[0], "kind") == "entity" and _get(targets[0], "type") == "core.artifact", "TARGET_INVALID")
    artifact = targets[0]
    try:
        baseline = restore_import_baseline(base, {**_creation(request), "baselineArtifactRevision": request["baselineArtifactRevision"]})
    except Exception as error:
        _check(False, "BASELINE_UNRECORDED" if getattr(error, "code", None) == "IMPORT_BASELINE_UNRECORDED" else "BASELINE_INVALID")
    _check(not _superseded(base, artifact["id"], request["baselineArtifactRevision"]), "BASELINE_SUPERSEDED")
    retrieved_at = request["runResult"]["output"]["retrievedAt"]
    try:
        _check(_compare_times(retrieved_at, baseline["saved"]["snapshot"]["retrievedAt"]) >= 0 and
               _compare_times(retrieved_at, baseline["provenance"]["recordedAt"]) >= 0 and
               import_follows_observations(base, artifact["id"], retrieved_at, request["recordedAt"]), "TIME_REGRESSION")
    except Exception:
        _check(False, "TIME_REGRESSION")
    comparison = COMPARATORS[request["runResult"]["output"]["externalIdentity"]["system"]]({
        "previousResult": baseline["previousResult"], "currentRequest": request["runRequest"], "currentResult": request["runResult"]})
    _check(comparison["status"] in ("current", "stale"), "COMPARISON_INVALID")
    schemas = _get(base, "schemaLock", "schemas")
    if schemas is not None and type(schemas) is not list:
        raise TypeError("schemas do not provide array lookup")
    schema = next((value for value in schemas if _member(value, "schemaId") == "morivyx.core"), None) if schemas is not None else None
    _check(schema is not None and type(_get(schema, "version")) is str, "SCHEMA_MISSING")
    imported = _describe(request)[0]
    if "revision" not in artifact:
        raise TypeError("artifact revision is undefined")
    record = {"format": "morivyx.import-presence-record/0.1", "status": "available", "comparison": comparison["status"],
        "artifactId": artifact["id"], "baselineArtifactRevision": request["baselineArtifactRevision"], "currentArtifactRevision": artifact["revision"],
        "localStatus": "baseline" if artifact["revision"] == request["baselineArtifactRevision"] else "changed",
        "externalIdentity": deepcopy(imported["snapshot"]["externalIdentity"]), "locator": imported["snapshot"]["locator"],
        "observedAt": request["observedAt"], "plugin": deepcopy(imported["plugin"]), "capabilityId": imported["capabilityId"],
        "runId": imported["runId"], "previousImportSnapshot": baseline["saved"], "currentImportSnapshot": imported, "executionBinding": "not-verified"}
    provenance = {"method": "imported", "actor": request["actor"], "recordedAt": request["recordedAt"]}
    shared = {"format": "morivyx.git-graph/0.1", "typeVersion": schema["version"], "lifecycle": "draft", "reviewState": "unreviewed"}
    observation = {**shared, "kind": "entity", "id": request["observationId"], "type": "core.observation",
        "attributes": {"method": "plugin-read-success", "observedAt": request["observedAt"], "value": {
            "status": record["status"], "comparison": record["comparison"], "artifactId": artifact["id"],
            "baselineArtifactRevision": record["baselineArtifactRevision"], "currentArtifactRevision": artifact["revision"], "localStatus": record["localStatus"]}},
        "provenance": deepcopy(provenance), "extensions": {IMPORT_PRESENCE_EXTENSION: record}}
    observation["revision"] = _digest("revision", observation)
    relation = {**shared, "kind": "relation", "id": request["relationId"], "type": "core.observes",
        "attributes": {"predicate": "observes", "source": observation["id"], "target": artifact["id"]}, "provenance": deepcopy(provenance)}
    relation["revision"] = _digest("revision", relation)
    candidates = [observation, relation]
    root = _digest("root", [*base["elements"], *candidates])
    change_set = {"format": "morivyx.changeset/0.1", "id": request["changeSetId"], "baseRevision": request["baseRevision"],
        "resultingRevision": request["resultingRevision"], "resultingRootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest"),
        "operations": [{"op": "create", "targetId": value["id"], "afterRevision": value["revision"]} for value in candidates],
        "provenance": {**provenance, "importPresence": deepcopy(record)}, "recordedAt": request["recordedAt"]}
    revision = {"format": "morivyx.graph-revision/0.1", "id": request["resultingRevision"], "parentRevision": request["baseRevision"],
                "rootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest")}
    apply_change_set({"changeSet": change_set, "currentRevision": base["revision"], "currentElements": base["elements"],
        "schemaLockDigest": base.get("calculatedSchemaLockDigest"), "candidateElements": candidates, "resultingRevision": revision})
    return {"comparison": comparison, "candidateElements": candidates, "changeSet": change_set, "resultingRevision": revision}


def write_import_presence_package(input_value):
    """Capture a validated request before returning the explicit save awaitable."""
    try:
        validate_import_presence_request(_get(input_value, "request"))
        base_path, output_path = input_value.get("basePath"), input_value.get("outputPath")
        request = deepcopy(input_value["request"])
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        base = read_ledger_package(base_path)
        prepared = prepare_import_presence(base, request)
        result = await write_applied_package({"basePath": base_path, "outputPath": output_path, "changeSet": prepared["changeSet"],
            "candidateElements": prepared["candidateElements"], "resultingRevision": prepared["resultingRevision"]})
        return {**result, "observationId": request["observationId"], "relationId": request["relationId"],
                "status": "available", "comparison": prepared["comparison"]["status"]}
    return save()
