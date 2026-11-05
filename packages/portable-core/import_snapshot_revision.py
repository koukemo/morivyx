"""Independent reimport proposals using locally recorded snapshot baselines."""

import asyncio
from copy import deepcopy
import re

from canonical import TIMESTAMP, canonical_json, digest
from changeset_apply import apply_change_set
from figma_import import compare_figma_import_snapshots
from github_import import compare_github_import_snapshots
from import_snapshot_creation import (ADAPTERS, IMPORT_SNAPSHOT_CREATION_FORMAT, IMPORT_SNAPSHOT_EXTENSION,
                                      _compare_times, _describe, _get, validate_import_snapshot_creation_request)
from ledger_store import read_ledger_package
from openapi_import import compare_openapi_import_snapshots
from package_apply import write_applied_package
from plugin_manifest import get_declared_plugin_capability
from repository_import import compare_repository_import_snapshots
from schema_validation import DIGEST, STABLE_ID, ValidationError


IMPORT_SNAPSHOT_REVISION_FORMAT = "morivyx.import-snapshot-revision/0.1"
COMPARATORS = {"repository": compare_repository_import_snapshots, "github": compare_github_import_snapshots,
               "figma": compare_figma_import_snapshots, "openapi": compare_openapi_import_snapshots}


def _check(condition, suffix):
    if not condition:
        raise ValidationError("IMPORT_REVISION_" + suffix, "/reimport")


def _creation(request):
    return {**{key: value for key, value in request.items() if key != "baselineArtifactRevision"},
            "format": IMPORT_SNAPSHOT_CREATION_FORMAT}


def validate_import_snapshot_revision_request(request):
    """Validate captured reimport data and retain the caller's object identity."""
    try:
        _check(len(canonical_json(request).encode("utf-8")) <= 1048576, "INPUT_LIMIT")
        _check(type(request) is dict and request.get("format") == IMPORT_SNAPSHOT_REVISION_FORMAT and
               type(request.get("baselineArtifactRevision")) is str and DIGEST.fullmatch(request["baselineArtifactRevision"]), "REQUEST_INVALID")
        validate_import_snapshot_creation_request(_creation(request))
    except Exception as error:
        if getattr(error, "code", None) == "IMPORT_REVISION_INPUT_LIMIT":
            raise
        _check(False, "REQUEST_INVALID")
    return request


def _baseline_check(condition, suffix="INVALID"):
    if not condition:
        raise ValidationError("IMPORT_BASELINE_" + suffix, "/baseline")


def _member(value, key):
    if value is None:
        raise TypeError("null record member access")
    return _get(value, key)


def _truthy(value):
    if value is None or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and value == value
    return bool(value) if type(value) is str else True


def _has_recorded_run(base, result):
    for entry in base["changeSets"]:
        provenance = _member(entry, "provenance")
        for key in ("importSnapshot", "importAvailability", "importPresence"):
            recorded = _get(provenance, key)
            if (_get(recorded, "plugin", "id") == result["plugin"]["id"] and
                    _get(recorded, "plugin", "version") == result["plugin"]["version"] and
                    _get(recorded, "runId") == result["runId"]):
                return True
    return False


def restore_import_baseline(base, request):
    """Reconstruct previous result metadata from exactly one recorded operation."""
    matches = []
    for entry in base["changeSets"]:
        if _truthy(_get(_member(entry, "provenance"), "importSnapshot")) and type(_get(entry, "operations")) is list:
            if any(_member(operation, "op") in ("create", "revise") and _get(operation, "targetId") == request["artifactId"] and
                   _get(operation, "afterRevision") == request["baselineArtifactRevision"] for operation in entry["operations"]):
                matches.append(entry)
    _baseline_check(len(matches) == 1, "UNRECORDED")
    ledger = matches[0]
    saved = ledger["provenance"]["importSnapshot"]
    try:
        previous = {"format": "morivyx.plugin-run-result/0.1", "runId": saved["runId"],
                    "plugin": {"id": saved["plugin"]["id"], "version": saved["plugin"]["version"]},
                    "capabilityId": saved["capabilityId"], "status": "success", "output": deepcopy(saved["snapshot"])}
        _baseline_check(saved["plugin"]["id"] == request["runResult"]["plugin"]["id"] and
                        saved["capabilityId"] == request["runResult"]["capabilityId"])
        system = saved["snapshot"]["externalIdentity"]["system"]
        if system in ("figma", "openapi"):
            _, effect, input_format, output_format, _, validate_result = ADAPTERS[previous["plugin"]["id"]]
            validate_result(previous)
            manifest = deepcopy(request["manifest"])
            manifest["identity"].update(saved["plugin"])
            capability = get_declared_plugin_capability(manifest, saved["capabilityId"])
            provenance = ledger["provenance"]
            _baseline_check(capability["effect"] == effect and capability["inputFormat"] == "morivyx." + input_format + "/0.1" and
                            capability["outputFormat"] == "morivyx." + output_format + "/0.1" and
                            type(provenance.get("actor")) is str and STABLE_ID.fullmatch(provenance["actor"]) and
                            provenance["actor"] not in (request["artifactId"], request["changeSetId"]) and
                            type(provenance.get("recordedAt")) is str and TIMESTAMP.fullmatch(provenance["recordedAt"]) and
                            _compare_times(provenance["recordedAt"], saved["snapshot"]["retrievedAt"]) >= 0)
            authoring = {"manifest": manifest, "runResult": previous}
        else:
            authoring = _creation(deepcopy(request))
            authoring["recordedAt"] = ledger["provenance"]["recordedAt"]
            authoring["actor"] = ledger["provenance"]["actor"]
            authoring["runResult"] = previous
            authoring["manifest"]["identity"].update(saved["plugin"])
            authoring["runRequest"]["runId"] = saved["runId"]
            authoring["runRequest"]["plugin"] = deepcopy(previous["plugin"])
            snapshot = saved["snapshot"]
            if system == "github":
                authoring["runRequest"]["input"] = {"owner": snapshot["source"]["owner"], "repository": snapshot["source"]["repository"],
                    "repositoryId": snapshot["externalIdentity"]["repositoryId"], "commit": snapshot["source"]["commit"], "locator": snapshot["locator"]}
            else:
                authoring["runRequest"]["input"].update(externalId=snapshot["externalIdentity"]["externalId"], locator=snapshot["locator"])
            validate_import_snapshot_creation_request(authoring)
        described, uri, version, kind = _describe(authoring)
        _baseline_check(canonical_json(saved) == canonical_json(described) and ledger["provenance"]["method"] == "imported")
        return {"previousResult": previous, "saved": deepcopy(saved), "uri": uri, "externalVersion": version,
                "artifactKind": kind, "provenance": deepcopy(ledger["provenance"])}
    except Exception:
        _baseline_check(False)


def import_follows_observations(base, artifact_id, observed_at, recorded_at):
    """Reject a reimport older than a recorded presence or availability observation."""
    for entry in base["changeSets"]:
        provenance = _member(entry, "provenance")
        for key in ("importAvailability", "importPresence"):
            previous = _get(provenance, key)
            if _get(previous, "artifactId") == artifact_id:
                times = (_get(previous, "observedAt"), _get(entry, "provenance", "recordedAt"))
                if not all(type(value) is str and TIMESTAMP.fullmatch(value) for value in times):
                    return False
                if _compare_times(observed_at, times[0]) < 0 or _compare_times(recorded_at, times[1]) < 0:
                    return False
    return True


def _records(base):
    for key in ("elements", "approvals", "changeSets", "migrations", "reports"):
        if type(base.get(key)) is list:
            for entry in base[key]:
                yield entry.get("report", entry) if key == "reports" and type(entry) is dict and entry.get("report") is not None else entry


def _restore(base, artifact, request):
    try:
        restored = restore_import_baseline(base, {**_creation(request), "baselineArtifactRevision": request["baselineArtifactRevision"]})
    except Exception as error:
        _check(False, "BASELINE_UNRECORDED" if getattr(error, "code", None) == "IMPORT_BASELINE_UNRECORDED" else "BASELINE_INVALID")
    try:
        saved, provenance = restored["saved"], restored["provenance"]
        attributes, actual = artifact["attributes"], artifact["provenance"]
        _check(canonical_json(artifact["extensions"][IMPORT_SNAPSHOT_EXTENSION]) == canonical_json(saved) and
               attributes["artifactKind"] == restored["artifactKind"] and attributes["uri"] == restored["uri"] and
               attributes["digest"] == saved["snapshot"]["digest"] and attributes["externalVersion"] == restored["externalVersion"] and
               actual["method"] == "imported" and actual["actor"] == provenance["actor"] and
               _compare_times(actual["recordedAt"], provenance["recordedAt"]) == 0 and
               _compare_times(request["recordedAt"], provenance["recordedAt"]) >= 0 and
               _compare_times(request["runResult"]["output"]["retrievedAt"], saved["snapshot"]["retrievedAt"]) >= 0, "BASELINE_INVALID")
        return restored
    except Exception:
        _check(False, "BASELINE_INVALID")


def prepare_import_snapshot_revision(base, input_value):
    """Prepare a detached revision of one unchanged, previously imported artifact."""
    validate_import_snapshot_revision_request(input_value)
    request = deepcopy(input_value)
    _check(type(base) is dict and type(base.get("elements")) is list and type(base.get("changeSets")) is list, "PACKAGE_INVALID")
    _check(_get(base, "revision", "id") == request["baseRevision"] and _get(base, "revision", "rootDigest") == request["baseRootDigest"], "BASE_MISMATCH")
    _check(not any(_get(entry, "id") == request["changeSetId"] for entry in _records(base)), "CHANGESET_EXISTS")
    if any(entry is None for entry in base["elements"]):
        raise TypeError("null graph element")
    targets = [entry for entry in base["elements"] if _get(entry, "id") == request["artifactId"]]
    _check(len(targets) == 1 and targets[0].get("kind") == "entity" and targets[0].get("type") == "core.artifact", "TARGET_INVALID")
    artifact = targets[0]
    _check(artifact.get("revision") == request["baselineArtifactRevision"], "LOCAL_CONFLICT")
    result = request["runResult"]
    _check(not _has_recorded_run(base, result), "RUN_ALREADY_RECORDED")
    try:
        _check(import_follows_observations(base, artifact["id"], result["output"]["retrievedAt"], request["recordedAt"]), "TIME_REGRESSION")
    except Exception:
        _check(False, "TIME_REGRESSION")
    restored = _restore(base, artifact, request)
    comparison = COMPARATORS[result["output"]["externalIdentity"]["system"]]({"previousResult": restored["previousResult"],
        "currentRequest": request["runRequest"], "currentResult": result})
    _check(comparison["status"] != "current", "UNCHANGED")
    _check(comparison["status"] == "stale", "COMPARISON_INVALID")
    record, uri, version, _ = _describe(request)
    candidate = deepcopy(artifact)
    candidate["attributes"].update(uri=uri, digest=record["snapshot"]["digest"], externalVersion=version)
    candidate.update(lifecycle="draft", reviewState="unreviewed", provenance={"method": "imported", "actor": request["actor"], "recordedAt": request["recordedAt"]})
    candidate["extensions"][IMPORT_SNAPSHOT_EXTENSION] = record
    candidate["revision"] = digest("revision", candidate)["digest"]
    root = digest("root", [candidate if entry["id"] == artifact["id"] else entry for entry in base["elements"]])["digest"]
    change_set = {"format": "morivyx.changeset/0.1", "id": request["changeSetId"], "baseRevision": request["baseRevision"],
        "resultingRevision": request["resultingRevision"], "resultingRootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest"),
        "operations": [{"op": "revise", "targetId": artifact["id"], "beforeRevision": request["baselineArtifactRevision"], "afterRevision": candidate["revision"]}],
        "provenance": {**candidate["provenance"], "importSnapshot": deepcopy(record), "previousImportSnapshot": restored["saved"],
                       "baselineArtifactRevision": request["baselineArtifactRevision"]}, "recordedAt": request["recordedAt"]}
    revision = {"format": "morivyx.graph-revision/0.1", "id": request["resultingRevision"], "parentRevision": request["baseRevision"],
                "rootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest")}
    apply_change_set({"changeSet": change_set, "currentRevision": base["revision"], "currentElements": base["elements"],
                      "schemaLockDigest": base.get("calculatedSchemaLockDigest"), "candidateElements": [candidate], "resultingRevision": revision})
    return {"comparison": comparison, "candidateElement": candidate, "changeSet": change_set, "resultingRevision": revision}


def write_reimported_snapshot_package(input_value):
    """Capture a validated request before returning an awaitable explicit save."""
    try:
        validate_import_snapshot_revision_request(_get(input_value, "request"))
        base_path, output_path = input_value.get("basePath"), input_value.get("outputPath")
        request = deepcopy(input_value["request"])
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        base = read_ledger_package(base_path)
        prepared = prepare_import_snapshot_revision(base, request)
        result = await write_applied_package({"basePath": base_path, "outputPath": output_path, "changeSet": prepared["changeSet"],
            "candidateElements": [prepared["candidateElement"]], "resultingRevision": prepared["resultingRevision"]})
        return {**result, "artifactId": request["artifactId"], "artifactRevision": prepared["candidateElement"]["revision"]}
    return save()
