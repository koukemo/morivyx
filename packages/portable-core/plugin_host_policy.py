"""Statically compare a declared capability with host-provided permission data.

This mirrors the existing policy API; it neither installs permissions nor
enforces resource limits or executes plugin code.
"""

import copy
import json
import re
import sys

from canonical import canonical_json, load_json
from plugin_manifest import get_declared_plugin_capability
from schema_validation import ValidationError, safe_integer
from stdin_transport import read_bounded_stdin

FORMAT = "morivyx.plugin-host-policy/0.1"
LIMIT = 8 * 1024 * 1024
PERMISSIONS = ("graphRead", "fileRead", "network", "secrets", "devices")
REQUIRED_LIMITS = ("timeoutMs", "maxOutputBytes")
OPTIONAL_LIMITS = ("maxMemoryBytes", "maxCostUnits")


def _deny(code):
    raise ValidationError("PLUGIN_HOST_POLICY_" + code, "/policy")


def _record(value, keys, required=None):
    return type(value) is dict and set(value).issubset(keys) and set(keys if required is None else required).issubset(value)


def _text(value):
    return type(value) is str and len(value) > 0


def validate_plugin_host_policy(policy):
    """Validate permission data, returning the original unchanged mapping."""
    try:
        canonical_json(policy)
    except (ValueError, TypeError, RecursionError, OverflowError):
        _deny("INVALID")
    if not _record(policy, {"format", "plugin", "capability"}) or policy["format"] != FORMAT:
        _deny("INVALID")
    plugin, capability = policy["plugin"], policy["capability"]
    if not _record(plugin, {"id", "version", "packageDigest"}) or not _text(plugin["id"]) or not _text(plugin["version"]) or \
            type(plugin["packageDigest"]) is not str or re.fullmatch(r"sha256:[0-9a-f]{64}", plugin["packageDigest"]) is None:
        _deny("INVALID")
    if not _record(capability, {"id", "effect", "permissions", "resources"}) or not _text(capability["id"]) or \
            type(capability["effect"]) is not str or capability["effect"] not in ("pure", "read-only"):
        _deny("INVALID")
    permissions, resources = capability["permissions"], capability["resources"]
    if not _record(permissions, PERMISSIONS) or any(type(permissions[key]) is not list or
            any(not _text(name) for name in permissions[key]) or len(set(permissions[key])) != len(permissions[key])
            for key in PERMISSIONS):
        _deny("INVALID")
    if not _record(resources, (*REQUIRED_LIMITS, *OPTIONAL_LIMITS), REQUIRED_LIMITS) or \
            any(not safe_integer(value) or value <= 0 for value in resources.values()):
        _deny("INVALID")
    return policy


def authorize_plugin_host_policy(manifest, capability_id, policy):
    """Return a detached capability with the smaller declared and allowed limits.

    A successful result is a static comparison, not an OS permission grant.
    Declaration errors retain priority over policy errors.
    """
    capability = get_declared_plugin_capability(manifest, capability_id)
    validate_plugin_host_policy(policy)
    if any(manifest["identity"][key] != policy["plugin"][key] for key in ("id", "version", "packageDigest")):
        _deny("IDENTITY_MISMATCH")
    if capability["id"] != policy["capability"]["id"] or capability["effect"] != policy["capability"]["effect"]:
        _deny("CAPABILITY_DENIED")
    if any(any(name not in policy["capability"]["permissions"][key] for name in capability["permissions"][key])
           for key in PERMISSIONS):
        _deny("PERMISSION_DENIED")
    resources = {}
    for key in (*REQUIRED_LIMITS, *OPTIONAL_LIMITS):
        declared, allowed = capability["resources"], policy["capability"]["resources"]
        if key in declared or key in allowed:
            resources[key] = min(value[key] for value in (declared, allowed) if key in value)
    result = copy.deepcopy(capability)
    result["resources"] = resources
    return result


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("arguments")
        request = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        if type(request) is not dict:
            raise ValueError("request")
        if request.get("operation") == "validate" and set(request) == {"operation", "policy"}:
            validate_plugin_host_policy(request["policy"])
            result = {"valid": True}
        elif request.get("operation") == "authorize" and set(request) == {"operation", "manifest", "capabilityId", "policy"}:
            result = {"capability": authorize_plugin_host_policy(request["manifest"], request["capabilityId"], request["policy"])}
        else:
            raise ValueError("operation")
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(output) > LIMIT:
            raise ValueError("output")
        sys.stdout.buffer.write(output)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, RecursionError, OverflowError):
        print('{"error":{"code":"PLUGIN_HOST_POLICY_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
