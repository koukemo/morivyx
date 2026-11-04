"""Validate plugin messages and bind requests to declarations without execution.

These APIs preserve input references. They do not create execution grants,
check host permission data, launch processes, or authenticate message authors.
"""

import json
import re
import sys

from canonical import canonical_json, load_json
from plugin_manifest import EFFECTS, get_declared_plugin_capability, validate_plugin_manifest
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin

REQUEST_FORMAT = "morivyx.plugin-run-request/0.1"
RESULT_FORMAT = "morivyx.plugin-run-result/0.1"
LIMIT = 8 * 1024 * 1024


def _require(condition, code, path):
    if not condition:
        raise ValidationError(code, path)


def _text(value):
    return type(value) is str and len(value) > 0


def _record(value, code, path):
    _require(type(value) is dict, code, path)
    try:
        canonical_json(value)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValidationError(code, path) from None


def _keys(value, allowed, path):
    # Preserve ECMAScript array-index enumeration and raw diagnostic paths.
    indices = sorted((key for key in value if re.fullmatch(r"(?:0|[1-9][0-9]*)", key)
                      and len(key) <= 10 and int(key) < 4294967295), key=int)
    indexed = set(indices)
    for key in (*indices, *(key for key in value if key not in indexed)):
        _require(key in allowed, "PLUGIN_MESSAGE_FIELD_UNKNOWN", path + "/" + key)


def _plugin(value):
    _record(value, "PLUGIN_MESSAGE_INVALID", "/plugin")
    _keys(value, {"id", "version"}, "/plugin")
    _require(_text(value.get("id")) and _text(value.get("version")), "PLUGIN_MESSAGE_INVALID", "/plugin")


def validate_plugin_run_request(request):
    """Validate a logical request, returning the original unchanged mapping."""
    _record(request, "PLUGIN_REQUEST_INVALID", "/")
    _keys(request, {"format", "runId", "plugin", "capability", "input"}, "")
    _require(request.get("format") == REQUEST_FORMAT and _text(request.get("runId")), "PLUGIN_REQUEST_INVALID", "/")
    _plugin(request.get("plugin"))
    capability = request.get("capability")
    _record(capability, "PLUGIN_MESSAGE_INVALID", "/capability")
    _keys(capability, {"id", "effect"}, "/capability")
    _require(_text(capability.get("id")) and type(capability.get("effect")) is str and capability["effect"] in EFFECTS,
             "PLUGIN_MESSAGE_INVALID", "/capability")
    _record(request.get("input"), "PLUGIN_REQUEST_INVALID", "/input")
    return request


def authorize_plugin_run_request(manifest, request):
    """Bind the request to the declaration, returning its original capability.

    A matching declaration is not a host permission grant.
    """
    validate_plugin_manifest(manifest)
    validate_plugin_run_request(request)
    _require(request["plugin"]["id"] == manifest["identity"]["id"] and
             request["plugin"]["version"] == manifest["identity"]["version"],
             "PLUGIN_MANIFEST_IDENTITY_MISMATCH", "/plugin")
    _require(request["format"] in manifest["compatibility"]["communicationContracts"],
             "PLUGIN_MANIFEST_COMPATIBILITY_UNSUPPORTED", "/format")
    capability = get_declared_plugin_capability(manifest, request["capability"]["id"])
    _require(request["capability"]["effect"] == capability["effect"], "PLUGIN_CAPABILITY_EFFECT_MISMATCH", "/capability/effect")
    return capability


def validate_plugin_run_result(result, request=None):
    """Validate a result and optional request binding, returning the input."""
    _record(result, "PLUGIN_RESULT_INVALID", "/")
    _keys(result, {"format", "runId", "plugin", "capabilityId", "status", "output", "failure"}, "")
    _require(result.get("format") == RESULT_FORMAT and _text(result.get("runId")) and _text(result.get("capabilityId")) and
             type(result.get("status")) is str and result["status"] in ("success", "failure"), "PLUGIN_RESULT_INVALID", "/")
    _plugin(result.get("plugin"))
    if request is not None:
        validate_plugin_run_request(request)
        _require(result["runId"] == request["runId"] and result["plugin"]["id"] == request["plugin"]["id"] and
                 result["plugin"]["version"] == request["plugin"]["version"] and result["capabilityId"] == request["capability"]["id"],
                 "PLUGIN_RESULT_MISMATCH", "/")
    if result["status"] == "success":
        _require("output" in result and "failure" not in result, "PLUGIN_RESULT_INVALID", "/output")
        _record(result["output"], "PLUGIN_RESULT_INVALID", "/output")
    else:
        _require("failure" in result and "output" not in result, "PLUGIN_RESULT_INVALID", "/")
        failure = result["failure"]
        _record(failure, "PLUGIN_RESULT_INVALID", "/failure")
        _keys(failure, {"code", "message"}, "/failure")
        _require(_text(failure.get("code")) and _text(failure.get("message")), "PLUGIN_RESULT_INVALID", "/failure")
    return result


def main():
    try:
        _require(len(sys.argv) == 1, "PLUGIN_MESSAGES_INPUT_INVALID", "/")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        _require(type(value) is dict, "PLUGIN_MESSAGES_INPUT_INVALID", "/")
        operation = value.get("operation")
        if operation == "validate-request" and set(value) == {"operation", "request"}:
            validate_plugin_run_request(value["request"])
            result = {"valid": True}
        elif operation == "authorize-request" and set(value) == {"operation", "manifest", "request"}:
            result = {"capability": authorize_plugin_run_request(value["manifest"], value["request"])}
        elif operation == "validate-result" and set(value) in ({"operation", "result"}, {"operation", "result", "request"}):
            validate_plugin_run_result(value["result"], value.get("request"))
            result = {"valid": True}
        else:
            raise ValueError("operation")
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        _require(len(output) <= LIMIT, "PLUGIN_MESSAGES_INPUT_INVALID", "/")
        sys.stdout.buffer.write(output)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, RecursionError, OverflowError):
        print('{"error":{"code":"PLUGIN_MESSAGES_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
