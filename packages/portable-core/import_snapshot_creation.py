"""Independent initial import proposals and explicit new-package persistence.

Captured plugin results are validated locally. No plugin is executed, no remote
service is contacted, and execution identity or approval authority is not proven.
"""

import asyncio
from copy import deepcopy
import re
from urllib.parse import quote

from canonical import TIMESTAMP, canonical_json, digest
from changeset_apply import apply_change_set
from figma_import import validate_figma_import_request, validate_figma_import_result
from github_import import validate_github_import_request, validate_github_import_result
from ledger_store import read_ledger_package
from openapi_import import validate_openapi_import_request, validate_openapi_import_result
from package_apply import write_applied_package
from plugin_manifest import get_declared_plugin_capability
from record_validation import GRAPH_ID, validate_change_set, validate_graph_revision
from repository_import import validate_repository_import_request, validate_repository_import_result
from schema_validation import DIGEST, STABLE_ID, ValidationError, validate_graph_element


IMPORT_SNAPSHOT_CREATION_FORMAT = "morivyx.import-snapshot-creation/0.1"
IMPORT_SNAPSHOT_EXTENSION = "morivyx.import/snapshot"
KEYS = set("format artifactId changeSetId baseRevision baseRootDigest resultingRevision actor recordedAt manifest runRequest runResult".split())
REPOSITORY_LOSS = ["file-content-not-retained", "non-file-metadata-not-imported", "rename-history-not-tracked", "repository-commit-not-recorded"]
ADAPTERS = {
    "morivyx.repository-importer.dev": ("repository", "read-only", "repository-read-input", "repository-file-snapshot", validate_repository_import_request, validate_repository_import_result),
    "morivyx.github-importer.dev": ("github", "read-only", "github-read-input", "github-file-snapshot", validate_github_import_request, validate_github_import_result),
    "morivyx.figma-importer.dev": ("figma", "read-only", "figma-node-input", "figma-node-snapshot", validate_figma_import_request, validate_figma_import_result),
    "morivyx.openapi-importer.dev": ("openapi", "pure", "openapi-operation-input", "openapi-operation-snapshot", validate_openapi_import_request, validate_openapi_import_result),
}


def _check(condition, suffix):
    if not condition:
        raise ValidationError("IMPORT_SNAPSHOT_" + suffix, "/import")


def _matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def _time_parts(value):
    normalized = canonical_json(value)[1:-1]
    return normalized[:19], normalized[19:-1].lstrip(".")


def _compare_times(left, right):
    a, af = _time_parts(left)
    b, bf = _time_parts(right)
    if a != b:
        return -1 if a < b else 1
    width = max(len(af), len(bf))
    af, bf = af.ljust(width, "0"), bf.ljust(width, "0")
    return 0 if af == bf else -1 if af < bf else 1


def validate_import_snapshot_creation_request(request):
    """Validate captured authoring data and return the caller's original value."""
    try:
        text = canonical_json(request)
    except (ValueError, TypeError, RecursionError, OverflowError):
        _check(False, "REQUEST_INVALID")
    _check(len(text.encode("utf-8")) <= 1048576, "INPUT_LIMIT")
    _check(type(request) is dict and set(request) == KEYS, "REQUEST_INVALID")
    identities = [request["artifactId"], request["changeSetId"], request["actor"]]
    _check(request["format"] == IMPORT_SNAPSHOT_CREATION_FORMAT and
           all(_matches(value, STABLE_ID) for value in identities) and len(set(identities)) == 3 and
           all(_matches(request[key], GRAPH_ID) for key in ("baseRevision", "resultingRevision")) and
           request["baseRevision"] != request["resultingRevision"] and
           _matches(request["baseRootDigest"], DIGEST) and _matches(request["recordedAt"], TIMESTAMP), "REQUEST_INVALID")
    try:
        result = request["runResult"]
        system, effect, input_format, output_format, validate_request, validate_result = ADAPTERS[result["plugin"]["id"]]
        validate_request(request["runRequest"])
        validate_result(result, request["runRequest"])
        if system == "repository":
            value = request["runRequest"]["input"]
            _check(type(value) is dict and set(value) == {"repositoryRoot", "externalId", "locator"} and
                   all(type(value.get(key)) is str and value[key] for key in ("repositoryRoot", "externalId", "locator")) and
                   not re.search(r"[\\\x00-\x1f\x7f]", value["locator"]) and
                   all(part and part not in (".", "..") for part in value["locator"].split("/")), "RESULT_INVALID")
        capability = get_declared_plugin_capability(request["manifest"], result["capabilityId"])
        _check(result["status"] == "success" and capability["effect"] == effect and
               request["runRequest"]["capability"]["effect"] == effect and
               request["manifest"]["identity"]["id"] == result["plugin"]["id"] and
               request["manifest"]["identity"]["version"] == result["plugin"]["version"] and
               capability["inputFormat"] == "morivyx." + input_format + "/0.1" and
               capability["outputFormat"] == "morivyx." + output_format + "/0.1" and
               _compare_times(request["recordedAt"], result["output"]["retrievedAt"]) >= 0, "RESULT_INVALID")
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError, OverflowError):
        _check(False, "RESULT_INVALID")
    return request


def _describe(request):
    result = request["runResult"]
    snapshot = deepcopy(result["output"])
    identity = snapshot["externalIdentity"]
    system = identity["system"]
    encode = lambda text: quote(text, safe="~!*'()-", encoding="utf-8", errors="strict")
    if system == "figma":
        uri = "urn:morivyx:figma-node:" + encode(identity["fileKey"]) + ":" + encode(snapshot["locator"])
    elif system == "github":
        source = snapshot["source"]
        uri = "https://github.com/" + source["owner"] + "/" + source["repository"] + "/blob/" + source["commit"] + "/" + "/".join(encode(part) for part in snapshot["locator"].split("/"))
    else:
        uri = "urn:morivyx:" + ("openapi-operation" if system == "openapi" else "repository-file") + ":" + encode(identity["externalId"]) + ":" + encode(snapshot["locator"])
    record = {"format": "morivyx.import-snapshot-record/0.1", "plugin": {"id": result["plugin"]["id"],
              "version": result["plugin"]["version"], "packageDigest": request["manifest"]["identity"]["packageDigest"]},
              "runId": result["runId"], "capabilityId": result["capabilityId"], "snapshot": snapshot,
              "informationLoss": list(snapshot["informationLoss"] if system in ("figma", "github", "openapi") else REPOSITORY_LOSS),
              "executionBinding": "not-verified"}
    version = snapshot["source"]["version"] if system == "figma" else snapshot["source"]["commit"] if system == "github" else snapshot["digest"]
    return record, uri, version, "design-node" if system == "figma" else "api-operation" if system == "openapi" else "file"


def _get(value, *path):
    for key in path:
        value = value.get(key) if type(value) is dict else None
    return value


def _external_key(record):
    snapshot = _get(record, "snapshot")
    if not _get(snapshot, "externalIdentity") or type(_get(snapshot, "locator")) is not str:
        return None
    return canonical_json({"externalIdentity": snapshot["externalIdentity"], "locator": snapshot["locator"]})


def prepare_import_snapshot_creation(package_contents, input_value):
    """Build a detached new artifact, ChangeSet and revision, without writing."""
    validate_import_snapshot_creation_request(input_value)
    request = deepcopy(input_value)
    _check(type(package_contents) is dict and type(package_contents.get("elements")) is list, "PACKAGE_INVALID")
    base = package_contents
    _check(_get(base, "revision", "id") == request["baseRevision"] and
           _get(base, "revision", "rootDigest") == request["baseRootDigest"], "BASE_MISMATCH")
    record, uri, external_version, artifact_kind = _describe(request)
    records = [entry for key in ("elements", "approvals", "changeSets", "migrations") if type(base.get(key)) is list for entry in base[key]]
    if type(base.get("reports")) is list:
        records.extend(entry.get("report", entry) if type(entry) is dict and entry.get("report") is not None else entry for entry in base["reports"])
    _check(not any(_get(value, "id") in (request["artifactId"], request["changeSetId"]) for value in records), "ID_EXISTS")
    key = _external_key(record)
    _check(not any(_external_key(_get(value, "extensions", IMPORT_SNAPSHOT_EXTENSION)) == key or
                   _external_key(_get(value, "provenance", "importSnapshot")) == key or
                   (_get(value, "type") == "core.artifact" and _get(value, "attributes", "uri") == uri) for value in records), "TARGET_EXISTS")
    _check(type(base.get("changeSets")) is list, "PACKAGE_INVALID")
    result = request["runResult"]
    _check(not any(_get(value, "provenance", name, "plugin", "id") == result["plugin"]["id"] and
                   _get(value, "provenance", name, "plugin", "version") == result["plugin"]["version"] and
                   _get(value, "provenance", name, "runId") == result["runId"] for value in base["changeSets"]
                   for name in ("importSnapshot", "importAvailability", "importPresence")), "RUN_ALREADY_RECORDED")
    schemas = _get(base, "schemaLock", "schemas")
    schema = next((value for value in schemas if _get(value, "schemaId") == "morivyx.core"), None) if type(schemas) is list else None
    _check(schema is not None and type(_get(schema, "version")) is str, "SCHEMA_MISSING")
    provenance = {"method": "imported", "actor": request["actor"], "recordedAt": request["recordedAt"]}
    candidate = {"format": "morivyx.git-graph/0.1", "kind": "entity", "id": request["artifactId"], "type": "core.artifact",
                 "typeVersion": schema["version"], "lifecycle": "draft", "reviewState": "unreviewed",
                 "attributes": {"artifactKind": artifact_kind, "uri": uri, "digest": record["snapshot"]["digest"], "externalVersion": external_version},
                 "provenance": deepcopy(provenance), "extensions": {IMPORT_SNAPSHOT_EXTENSION: record}}
    candidate["revision"] = digest("revision", candidate)["digest"]
    validate_graph_element(candidate)
    root = digest("root", [*base["elements"], candidate])["digest"]
    change_set = {"format": "morivyx.changeset/0.1", "id": request["changeSetId"], "baseRevision": request["baseRevision"],
                  "resultingRevision": request["resultingRevision"], "resultingRootDigest": root,
                  "schemaLockDigest": base.get("calculatedSchemaLockDigest"),
                  "operations": [{"op": "create", "targetId": candidate["id"], "afterRevision": candidate["revision"]}],
                  "provenance": {**provenance, "importSnapshot": deepcopy(record)}, "recordedAt": request["recordedAt"]}
    revision = {"format": "morivyx.graph-revision/0.1", "id": request["resultingRevision"], "parentRevision": request["baseRevision"],
                "rootDigest": root, "schemaLockDigest": base.get("calculatedSchemaLockDigest")}
    validate_change_set(change_set)
    validate_graph_revision(revision)
    apply_change_set({"changeSet": change_set, "currentRevision": base["revision"], "currentElements": base["elements"],
                      "schemaLockDigest": base.get("calculatedSchemaLockDigest"), "candidateElements": [candidate], "resultingRevision": revision})
    return {"candidateElement": candidate, "changeSet": change_set, "resultingRevision": revision}


def write_imported_snapshot_package(input_value):
    """Capture authoring data at call time and return an awaitable save operation."""
    try:
        _check(type(input_value) is dict, "REQUEST_INVALID")
        base_path, output_path = input_value.get("basePath"), input_value.get("outputPath")
        validate_import_snapshot_creation_request(input_value.get("request"))
        request = deepcopy(input_value["request"])
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        base = read_ledger_package(base_path)
        prepared = prepare_import_snapshot_creation(base, request)
        result = await write_applied_package({"basePath": base_path, "outputPath": output_path, "changeSet": prepared["changeSet"],
                                              "candidateElements": [prepared["candidateElement"]], "resultingRevision": prepared["resultingRevision"]})
        return {**result, "artifactId": request["artifactId"], "artifactRevision": prepared["candidateElement"]["revision"]}
    return save()
