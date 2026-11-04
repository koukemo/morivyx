"""Compare supplied plugin artifact bytes to pins; authenticity stays unverified.

No fetching, signature verification, code execution or filesystem access occurs.
Only exact built-in records and supported local byte buffers are inspected.
"""

import base64
import hashlib
import json
import re
import sys

from canonical import load_json
from plugin_manifest import validate_plugin_manifest
from stdin_transport import read_bounded_stdin

FORMAT = "morivyx.plugin-supply-chain/0.1"
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
CLI_LIMIT = 48 * 1024 * 1024
_ARTIFACTS = ("package", "signature", "sbom")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def _record(value, allowed, required=()):
    return type(value) is dict and all(type(key) is str and key in allowed for key in value) and \
        all(key in value for key in required)


def _report(status, issues, manifest=None, pin=None):
    return {
        "format": FORMAT,
        "plugin": None if manifest is None else {key: manifest["identity"][key] for key in ("id", "version", "distributor")},
        "source": None if manifest is None else manifest["supplyChain"]["source"],
        "expectedPackageDigest": pin,
        "package": None, "signature": None, "sbom": None,
        "status": status, "authenticity": "not-verified", "issues": issues,
    }


def _invalid(code):
    return _report("invalid", [{"code": "PLUGIN_SUPPLY_CHAIN_" + code}])


def _view(value):
    if type(value) in (bytes, bytearray):
        return memoryview(value)
    if type(value) is memoryview and type(value.obj) in (bytes, bytearray) and \
            value.ndim == 1 and value.format == "B" and value.c_contiguous:
        return value
    raise ValueError("bytes")


def verify_plugin_supply_chain(value):
    """Return detached byte-comparison evidence, never an authenticity claim."""
    fields = ("manifest", "expectedPackageDigest", "artifacts")
    if not _record(value, fields, fields):
        return _invalid("INPUT_INVALID")
    manifest, pin, artifacts = (value[key] for key in fields)
    try:
        validate_plugin_manifest(manifest)
    except Exception:
        return _invalid("MANIFEST_INVALID")
    if type(pin) is not str or _DIGEST.fullmatch(pin) is None:
        return _invalid("PIN_INVALID")
    if manifest["identity"]["packageDigest"] != pin:
        return _report("mismatch", [{"code": "PLUGIN_SUPPLY_CHAIN_PIN_MISMATCH"}], manifest, pin)
    if not _record(artifacts, _ARTIFACTS):
        return _invalid("ARTIFACTS_INVALID")
    expected = {"package": pin, **{name: manifest["supplyChain"].get(name + "Digest") for name in ("signature", "sbom")}}
    views, total = {}, 0
    for name in _ARTIFACTS:
        if name not in artifacts:
            continue
        if expected[name] is None:
            return _invalid("ARTIFACT_UNDECLARED")
        try:
            view = _view(artifacts[name])
            length = view.nbytes
        except (ValueError, TypeError):
            return _invalid("BYTES_INVALID")
        total += length
        if length > MAX_ARTIFACT_BYTES or total > MAX_TOTAL_BYTES:
            return _invalid("LIMIT_EXCEEDED")
        views[name] = view
    result = _report("matched", [], manifest, pin)
    for name in _ARTIFACTS:
        if expected[name] is None:
            continue
        # Copy mutable buffers only after all lengths pass. No buffer survives in
        # the report. Captures of separate inputs are not a global atomic snapshot.
        data = bytes(views[name]) if name in views else None
        digest = None if data is None else "sha256:" + hashlib.sha256(data).hexdigest()
        status = "missing" if data is None else "matched" if digest == expected[name] else "mismatch"
        result[name] = {"expectedDigest": expected[name], "actualDigest": digest,
                        "byteLength": None if data is None else len(data), "status": status}
        if status != "matched":
            result["issues"].append({"code": "PLUGIN_SUPPLY_CHAIN_ARTIFACT_" + ("MISSING" if status == "missing" else "MISMATCH"),
                                     "artifact": name})
            if status == "mismatch" or result["status"] == "matched":
                result["status"] = "mismatch" if status == "mismatch" else "incomplete"
    return result


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("arguments")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, CLI_LIMIT).decode("utf-8", errors="strict"))
        fields = ("operation", "manifest", "expectedPackageDigest", "artifacts")
        if not _record(value, fields, fields) or value["operation"] != "verify" or type(value["artifacts"]) is not dict:
            raise ValueError("envelope")
        artifacts = {}
        for name, encoded in value["artifacts"].items():
            if type(encoded) is not str or not encoded.isascii():
                raise ValueError("base64")
            data = base64.b64decode(encoded, validate=True)
            if base64.b64encode(data).decode("ascii") != encoded:
                raise ValueError("base64")
            artifacts[name] = data
        report = verify_plugin_supply_chain({key: value[key] for key in ("manifest", "expectedPackageDigest")} | {"artifacts": artifacts})
        output = (json.dumps({"report": report}, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(output) > CLI_LIMIT:
            raise ValueError("output")
        sys.stdout.buffer.write(output)
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError, OverflowError):
        print('{"error":{"code":"PLUGIN_SUPPLY_CHAIN_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
