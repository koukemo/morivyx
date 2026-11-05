"""Independent local file snapshots and repository reimport decisions.

Paths follow the POSIX reference contract. This reads an explicitly selected
local root; it is not a filesystem sandbox and does not prevent path replacement
between resolution and reading. Comparison and assessment never write files.
"""

import asyncio
import copy
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
import re
import sys

from canonical import canonical_json, load_json
from plugin_messages import validate_plugin_run_request, validate_plugin_run_result
from schema_validation import ValidationError
from stdin_transport import read_bounded_stdin

PLUGIN_ID = "morivyx.repository-importer.dev"
PLUGIN_VERSION = "0.1.0"
CAPABILITY_ID = "repository.read-file"
COMPARISON_FORMAT = "morivyx.repository-import-comparison/0.1"
ASSESSMENT_FORMAT = "morivyx.repository-reimport-assessment/0.1"
EXTERNAL_STATUSES = {"current", "stale", "missing", "unavailable", "invalid"}
LIMIT = 8 * 1024 * 1024
_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


class RepositoryImportError(ValidationError):
    def __init__(self, code, path, message):
        super().__init__(code, path)
        self.message = message


def _require(condition, code, path, message):
    if not condition:
        raise RepositoryImportError(code, path, message)


def _text(value):
    return type(value) is str and len(value) > 0


def _logical(value):
    if type(value) is not dict:
        return False
    try:
        canonical_json(value)
        return True
    except (ValueError, TypeError, RecursionError, OverflowError):
        return False


def _request_diagnostic(request, error):
    code, path = error.code, error.path
    if code == "PLUGIN_MESSAGE_FIELD_UNKNOWN":
        # A root key can itself contain 'plugin/' or 'capability/'. The error
        # path alone cannot identify the owner of an unknown field.
        owners = [(request, {"format", "runId", "plugin", "capability", "input"})]
        if type(request.get("plugin")) is dict:
            owners.append((request["plugin"], {"id", "version"}))
        if type(request.get("capability")) is dict:
            owners.append((request["capability"], {"id", "effect"}))
        key = next(key for owner, allowed in owners for key in _ordered_keys(owner) if key not in allowed)
        message = "未定義のPlugin通信項目です: " + key
    elif code == "PLUGIN_REQUEST_INVALID":
        message = ("Plugin入力は対応表でなければなりません。" if path == "/input" else
                   "Plugin RunRequestのformatまたはrunIdが不正です。" if _logical(request) else
                   "Plugin RunRequestは論理的な対応表でなければなりません。")
    elif path == "/plugin":
        message = ("Plugin IDとversionは空でない文字列でなければなりません。" if
                   _logical(request.get("plugin")) else "Plugin識別情報は対応表でなければなりません。")
    else:
        message = ("Capability IDとeffectが不正です。" if _logical(request.get("capability")) else
                   "Capabilityは対応表でなければなりません。")
    return RepositoryImportError(code, path, message)


def _ordered_keys(value):
    indices = sorted((key for key in value if re.fullmatch(r"(?:0|[1-9][0-9]*)", key) and
                      len(key) <= 10 and int(key) < 4294967295), key=int)
    indexed = set(indices)
    return (*indices, *(key for key in value if key not in indexed))


def validate_repository_import_request(request):
    """Validate and return the original logical request without normalization."""
    try:
        validate_plugin_run_request(request)
    except ValidationError as error:
        raise _request_diagnostic(request, error) from None
    _require(request["plugin"]["id"] == PLUGIN_ID and request["plugin"]["version"] == PLUGIN_VERSION and
             request["capability"]["id"] == CAPABILITY_ID and request["capability"]["effect"] == "read-only",
             "REPOSITORY_IMPORT_REQUEST_INVALID", "/", "repository ImporterのPluginまたはCapabilityが一致しません。")
    value = request["input"]
    # ECMAScript enumerates array-index keys before other string keys.
    for key in _ordered_keys(value):
        _require(key in {"repositoryRoot", "externalId", "locator"}, "REPOSITORY_IMPORT_REQUEST_INVALID",
                 "/input/" + key, "未定義のrepository Importer入力です: " + key)
    _require(all(_text(value.get(key)) for key in ("repositoryRoot", "externalId", "locator")),
             "REPOSITORY_IMPORT_REQUEST_INVALID", "/input",
             "repositoryRoot、externalId、locatorは空でない文字列でなければなりません。")
    locator = value["locator"]
    _require(not locator.startswith("/") and "\\" not in locator and
             all(part not in ("", ".", "..") for part in locator.split("/")),
             "REPOSITORY_IMPORT_LOCATOR_INVALID", "/input/locator", "locatorはrepository内の相対POSIX pathでなければなりません。")
    return request


def validate_repository_import_result(result, request=None):
    """Validate a snapshot or failure and its optional original request binding."""
    validate_plugin_run_result(result, request)
    _require(result["plugin"]["id"] == PLUGIN_ID and result["plugin"]["version"] == PLUGIN_VERSION and
             result["capabilityId"] == CAPABILITY_ID, "REPOSITORY_IMPORT_RESULT_INVALID", "/",
             "repository取込結果のPluginまたはCapabilityが一致しません。")
    if result["status"] != "success":
        return result
    output = result["output"]
    _require(set(output) <= {"kind", "externalIdentity", "locator", "digest", "digestRule", "retrievedAt"},
             "REPOSITORY_IMPORT_RESULT_INVALID", "/output", "repository取込結果に未定義の項目があります。")
    identity = output.get("externalIdentity")
    _require(output.get("kind") == "repository-file-snapshot" and type(identity) is dict and
             identity.get("system") == "repository" and _text(identity.get("externalId")) and
             set(identity) <= {"system", "externalId"} and _text(output.get("locator")) and
             _text(output.get("digest")) and _DIGEST.fullmatch(output["digest"]) is not None and
             output.get("digestRule") == "sha256-bytes" and _text(output.get("retrievedAt")) and
             _TIMESTAMP.fullmatch(output["retrievedAt"]) is not None,
             "REPOSITORY_IMPORT_RESULT_INVALID", "/output",
             "repository取込結果の外部同一性、読取位置、digest、取得時刻が不正です。")
    if request is not None:
        _require(identity["externalId"] == request["input"].get("externalId") and
                 output["locator"] == request["input"].get("locator"),
                 "REPOSITORY_IMPORT_RESULT_MISMATCH", "/output",
                 "repository取込結果の外部同一性または読取位置がRunRequestと一致しません。")
    return result


def repository_import_request(*, run_id, repository_root, external_id, locator):
    """Build an unchecked request; validation is a separate operation."""
    return {"format": "morivyx.plugin-run-request/0.1", "runId": run_id,
            "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION},
            "capability": {"id": CAPABILITY_ID, "effect": "read-only"},
            "input": {"repositoryRoot": repository_root, "externalId": external_id, "locator": locator}}


def _failure(request, error):
    run_id = request.get("runId") if type(request) is dict and all(type(key) is str for key in request) else None
    try:
        if not _text(run_id):
            raise ValueError("run")
        canonical_json(run_id)
    except (ValueError, TypeError, RecursionError, OverflowError):
        run_id = "invalid-run"
    # Exact internal error types avoid arbitrary exception attribute access.
    failure = {"code": "REPOSITORY_IMPORT_FAILED", "message": "repositoryを読み取れませんでした。"}
    if type(error) is RepositoryImportError:
        data = vars(error)
        if type(data) is dict and all(type(key) is str for key in data) and _text(data.get("code")) and _text(data.get("message")):
            try:
                canonical_json({"code": data["code"], "message": data["message"]})
                failure = {"code": data["code"], "message": data["message"]}
            except (ValueError, TypeError, RecursionError, OverflowError):
                pass
    return {"format": "morivyx.plugin-run-result/0.1", "runId": run_id,
            "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION}, "capabilityId": CAPABILITY_ID,
            "status": "failure", "failure": failure}


def import_repository_file(request, *, now=None):
    """Read bytes from a resolved POSIX local root, returning a snapshot or failure."""
    current = request
    try:
        validate_repository_import_request(request)
        current = copy.deepcopy(request)
        value = current["input"]
        try:
            root = os.path.realpath(value["repositoryRoot"], strict=True)
        except OSError as error:
            if error.errno == errno.ENOENT:
                raise RepositoryImportError("REPOSITORY_IMPORT_SOURCE_UNAVAILABLE", "/input/repositoryRoot",
                                            "repositoryの読取元を利用できません。") from None
            raise
        try:
            target = os.path.realpath(os.path.join(root, *value["locator"].split("/")), strict=True)
        except OSError as error:
            if error.errno == errno.ENOENT:
                raise RepositoryImportError("REPOSITORY_IMPORT_TARGET_MISSING", "/input/locator",
                                            "repository内の対象が存在しません。") from None
            raise
        relation = os.path.relpath(target, root)
        _require(relation not in (".", "..") and not relation.startswith("../") and not os.path.isabs(relation),
                 "REPOSITORY_IMPORT_OUTSIDE_ROOT", "/input/locator", "locatorがrepositoryの外部を参照しています。")
        try:
            # Hash exact bytes incrementally; no text decoding or normalization.
            with open(target, "rb") as stream:
                digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
        except OSError as error:
            if error.errno == errno.ENOENT:
                raise RepositoryImportError("REPOSITORY_IMPORT_TARGET_MISSING", "/input/locator",
                                            "repository内の対象が存在しません。") from None
            raise
        timestamp = now() if now is not None else datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result = {"format": "morivyx.plugin-run-result/0.1", "runId": current["runId"],
                  "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION}, "capabilityId": CAPABILITY_ID,
                  "status": "success", "output": {"kind": "repository-file-snapshot",
                  "externalIdentity": {"system": "repository", "externalId": value["externalId"]},
                  "locator": value["locator"], "digest": digest, "digestRule": "sha256-bytes", "retrievedAt": timestamp}}
        try:
            return validate_repository_import_result(result, current)
        except ValidationError as error:
            if type(error) is RepositoryImportError:
                raise
            # At this point only the supplied clock can invalidate a generated result.
            message = "Plugin RunResultは論理的な対応表でなければなりません。"
            raise RepositoryImportError(error.code, error.path, message) from None
    except Exception as error:
        return _failure(current, error)


def _comparison(previous=None, current=None, *, status, issues):
    prior = {key: previous["output"][key] for key in ("digest", "digestRule", "retrievedAt")} if previous is not None else None
    latest = None
    if current is not None:
        if current["status"] == "success":
            latest = {"status": "resolved", **{key: current["output"][key] for key in ("digest", "digestRule", "retrievedAt")}}
        else:
            code = current["failure"]["code"]
            latest = {"status": "missing" if code == "REPOSITORY_IMPORT_TARGET_MISSING" else "unavailable" if
                      code in ("REPOSITORY_IMPORT_SOURCE_UNAVAILABLE", "REPOSITORY_IMPORT_FAILED") else "invalid", "failureCode": code}
    return {"format": COMPARISON_FORMAT, "externalIdentity": dict(previous["output"]["externalIdentity"]) if previous is not None else None,
            "locator": previous["output"]["locator"] if previous is not None else None, "previous": prior,
            "current": latest, "status": status, "issues": [{"code": code} for code in issues]}


def compare_repository_import_snapshots(value):
    """Compare validated external snapshots and return a detached report."""
    if not _logical(value):
        return _comparison(status="invalid", issues=["REPOSITORY_REIMPORT_INPUT_INVALID"])
    previous, request, current = (value.get(key) for key in ("previousResult", "currentRequest", "currentResult"))
    try:
        validate_repository_import_result(previous)
        if previous["status"] != "success":
            return _comparison(status="invalid", issues=["REPOSITORY_REIMPORT_PREVIOUS_INVALID"])
        validate_repository_import_request(request)
        validate_repository_import_result(current, request)
    except (ValidationError, TypeError, ValueError, KeyError, RecursionError, OverflowError):
        return _comparison(status="invalid", issues=["REPOSITORY_REIMPORT_INPUT_INVALID"])
    if previous["output"]["externalIdentity"]["externalId"] != request["input"]["externalId"] or previous["output"]["locator"] != request["input"]["locator"]:
        return _comparison(previous, current, status="invalid", issues=["REPOSITORY_REIMPORT_IDENTITY_MISMATCH"])
    if current["status"] == "failure":
        code = current["failure"]["code"]
        if code == "REPOSITORY_IMPORT_TARGET_MISSING":
            status, issue = "missing", "REPOSITORY_REIMPORT_TARGET_MISSING"
        elif code in ("REPOSITORY_IMPORT_SOURCE_UNAVAILABLE", "REPOSITORY_IMPORT_FAILED"):
            status, issue = "unavailable", "REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE"
        else:
            status, issue = "invalid", "REPOSITORY_REIMPORT_CURRENT_INVALID"
        return _comparison(previous, current, status=status, issues=[issue])
    changed = current["output"]["digest"] != previous["output"]["digest"]
    return _comparison(previous, current, status="stale" if changed else "current",
                       issues=["REPOSITORY_REIMPORT_DIGEST_CHANGED"] if changed else [])


def assess_repository_reimport(value=None):
    """Combine the minimal comparison contract with local target revisions."""
    def report(comparison=None, baseline=None, current=None, local=None, status="blocked-invalid", issue=None):
        return {"format": ASSESSMENT_FORMAT, "externalStatus": comparison["status"] if type(comparison) is dict and
                type(comparison.get("status")) is str and comparison["status"] in EXTERNAL_STATUSES else None,
                "baselineTarget": baseline, "currentTarget": current, "localStatus": local, "status": status,
                "issues": [] if issue is None else [{"code": issue}]}
    if not _logical(value):
        return report(issue="REPOSITORY_REIMPORT_ASSESSMENT_INPUT_INVALID")
    comparison = value.get("comparison")
    if type(comparison) is not dict or comparison.get("format") != COMPARISON_FORMAT or \
            type(comparison.get("status")) is not str or comparison["status"] not in EXTERNAL_STATUSES:
        return report(comparison, issue="REPOSITORY_REIMPORT_ASSESSMENT_INPUT_INVALID")
    def target(value):
        return {key: value[key] for key in ("id", "revision")} if type(value) is dict and set(value) <= {"id", "revision"} and \
            all(_text(value.get(key)) for key in ("id", "revision")) else None
    baseline, current = target(value.get("baselineTarget")), target(value.get("currentTarget"))
    if baseline is None or current is None:
        return report(comparison, baseline, current, issue="REPOSITORY_REIMPORT_TARGET_STATE_INVALID")
    if baseline["id"] != current["id"]:
        return report(comparison, baseline, current, issue="REPOSITORY_REIMPORT_TARGET_ID_MISMATCH")
    changed = baseline["revision"] != current["revision"]
    local = "changed" if changed else "baseline"
    status, issue = {
        "invalid": ("blocked-invalid", "REPOSITORY_REIMPORT_EXTERNAL_INVALID"),
        "unavailable": ("blocked-unavailable", "REPOSITORY_REIMPORT_SOURCE_UNAVAILABLE"),
        "current": ("local-changed", "REPOSITORY_REIMPORT_LOCAL_CHANGED") if changed else ("unchanged", None),
        "stale": ("conflict", "REPOSITORY_REIMPORT_CONFLICT") if changed else ("external-changed", "REPOSITORY_REIMPORT_EXTERNAL_CHANGED"),
        "missing": ("missing-conflict", "REPOSITORY_REIMPORT_MISSING_CONFLICT") if changed else ("external-missing", "REPOSITORY_REIMPORT_EXTERNAL_MISSING"),
    }[comparison["status"]]
    return report(comparison, baseline, current, local, status, issue)


def main():
    from plugin_stdio import _close, _write
    if sys.argv[1:] == ["--stdio"]:
        from plugin_stdio import serve_plugin_stdio
        result = asyncio.run(serve_plugin_stdio({"handleRequest": import_repository_file,
                            "validateRequest": validate_repository_import_request, "validateResult": validate_repository_import_result}))
        return result["exitCode"]
    try:
        if len(sys.argv) != 1:
            raise ValueError("arguments")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        if type(value) is not dict or set(value) != {"operation", "input"}:
            raise ValueError("envelope")
        operation, data = value["operation"], value["input"]
        if operation == "validate-request":
            validate_repository_import_request(data)
            output = {"valid": True}
        elif operation == "validate-result" and type(data) is dict and set(data) <= {"result", "request"} and "result" in data:
            validate_repository_import_result(data["result"], data.get("request"))
            output = {"valid": True}
        elif operation == "import":
            output = {"result": import_repository_file(data)}
        elif operation == "compare":
            output = {"report": compare_repository_import_snapshots(data)}
        elif operation == "assess":
            output = {"report": assess_repository_reimport(data)}
        else:
            raise ValueError("operation")
        raw = (json.dumps(output, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(raw) > LIMIT:
            raise ValueError("output")
        try:
            _write(sys.stdout.buffer, raw)
        except Exception:
            _close(sys.stdout.buffer)
            raise ValueError("output") from None
    except (ValueError, TypeError, KeyError, OSError, RecursionError, OverflowError):
        try:
            _write(sys.stderr.buffer, b'{"error":{"code":"REPOSITORY_IMPORT_INPUT_INVALID","path":"/"}}\n')
        except Exception:
            _close(sys.stderr.buffer)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
