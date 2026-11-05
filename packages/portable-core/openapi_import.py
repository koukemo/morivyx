"""Independent OpenAPI operation snapshots and source-bound reimport reports.

Only an explicitly supplied JSON document is inspected. References, servers,
parameters and schemas are never fetched or interpreted. Reports do not adopt
changes, authenticate a source or grant permission to execute an operation.
"""

import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import json
import re
import sys

from canonical import canonical_json, load_json
from plugin_messages import validate_plugin_run_request, validate_plugin_run_result
from plugin_runtime import _json_text, _json_value
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin

PLUGIN_ID = "morivyx.openapi-importer.dev"
PLUGIN_VERSION = "0.1.0"
CAPABILITY_ID = "openapi.inspect-operation"
COMPARISON_FORMAT = "morivyx.openapi-import-comparison/0.1"
DOCUMENT_BYTES = 524288
DOCUMENT_DEPTH = 64
LIMIT = 8 * 1024 * 1024
MESSAGE = "OpenAPIの取込条件または結果を確認できません。"
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
LOSS = ("document-text-not-retained", "non-selected-operations-not-retained", "descriptions-and-examples-not-retained",
        "parameters-and-schemas-not-interpreted", "security-and-server-settings-not-retained", "references-not-resolved",
        "operation-rename-history-not-tracked")
SNAPSHOT_KEYS = {"kind", "externalIdentity", "locator", "digest", "digestRule", "retrievedAt", "openapiVersion", "operation", "informationLoss"}
_VERSION = re.compile(r"3\.1\.[0-9]+")
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_UNSET = object()


class OpenApiImportError(ValidationError):
    def __init__(self, suffix):
        super().__init__("OPENAPI_IMPORT_" + suffix, "")
        self.path = None


def _check(value, suffix):
    if not value:
        raise OpenApiImportError(suffix)


def _matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def _keys(value, names):
    return type(value) is dict and set(value) == set(names)


def _text(value, limit):
    try:
        return type(value) is str and 0 < len(value) <= limit and _CONTROL.search(value) is None and \
            canonical_json(value) == json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (ValueError, TypeError, RecursionError, OverflowError):
        return False


def _path(value):
    return _text(value, 2048) and value.startswith("/")


def _pointer(path, method):
    return "/paths/" + path.replace("~", "~0").replace("/", "~1") + "/" + method


def _error_code(error, fallback):
    # Arbitrary exceptions and their properties are not trusted data.
    if type(error) is not OpenApiImportError:
        return fallback
    code = vars(error).get("code")
    try:
        if type(code) is str and code:
            canonical_json(code)
            return code
    except (ValueError, TypeError, RecursionError, OverflowError):
        pass
    return fallback


def openapi_import_request(*, run_id=None, external_id=None, document_text=None, path=None, method=None):
    """Build wire data without validating, normalizing or executing it."""
    return {"format": "morivyx.plugin-run-request/0.1", "runId": run_id,
            "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION},
            "capability": {"id": CAPABILITY_ID, "effect": "pure"},
            "input": {"externalId": external_id, "documentText": document_text, "path": path, "method": method}}


def validate_openapi_import_request(request):
    """Validate the original logical request and preserve all source strings."""
    try:
        validate_plugin_run_request(request)
        value = request["input"]
        _check(request["plugin"]["id"] == PLUGIN_ID and request["plugin"]["version"] == PLUGIN_VERSION and
               request["capability"]["id"] == CAPABILITY_ID and request["capability"]["effect"] == "pure" and
               _text(request["runId"], 256) and _keys(value, {"externalId", "documentText", "path", "method"}) and
               _text(value["externalId"], 512) and _path(value["path"]) and value["method"] in METHODS and
               type(value["documentText"]) is str and len(value["documentText"]) > 0, "REQUEST_INVALID")
        _check(len(value["documentText"].encode("utf-8")) <= DOCUMENT_BYTES, "INPUT_LIMIT")
        _check(len(_json_text(request).encode("utf-8")) <= 1048576, "INPUT_LIMIT")
    except Exception as error:
        if _error_code(error, None) is not None:
            raise
        raise OpenApiImportError("REQUEST_INVALID") from None
    return request


def _metadata(value):
    source = value["documentText"]
    try:
        document = _json_value(source)
    except Exception:
        raise OpenApiImportError("DOCUMENT_INVALID") from None
    pending = [(document, 1)]
    while pending:
        current, depth = pending.pop()
        if type(current) not in (dict, list):
            continue
        _check(depth <= DOCUMENT_DEPTH, "DOCUMENT_DEPTH")
        pending.extend((child, depth + 1) for child in (current.values() if type(current) is dict else current))
    # Check duplicates after parsing and depth, preserving the reference order.
    # Numbers in unretained metadata may exceed the logical-value number range.
    try:
        _json_value(source, reject_duplicates=True)
    except Exception:
        raise OpenApiImportError("DOCUMENT_INVALID") from None
    _check(type(document) is dict and _matches(document.get("openapi"), _VERSION), "VERSION_UNSUPPORTED")
    info = document.get("info")
    _check(type(info) is dict and type(info.get("title")) is str and type(info.get("version")) is str, "DOCUMENT_INVALID")
    _check("paths" in document, "TARGET_MISSING")
    paths = document["paths"]
    _check(type(paths) is dict, "DOCUMENT_INVALID")
    _check(value["path"] in paths, "TARGET_MISSING")
    item = paths[value["path"]]
    _check(type(item) is dict, "DOCUMENT_INVALID")
    _check("$ref" not in item, "REFERENCE_UNSUPPORTED")
    _check(value["method"] in item, "TARGET_MISSING")
    operation = item[value["method"]]
    _check(type(operation) is dict, "DOCUMENT_INVALID")
    _check("$ref" not in operation, "REFERENCE_UNSUPPORTED")
    selected = {"path": value["path"], "method": value["method"]}
    if "operationId" in operation:
        _check(_text(operation["operationId"], 512), "DOCUMENT_INVALID")
        selected["operationId"] = operation["operationId"]
    return {"kind": "openapi-operation-snapshot", "externalIdentity": {"system": "openapi", "externalId": value["externalId"]},
            "locator": _pointer(value["path"], value["method"]), "digest": "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "digestRule": "sha256-utf8-document", "openapiVersion": document["openapi"], "operation": selected, "informationLoss": list(LOSS)}


def validate_openapi_import_result(result, request=None):
    """Validate a result, optionally binding its metadata to the source bytes."""
    try:
        validate_plugin_run_result(result, request)
        if request is not None:
            validate_openapi_import_request(request)
        _check(result["plugin"]["id"] == PLUGIN_ID and result["plugin"]["version"] == PLUGIN_VERSION and
               result["capabilityId"] == CAPABILITY_ID, "RESULT_INVALID")
        if result["status"] == "failure":
            return result
        value = result["output"]
        operation = value.get("operation")
        fields = {"path", "method", "operationId"} if type(operation) is dict and "operationId" in operation else {"path", "method"}
        _check(_keys(value, SNAPSHOT_KEYS) and value["kind"] == "openapi-operation-snapshot" and
               _keys(value["externalIdentity"], {"system", "externalId"}) and value["externalIdentity"]["system"] == "openapi" and
               _text(value["externalIdentity"]["externalId"], 512) and _matches(value["openapiVersion"], _VERSION) and
               _keys(operation, fields) and _path(operation["path"]) and operation["method"] in METHODS and
               ("operationId" not in operation or _text(operation["operationId"], 512)) and
               value["locator"] == _pointer(operation["path"], operation["method"]) and _matches(value["digest"], _DIGEST) and
               value["digestRule"] == "sha256-utf8-document" and _matches(value["retrievedAt"], _TIME) and
               canonical_json(value["informationLoss"]) == canonical_json(list(LOSS)), "RESULT_INVALID")
        if request is not None:
            snapshot = {key: item for key, item in value.items() if key != "retrievedAt"}
            _check(canonical_json(snapshot) == canonical_json(_metadata(request["input"])), "RESULT_MISMATCH")
    except Exception as error:
        if _error_code(error, None) == "OPENAPI_IMPORT_RESULT_MISMATCH":
            raise
        raise OpenApiImportError("RESULT_INVALID") from None
    return result


def import_openapi_operation(input=None, *, now=_UNSET):
    """Inspect one JSON document and return a detached success or fixed failure."""
    run_id = "invalid-run"
    try:
        validate_openapi_import_request(input)
        request = copy.deepcopy(input)
        run_id = request["runId"]
        output = _metadata(request["input"])
        clock = (lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")) if now is _UNSET else now
        _check(callable(clock), "CLOCK_INVALID")
        retrieved_at = clock()
        _check(_matches(retrieved_at, _TIME), "CLOCK_INVALID")
        result = {"format": "morivyx.plugin-run-result/0.1", "runId": run_id,
                  "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION}, "capabilityId": CAPABILITY_ID,
                  "status": "success", "output": {**output, "retrievedAt": retrieved_at}}
        validate_openapi_import_result(result, request)
        return result
    except Exception as error:
        return {"format": "morivyx.plugin-run-result/0.1", "runId": run_id,
                "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION}, "capabilityId": CAPABILITY_ID,
                "status": "failure", "failure": {"code": _error_code(error, "OPENAPI_IMPORT_FAILED"), "message": MESSAGE}}


def _descriptor(value):
    return {key: value[key] for key in ("digest", "digestRule", "retrievedAt")}


def _report(status, codes, previous=None, current=None):
    return {"format": COMPARISON_FORMAT, "externalIdentity": dict(previous["externalIdentity"]) if previous is not None else None,
            "locator": previous["locator"] if previous is not None else None,
            "previous": _descriptor(previous) if previous is not None else None, "current": current, "status": status,
            "issues": [{"code": "OPENAPI_REIMPORT_" + code} for code in codes]}


def _compare_times(left, right):
    first, second = json.loads(canonical_json(left)), json.loads(canonical_json(right))
    if first[:19] != second[:19]:
        return -1 if first[:19] < second[:19] else 1
    a, b = first[19:-1].removeprefix("."), second[19:-1].removeprefix(".")
    width = max(len(a), len(b))
    a, b = a.ljust(width, "0"), b.ljust(width, "0")
    return 0 if a == b else -1 if a < b else 1


def compare_openapi_import_snapshots(input=None):
    """Recompute claimed absence and compare validated snapshots without writes."""
    try:
        if len(canonical_json(input).encode("utf-8")) > 2097152 or not _keys(input, {"previousResult", "currentRequest", "currentResult"}):
            return _report("invalid", ["INPUT_INVALID"])
    except Exception:
        return _report("invalid", ["INPUT_INVALID"])
    previous_result, request, result = input["previousResult"], input["currentRequest"], input["currentResult"]
    try:
        validate_openapi_import_result(previous_result)
        if previous_result["status"] != "success":
            return _report("invalid", ["PREVIOUS_INVALID"])
    except Exception:
        return _report("invalid", ["PREVIOUS_INVALID"])
    previous = previous_result["output"]
    try:
        validate_openapi_import_request(request)
        validate_openapi_import_result(result, request)
    except Exception:
        return _report("invalid", ["CURRENT_INVALID"], previous)
    if previous["externalIdentity"]["externalId"] != request["input"]["externalId"] or \
            previous["operation"]["path"] != request["input"]["path"] or previous["operation"]["method"] != request["input"]["method"]:
        return _report("invalid", ["IDENTITY_MISMATCH"], previous)
    if result["status"] == "failure":
        if result["failure"]["code"] != "OPENAPI_IMPORT_TARGET_MISSING":
            return _report("invalid", ["FAILURE_UNSUPPORTED"], previous)
        recomputed = import_openapi_operation(request, now=lambda: previous["retrievedAt"])
        if recomputed["status"] != "failure" or recomputed["failure"]["code"] != "OPENAPI_IMPORT_TARGET_MISSING":
            return _report("invalid", ["CURRENT_NOT_MISSING"], previous)
        return _report("missing", [], previous, {"status": "missing", "failureCode": "OPENAPI_IMPORT_TARGET_MISSING",
                       "documentDigest": "sha256:" + hashlib.sha256(request["input"]["documentText"].encode("utf-8")).hexdigest(),
                       "digestRule": "sha256-utf8-document"})
    snapshot = result["output"]
    current = {"status": "resolved", **_descriptor(snapshot)}
    if _compare_times(snapshot["retrievedAt"], previous["retrievedAt"]) < 0:
        return _report("invalid", ["TIME_REGRESSION"], previous, current)
    if snapshot["digest"] != previous["digest"]:
        return _report("stale", [], previous, current)
    before = {key: value for key, value in previous.items() if key != "retrievedAt"}
    after = {key: value for key, value in snapshot.items() if key != "retrievedAt"}
    if canonical_json(before) != canonical_json(after):
        return _report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current)
    return _report("current", [], previous, current)


def main():
    from plugin_stdio import _close, _write, serve_plugin_stdio
    if sys.argv[1:] == ["--stdio"]:
        result = asyncio.run(serve_plugin_stdio({"handleRequest": import_openapi_operation,
                            "validateRequest": validate_openapi_import_request, "validateResult": validate_openapi_import_result}))
        return result["exitCode"]
    try:
        if len(sys.argv) != 1:
            raise ValueError("arguments")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        if not _keys(value, {"operation", "input"}):
            raise ValueError("envelope")
        operation, data = value["operation"], value["input"]
        if operation == "validate-request":
            validate_openapi_import_request(data)
            output = {"valid": True}
        elif operation == "validate-result" and type(data) is dict and set(data) <= {"result", "request"} and "result" in data:
            validate_openapi_import_result(data["result"], data.get("request"))
            output = {"valid": True}
        elif operation == "import":
            output = {"result": import_openapi_operation(data)}
        elif operation == "compare":
            output = {"report": compare_openapi_import_snapshots(data)}
        else:
            raise ValueError("operation")
        raw = (_json_text(output) + "\n").encode("utf-8")
        if len(raw) > LIMIT:
            raise ValueError("output")
        try:
            _write(sys.stdout.buffer, raw)
        except Exception:
            _close(sys.stdout.buffer)
            raise ValueError("output") from None
    except (ValueError, TypeError, KeyError, OSError, RecursionError, OverflowError):
        try:
            _write(sys.stderr.buffer, b'{"error":{"code":"OPENAPI_IMPORT_INPUT_INVALID","path":"/"}}\n')
        except Exception:
            _close(sys.stderr.buffer)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
