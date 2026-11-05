"""Independent failure observations that retain the existing imported artifact."""

import asyncio
from copy import deepcopy

from canonical import TIMESTAMP, canonical_json
from changeset_apply import apply_change_set
from import_presence import _digest, _superseded
from import_snapshot_creation import ADAPTERS, _compare_times, _get
from import_snapshot_revision import (COMPARATORS, _has_recorded_run, _member, _records,
                                      import_follows_observations, restore_import_baseline)
from ledger_store import read_ledger_package
from package_apply import write_applied_package
from plugin_manifest import get_declared_plugin_capability
from record_validation import GRAPH_ID
from schema_validation import DIGEST, STABLE_ID, ValidationError


IMPORT_AVAILABILITY_FORMAT = "morivyx.import-availability/0.1"
IMPORT_AVAILABILITY_EXTENSION = "morivyx.import/availability"
KEYS = set("format artifactId observationId relationId changeSetId actor baseRevision baseRootDigest baselineArtifactRevision resultingRevision observedAt recordedAt manifest runRequest runResult".split())


def _check(condition, suffix):
    if not condition:
        raise ValidationError("IMPORT_AVAILABILITY_" + suffix, "/availability")


def _matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def _baseline_request(request):
    keys = ("artifactId", "changeSetId", "actor", "baseRevision", "baseRootDigest",
            "baselineArtifactRevision", "resultingRevision", "recordedAt", "manifest", "runRequest", "runResult")
    return {"format": "morivyx.import-snapshot-creation/0.1", **{key: request[key] for key in keys}}


def validate_import_availability_request(request):
    """Validate a captured failure result and return the original request."""
    try:
        _check(len(canonical_json(request).encode("utf-8")) <= 1048576, "INPUT_LIMIT")
        _check(type(request) is dict and set(request) == KEYS, "REQUEST_INVALID")
        ids = [request[key] for key in ("artifactId", "observationId", "relationId", "changeSetId", "actor")]
        _check(request["format"] == IMPORT_AVAILABILITY_FORMAT and
               all(_matches(value, STABLE_ID) for value in ids) and len(set(ids)) == 5 and
               _matches(request["baseRevision"], GRAPH_ID) and _matches(request["resultingRevision"], GRAPH_ID) and
               request["baseRevision"] != request["resultingRevision"] and
               _matches(request["baseRootDigest"], DIGEST) and _matches(request["baselineArtifactRevision"], DIGEST) and
               _matches(request["observedAt"], TIMESTAMP) and _matches(request["recordedAt"], TIMESTAMP) and
               _compare_times(request["recordedAt"], request["observedAt"]) >= 0, "REQUEST_INVALID")
        result, run_request = request["runResult"], request["runRequest"]
        adapter = ADAPTERS[_get(result, "plugin", "id")]
        _, effect, input_format, output_format, validate_request, validate_result = adapter
        validate_request(run_request)
        validate_result(result, run_request)
        capability = get_declared_plugin_capability(request["manifest"], result["capabilityId"])
        identity = request["manifest"]["identity"]
        _check(result["status"] == "failure" and identity["id"] == result["plugin"]["id"] and
               identity["version"] == result["plugin"]["version"] and capability["effect"] == effect and
               capability["inputFormat"] == "morivyx." + input_format + "/0.1" and
               capability["outputFormat"] == "morivyx." + output_format + "/0.1", "REQUEST_INVALID")
    except Exception as error:
        if getattr(error, "code", None) == "IMPORT_AVAILABILITY_INPUT_LIMIT":
            raise
        _check(False, "REQUEST_INVALID")
    return request


def prepare_import_availability(base, input_value):
    """Prepare a missing or unavailable observation without changing the artifact."""
    validate_import_availability_request(input_value)
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
        baseline = restore_import_baseline(base, _baseline_request(request))
    except Exception as error:
        _check(False, "BASELINE_UNRECORDED" if getattr(error, "code", None) == "IMPORT_BASELINE_UNRECORDED" else "BASELINE_INVALID")
    _check(not _superseded(base, artifact["id"], request["baselineArtifactRevision"]), "BASELINE_SUPERSEDED")
    _check(_compare_times(request["observedAt"], baseline["saved"]["snapshot"]["retrievedAt"]) >= 0 and
           _compare_times(request["observedAt"], baseline["provenance"]["recordedAt"]) >= 0, "TIME_REGRESSION")
    try:
        _check(import_follows_observations(base, artifact["id"], request["observedAt"], request["recordedAt"]), "TIME_REGRESSION")
    except Exception:
        _check(False, "TIME_REGRESSION")
    system = ADAPTERS[request["runResult"]["plugin"]["id"]][0]
    comparison = COMPARATORS[system]({"previousResult": baseline["previousResult"],
                                    "currentRequest": request["runRequest"], "currentResult": request["runResult"]})
    _check(comparison["status"] in ("missing", "unavailable"), "COMPARISON_INVALID")
    schemas = _get(base, "schemaLock", "schemas")
    if schemas is not None and type(schemas) is not list:
        raise TypeError("schemas do not provide array lookup")
    schema = next((value for value in schemas if _member(value, "schemaId") == "morivyx.core"), None) if schemas is not None else None
    _check(schema is not None and type(_get(schema, "version")) is str, "SCHEMA_MISSING")
    source = request["runRequest"]["input"]
    if system == "openapi":
        attempted = {"system": system, "externalId": source["externalId"], "path": source["path"], "method": source["method"],
                     "documentDigest": comparison["current"]["documentDigest"], "digestRule": comparison["current"]["digestRule"]}
    elif system in ("figma", "github"):
        attempted = {"system": system, "apiOrigin": "https://api." + system + ".com", **deepcopy(source)}
    else:
        attempted = {"system": system, "externalId": source["externalId"], "locator": source["locator"]}
    if "revision" not in artifact:
        raise TypeError("artifact revision is undefined")
    snapshot = baseline["saved"]["snapshot"]
    record = {"format": "morivyx.import-availability-record/0.1", "status": comparison["status"],
        "artifactId": artifact["id"], "baselineArtifactRevision": request["baselineArtifactRevision"], "currentArtifactRevision": artifact["revision"],
        "localStatus": "baseline" if artifact["revision"] == request["baselineArtifactRevision"] else "changed",
        "externalIdentity": deepcopy(snapshot["externalIdentity"]), "locator": snapshot["locator"], "attemptedSource": attempted,
        "observedAt": request["observedAt"], "failureCode": comparison["current"]["failureCode"],
        "plugin": {**request["runResult"]["plugin"], "packageDigest": request["manifest"]["identity"]["packageDigest"]},
        "capabilityId": request["runResult"]["capabilityId"], "runId": request["runResult"]["runId"],
        "previousImportSnapshot": baseline["saved"], "executionBinding": "not-verified"}
    provenance = {"method": "imported", "actor": request["actor"], "recordedAt": request["recordedAt"]}
    shared = {"format": "morivyx.git-graph/0.1", "typeVersion": schema["version"], "lifecycle": "draft", "reviewState": "unreviewed"}
    observation = {**shared, "kind": "entity", "id": request["observationId"], "type": "core.observation",
        "attributes": {"method": "plugin-read-attempt", "observedAt": request["observedAt"], "value": {
            "status": record["status"], "artifactId": artifact["id"], "baselineArtifactRevision": record["baselineArtifactRevision"],
            "currentArtifactRevision": artifact["revision"], "localStatus": record["localStatus"], "failureCode": record["failureCode"]}},
        "provenance": deepcopy(provenance), "extensions": {IMPORT_AVAILABILITY_EXTENSION: record}}
    observation["revision"] = _digest("revision", observation)
    relation = {**shared, "kind": "relation", "id": request["relationId"], "type": "core.observes",
        "attributes": {"predicate": "observes", "source": observation["id"], "target": artifact["id"]}, "provenance": deepcopy(provenance)}
    relation["revision"] = _digest("revision", relation)
    candidates = [observation, relation]
    root = _digest("root", [*base["elements"], *candidates])
    change_set = {"format": "morivyx.changeset/0.1", "id": request["changeSetId"], "baseRevision": request["baseRevision"],
        "resultingRevision": request["resultingRevision"], "resultingRootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest"),
        "operations": [{"op": "create", "targetId": value["id"], "afterRevision": value["revision"]} for value in candidates],
        "provenance": {**provenance, "importAvailability": deepcopy(record)}, "recordedAt": request["recordedAt"]}
    revision = {"format": "morivyx.graph-revision/0.1", "id": request["resultingRevision"], "parentRevision": request["baseRevision"],
                "rootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest")}
    apply_change_set({"changeSet": change_set, "currentRevision": base["revision"], "currentElements": base["elements"],
        "schemaLockDigest": base.get("calculatedSchemaLockDigest"), "candidateElements": candidates, "resultingRevision": revision})
    return {"comparison": comparison, "candidateElements": candidates, "changeSet": change_set, "resultingRevision": revision}


def write_import_availability_package(input_value):
    """Capture a validated failure request before returning the save awaitable."""
    try:
        validate_import_availability_request(_get(input_value, "request"))
        base_path, output_path = input_value.get("basePath"), input_value.get("outputPath")
        request = deepcopy(input_value["request"])
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        base = read_ledger_package(base_path)
        prepared = prepare_import_availability(base, request)
        result = await write_applied_package({"basePath": base_path, "outputPath": output_path, "changeSet": prepared["changeSet"],
            "candidateElements": prepared["candidateElements"], "resultingRevision": prepared["resultingRevision"]})
        return {**result, "observationId": request["observationId"], "relationId": request["relationId"], "status": prepared["comparison"]["status"]}
    return save()
