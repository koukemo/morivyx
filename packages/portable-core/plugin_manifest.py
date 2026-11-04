"""Validate declared plugin metadata without granting permissions or running code.

The API preserves the existing Node contract's raw string set and diagnostic
ordering. The bounded JSON CLI uses fixed diagnostics, without input paths.
"""

import json
import re
import sys

from canonical import canonical_json, load_json
from schema_validation import ValidationError, safe_integer
from stdin_transport import read_bounded_stdin

FORMAT = "morivyx.plugin-manifest/0.1"
LIMIT = 8 * 1024 * 1024
INVALID = "PLUGIN_MANIFEST_INVALID"
EFFECTS = {"pure", "read-only", "artifact-write", "external-effect", "physical-effect"}
RETRIES = {"idempotent", "safe-to-retry", "reconcile-required", "manual-recovery"}
CONTRACTS = {"morivyx.plugin-run-request/0.1", "morivyx.plugin-run-result/0.1"}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def _require(value, path, code=INVALID):
    if not value:
        raise ValidationError(code, path)


def _text(value):
    return type(value) is str and len(value) > 0


def _record(value, path):
    try:
        _require(type(value) is dict, path)
        canonical_json(value)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValidationError(INVALID, path) from None


def _keys(value, allowed, path):
    # Object.keys enumerates array-index names before other insertion-order keys.
    indices = sorted((key for key in value if re.fullmatch(r"(?:0|[1-9][0-9]*)", key)
                      and len(key) <= 10 and int(key) < 4294967295), key=int)
    index_names = set(indices)
    ordered = [*indices, *(key for key in value if key not in index_names)]
    for key in ordered:
        _require(key in allowed, path + "/" + key, "PLUGIN_MANIFEST_FIELD_UNKNOWN")


def _digest(value, path):
    _require(_text(value) and DIGEST.fullmatch(value) is not None, path)


def _string_set(value, path, nonempty=False):
    _require(type(value) is list and (not nonempty or len(value) > 0), path)
    _require(all(_text(entry) for entry in value), path)
    # The declaration contract uses raw strings, not an NFC-normalized set.
    _require(len(set(value)) == len(value), path)


def _identity(value):
    path = "/identity"
    _record(value, path)
    _keys(value, {"id", "version", "packageDigest", "distributor"}, path)
    _require(all(_text(value.get(key)) for key in ("id", "version", "distributor")), path)
    _digest(value.get("packageDigest"), path + "/packageDigest")


def _compatibility(value):
    path = "/compatibility"
    _record(value, path)
    _keys(value, {"communicationContracts", "coreSchemas", "profileSchemas"}, path)
    _string_set(value.get("communicationContracts"), path + "/communicationContracts", True)
    _string_set(value.get("coreSchemas"), path + "/coreSchemas")
    _string_set(value.get("profileSchemas"), path + "/profileSchemas")
    _require(set(value["communicationContracts"]) == CONTRACTS, path + "/communicationContracts",
             "PLUGIN_MANIFEST_COMPATIBILITY_UNSUPPORTED")


def _permissions(value, path):
    _record(value, path)
    names = ("graphRead", "fileRead", "network", "secrets", "devices")
    _keys(value, set(names), path)
    for name in names:
        _string_set(value.get(name), path + "/" + name)


def _resources(value, path):
    _record(value, path)
    _keys(value, {"timeoutMs", "maxOutputBytes", "maxMemoryBytes", "maxCostUnits"}, path)
    for name in ("timeoutMs", "maxOutputBytes"):
        number = value.get(name)
        _require(safe_integer(number) and number > 0, path + "/" + name)
    for name in ("maxMemoryBytes", "maxCostUnits"):
        if name in value:
            _require(safe_integer(value[name]) and value[name] > 0, path + "/" + name)


def _capability(value, path):
    _record(value, path)
    _keys(value, {"id", "effect", "inputFormat", "outputFormat", "permissions", "retry", "resources"}, path)
    _require(_text(value.get("id")) and type(value.get("effect")) is str and value["effect"] in EFFECTS
             and _text(value.get("inputFormat")) and _text(value.get("outputFormat"))
             and type(value.get("retry")) is str and value["retry"] in RETRIES, path)
    _permissions(value.get("permissions"), path + "/permissions")
    _resources(value.get("resources"), path + "/resources")


def _supply_chain(value):
    path = "/supplyChain"
    _record(value, path)
    _keys(value, {"source", "signatureDigest", "sbomDigest"}, path)
    _require(_text(value.get("source")), path + "/source")
    for name in ("signatureDigest", "sbomDigest"):
        if name in value:
            _digest(value[name], path + "/" + name)


def validate_plugin_manifest(manifest):
    """Check the declaration structure and return the original, unchanged value."""
    _record(manifest, "/")
    _keys(manifest, {"format", "identity", "compatibility", "capabilities", "supplyChain", "migrations"}, "")
    _require(manifest.get("format") == FORMAT, "/format")
    _identity(manifest.get("identity"))
    _compatibility(manifest.get("compatibility"))
    capabilities = manifest.get("capabilities")
    _require(type(capabilities) is list and len(capabilities) > 0, "/capabilities")
    identities = set()
    for index, capability in enumerate(capabilities):
        path = "/capabilities/" + str(index)
        _capability(capability, path)
        _require(capability["id"] not in identities, path + "/id", "PLUGIN_MANIFEST_CAPABILITY_DUPLICATE")
        identities.add(capability["id"])
    _supply_chain(manifest.get("supplyChain"))
    _string_set(manifest.get("migrations"), "/migrations")
    return manifest


def get_declared_plugin_capability(manifest, capability_id):
    """Return a declared capability; this does not assess or grant permissions."""
    validate_plugin_manifest(manifest)
    _require(_text(capability_id), "/capabilityId", "PLUGIN_CAPABILITY_UNDECLARED")
    for capability in manifest["capabilities"]:
        if capability["id"] == capability_id:
            return capability
    raise ValidationError("PLUGIN_CAPABILITY_UNDECLARED", "/capabilityId")


def main():
    try:
        _require(len(sys.argv) == 1, "/")
        request = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        _require(type(request) is dict, "/")
        operation = request.get("operation")
        if operation == "validate":
            _require(set(request) == {"operation", "manifest"}, "/")
            validate_plugin_manifest(request["manifest"])
            result = {"valid": True}
        elif operation == "capability":
            _require(set(request) == {"operation", "manifest", "capabilityId"}, "/")
            result = {"capability": get_declared_plugin_capability(request["manifest"], request["capabilityId"])}
        else:
            raise ValueError("unknown operation")
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        _require(len(output) <= LIMIT, "/")
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, RecursionError, OverflowError):
        print('{"error":{"code":"PLUGIN_MANIFEST_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
