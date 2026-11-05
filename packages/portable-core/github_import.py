"""Independent GitHub file acquisition and reimport assessment.

Only explicitly supplied permissions and tokens are used. Captured responses
can be converted without transport; neither path adopts or persists a record.
"""

import asyncio
import base64
import copy
from datetime import datetime, timezone
import hashlib
import re
from types import SimpleNamespace
import urllib.error
import urllib.request

from canonical import canonical_json
from figma_import import AbortSignal, _spawn, _cancel, _resolved, _external_document
from figma_import import _network_bytes, _NoRedirect, _HttpHeaders, _HttpBody
from plugin_messages import validate_plugin_run_request, validate_plugin_run_result
from plugin_runtime import _json_text
from schema_validation import SPACE, ValidationError, safe_integer

PLUGIN_ID = "morivyx.github-importer.dev"
PLUGIN_VERSION = "0.1.0"
CAPABILITY_ID = "github.read-file"
API_ORIGIN = "https://api.github.com"
LIMITS = {"timeoutMs": 30000, "maxResponseBytes": 2097152, "maxTotalResponseBytes": 8388608,
          "maxFileBytes": 1048576, "maxRequests": 19}
LOSS = ["file-content-not-retained", "non-file-metadata-not-imported", "rename-history-not-tracked"]
MESSAGE = "GitHubの読取条件または取得結果を確認できませんでした。"
COMPARISON_FORMAT = "morivyx.github-import-comparison/0.1"
ASSESSMENT_FORMAT = "morivyx.github-reimport-assessment/0.1"
_UNSET = object()
_SHA = re.compile(r"[0-9a-f]{40}")
_OWNER = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")
_REPOSITORY = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z")
_INPUT_KEYS = ("owner", "repository", "repositoryId", "commit", "locator")
_COMPARISON_KEYS = ("previousResult", "currentRequest", "currentResult")
_TOKEN_SPACE = re.compile("[" + SPACE + r"\x00-\x1f\x7f]")
_UNAVAILABLE = {"GITHUB_IMPORT_" + code for code in ("SOURCE_UNAVAILABLE", "FAILED", "TIMEOUT", "RESPONSE_LIMIT", "REQUEST_LIMIT", "FILE_LIMIT")}
_INVALID = {"GITHUB_IMPORT_" + code for code in ("REQUEST_INVALID", "RESULT_INVALID", "RESULT_MISMATCH", "PERMISSION_DENIED",
    "LIMITS_INVALID", "OPTIONS_INVALID", "RESPONSE_INVALID", "REDIRECT_DENIED", "IDENTITY_MISMATCH", "TREE_INVALID",
    "KIND_UNSUPPORTED", "BLOB_INVALID", "DIGEST_MISMATCH")}


class GitHubImportError(ValidationError):
    def __init__(self, code):
        super().__init__(code, "")
        self.path = None


def _check(value, suffix="RESPONSE_INVALID"):
    if not value:
        raise GitHubImportError("GITHUB_IMPORT_" + suffix)


def _record(value):
    if type(value) is not dict:
        return False
    try:
        canonical_json(value)
        return True
    except (TypeError, ValueError, RecursionError, OverflowError):
        return False


def _keys(value, keys):
    return _record(value) and set(value) == set(keys)


def _matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def _equal(left, right):
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    return left == right


def _locator(value):
    if type(value) is not str or not 0 < len(value) <= 1024 or re.search(r"[\\\x00-\x1f\x7f]", value):
        return False
    parts = value.split("/")
    return len(parts) <= 16 and all(part not in ("", ".", "..") for part in parts)


def _valid_input(value):
    return _keys(value, _INPUT_KEYS) and _matches(value["owner"], _OWNER) and _matches(value["repository"], _REPOSITORY) and \
        safe_integer(value["repositoryId"]) and value["repositoryId"] > 0 and _matches(value["commit"], _SHA) and _locator(value["locator"])


def _timestamp(value):
    if not _matches(value, _TIME):
        return False
    try:
        canonical_json(value)
        return True
    except (ValueError, TypeError):
        return False


def validate_github_import_request(request):
    try:
        validate_plugin_run_request(request)
    except Exception:
        raise GitHubImportError("GITHUB_IMPORT_REQUEST_INVALID") from None
    _check(request["plugin"]["id"] == PLUGIN_ID and request["plugin"]["version"] == PLUGIN_VERSION and
           request["capability"]["id"] == CAPABILITY_ID and request["capability"]["effect"] == "read-only" and
           _valid_input(request["input"]), "REQUEST_INVALID")
    return request


def validate_github_import_result(result, request=None):
    try:
        validate_plugin_run_result(result, request)
    except Exception:
        raise GitHubImportError("GITHUB_IMPORT_RESULT_INVALID") from None
    _check(result["plugin"]["id"] == PLUGIN_ID and result["plugin"]["version"] == PLUGIN_VERSION and
           result["capabilityId"] == CAPABILITY_ID, "RESULT_INVALID")
    if request is not None:
        validate_github_import_request(request)
    if result["status"] == "failure":
        return result
    output = result["output"]
    _check(_keys(output, ("kind", "externalIdentity", "locator", "source", "digest", "digestRule", "byteLength", "retrievedAt", "informationLoss")), "RESULT_INVALID")
    identity, source = output["externalIdentity"], output["source"]
    _check(_keys(identity, ("system", "repositoryId", "externalId")) and
           _keys(source, ("apiOrigin", "owner", "repository", "commit", "blobSha", "mode")), "RESULT_INVALID")
    _check(output["kind"] == "github-file-snapshot" and identity["system"] == "github" and
           _valid_input({"owner": source["owner"], "repository": source["repository"], "repositoryId": identity["repositoryId"],
                         "commit": source["commit"], "locator": output["locator"]}) and
           identity["externalId"] == f"github:{int(identity['repositoryId'])}:{output['locator']}" and source["apiOrigin"] == API_ORIGIN and
           _matches(source["blobSha"], _SHA) and source["mode"] in ("100644", "100755") and _matches(output["digest"], _DIGEST) and
           output["digestRule"] == "sha256-bytes" and safe_integer(output["byteLength"]) and
           0 <= output["byteLength"] <= LIMITS["maxFileBytes"] and _timestamp(output["retrievedAt"]) and output["informationLoss"] == LOSS, "RESULT_INVALID")
    if request is not None:
        value = request["input"]
        _check(all(source[key] == value[key] for key in ("owner", "repository", "commit")) and
               _equal(identity["repositoryId"], value["repositoryId"]) and output["locator"] == value["locator"], "RESULT_MISMATCH")
    return result


def github_import_request(fields):
    if fields is None:
        raise TypeError("request fields")
    fields = fields if type(fields) is dict else {}
    return validate_github_import_request({"format": "morivyx.plugin-run-request/0.1", "runId": fields.get("runId"),
        "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION}, "capability": {"id": CAPABILITY_ID, "effect": "read-only"},
        "input": {key: fields.get(key) for key in _INPUT_KEYS}})


def _limits(overrides):
    _check(_record(overrides) and set(overrides) <= set(LIMITS), "LIMITS_INVALID")
    values = {**LIMITS, **overrides}
    _check(all(safe_integer(value) and 0 < value <= LIMITS[key] for key, value in values.items()), "LIMITS_INVALID")
    return {key: int(value) for key, value in values.items()}


def _response_list(rows):
    def require(value, code="INPUT_INVALID"):
        if not value:
            raise ValidationError("NETWORK_IMPORT_" + code, "/network-import")
    require(type(rows) is list and 0 < len(rows) <= 19)
    captured, total = [], 0
    for row in rows:
        require(type(row) is dict and set(row) == {"path", "bytes"})
        path = row["path"]
        require(type(path) is str and path.startswith("/") and not path.startswith("//") and re.search(r"[\\\x00-\x20\x7f]", path) is None)
        try:
            encoded = canonical_json(path)
            raw = _json_text(path)
        except (TypeError, ValueError, UnicodeError):
            require(False)
        require(len(encoded.encode("utf-8")) <= 4096 and len(raw.encode("utf-8")) <= 4096, "INPUT_LIMIT")
        data = _network_bytes(row["bytes"], 2097152)
        total += len(data)
        require(total <= 8388608, "INPUT_LIMIT")
        captured.append({"path": path, "bytes": data})
    return captured


def _document(data):
    try:
        value, _duplicates = _external_document(data.decode("utf-8-sig", errors="strict"))
    except Exception:
        raise GitHubImportError("GITHUB_IMPORT_RESPONSE_INVALID") from None
    _check(_record(value))
    return value


async def _snapshot_from_json(request, read_json, now, limits, active):
    value = request["input"]
    repository = await read_json("")
    _check(_equal(repository.get("id"), value["repositoryId"]) and type(repository.get("full_name")) is str and
           repository["full_name"].lower() == f"{value['owner']}/{value['repository']}".lower(), "IDENTITY_MISMATCH")
    commit = await read_json("/git/commits/" + value["commit"])
    _check(commit.get("sha") == value["commit"] and _record(commit.get("tree")) and _matches(commit["tree"].get("sha"), _SHA), "IDENTITY_MISMATCH")
    tree_sha = commit["tree"]["sha"]
    parts = value["locator"].split("/")
    for index, name in enumerate(parts):
        tree = await read_json("/git/trees/" + tree_sha)
        _check(tree.get("sha") == tree_sha and tree.get("truncated") is False and type(tree.get("tree")) is list, "TREE_INVALID")
        names = set()
        for item in tree["tree"]:
            _check(_record(item) and type(item.get("path")) is str and item["path"] and "/" not in item["path"] and item["path"] not in names, "TREE_INVALID")
            names.add(item["path"])
        entry = next((item for item in tree["tree"] if item["path"] == name), None)
        _check(entry is not None, "TARGET_MISSING")
        _check(_matches(entry.get("sha"), _SHA), "TREE_INVALID")
        if index < len(parts) - 1:
            _check(entry.get("type") == "tree" and entry.get("mode") == "040000", "KIND_UNSUPPORTED")
            tree_sha = entry["sha"]
        else:
            _check(entry.get("type") == "blob" and entry.get("mode") in ("100644", "100755"), "KIND_UNSUPPORTED")
    size = entry.get("size")
    _check(safe_integer(size) and 0 <= size <= limits["maxFileBytes"], "FILE_LIMIT")
    blob = await read_json("/git/blobs/" + entry["sha"])
    _check(blob.get("sha") == entry["sha"] and blob.get("encoding") == "base64" and _equal(blob.get("size"), size) and type(blob.get("content")) is str, "BLOB_INVALID")
    encoded = re.sub(r"\r?\n", "", blob["content"])
    _check(len(encoded) <= 4 * ((limits["maxFileBytes"] + 2) // 3) and re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", encoded) is not None, "BLOB_INVALID")
    content = base64.b64decode(encoded)
    _check(len(content) == size and base64.b64encode(content).decode("ascii") == encoded, "BLOB_INVALID")
    blob_sha = hashlib.sha1(f"blob {len(content)}\0".encode("ascii") + content).hexdigest()
    _check(blob_sha == entry["sha"], "DIGEST_MISMATCH")
    active()
    result = {"format": "morivyx.plugin-run-result/0.1", "runId": request["runId"], "plugin": dict(request["plugin"]),
        "capabilityId": CAPABILITY_ID, "status": "success", "output": {"kind": "github-file-snapshot",
        "externalIdentity": {"system": "github", "repositoryId": value["repositoryId"], "externalId": f"github:{int(value['repositoryId'])}:{value['locator']}"},
        "locator": value["locator"], "source": {"apiOrigin": API_ORIGIN, "owner": value["owner"], "repository": value["repository"],
        "commit": value["commit"], "blobSha": blob_sha, "mode": entry["mode"]}, "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
        "digestRule": "sha256-bytes", "byteLength": len(content), "retrievedAt": now(), "informationLoss": list(LOSS)}}
    return validate_github_import_result(result, request)


async def convert_github_import_responses(request, responses, retrieved_at, overrides=_UNSET):
    """Recompute a snapshot from captured raw responses; no transport is used."""
    validate_github_import_request(request)
    request, limits = copy.deepcopy(request), _limits({} if overrides is _UNSET else overrides)
    captured = _response_list(responses)
    _check(_timestamp(retrieved_at), "RESULT_INVALID")
    _check(len(captured) <= limits["maxRequests"], "REQUEST_LIMIT")
    prefix = f"/repos/{request['input']['owner']}/{request['input']['repository']}"
    cursor, total = 0, 0

    async def read_json(suffix):
        nonlocal cursor, total
        row = captured[cursor] if cursor < len(captured) else None
        cursor += 1
        _check(row is not None and row["path"] == prefix + suffix, "IDENTITY_MISMATCH")
        total += len(row["bytes"])
        _check(len(row["bytes"]) <= limits["maxResponseBytes"] and total <= limits["maxTotalResponseBytes"], "RESPONSE_LIMIT")
        return _document(row["bytes"])
    result = await _snapshot_from_json(request, read_json, lambda: retrieved_at, limits, lambda: None)
    _check(cursor == len(captured))
    return result


def _safe_run_id(value):
    if type(value) is not dict:
        return "invalid-run"
    run_id = dict.get(value, "runId")
    if type(run_id) is str and run_id:
        try:
            canonical_json(run_id)
            return run_id
        except (TypeError, ValueError, RecursionError, OverflowError):
            pass
    return "invalid-run"


def _error_code(error):
    ancestry = type.__dict__["__mro__"].__get__(type(error), type(type(error)))
    if any(base is GitHubImportError for base in ancestry):
        code = dict.get(BaseException.__dict__["__dict__"].__get__(error, type(error)), "code")
        try:
            if type(code) is str and code:
                canonical_json(code)
                return code
        except (ValueError, TypeError, RecursionError, OverflowError):
            pass
    return "GITHUB_IMPORT_FAILED"


def _declared_length(value, maximum):
    _check(type(value) is str and re.fullmatch(r"[0-9]+", value) is not None, "RESPONSE_LIMIT")
    digits = value.lstrip("0") or "0"
    _check(len(digits) <= 16, "RESPONSE_LIMIT")
    number = int(digits)
    _check(number <= maximum, "RESPONSE_LIMIT")
    return number


async def _standard_fetch(url, options):
    def open_response():
        _check(not options["signal"].aborted, "TIMEOUT")
        request = urllib.request.Request(url, headers=options["headers"], method=options["method"])
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            response = opener.open(request, timeout=options["timeoutMs"] / 1000)
        except urllib.error.HTTPError as error:
            response = error
        headers = _HttpHeaders(response.headers)
        return SimpleNamespace(status=response.status, redirected=False, url=response.geturl(), headers=headers, body=_HttpBody(response, headers))
    return await asyncio.to_thread(open_response)


async def _snapshot(request, fetch, token, now, limits, signal):
    value = request["input"]
    prefix = f"{API_ORIGIN}/repos/{value['owner']}/{value['repository']}"
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "morivyx-github-importer/0.1.0"}
    if token is not _UNSET:
        headers["Authorization"] = "Bearer " + token
    count, total = 0, 0

    def active():
        _check(not signal.aborted, "TIMEOUT")

    async def read_json(suffix):
        nonlocal count, total
        active()
        count += 1
        _check(count <= limits["maxRequests"], "REQUEST_LIMIT")
        url = prefix + suffix
        options = {"method": "GET", "redirect": "manual", "cache": "no-store", "headers": dict(headers), "signal": signal}
        response = await _resolved(fetch(url, {**options, "timeoutMs": limits["timeoutMs"]} if fetch is _standard_fetch else options))
        try:
            active()
            status = getattr(response, "status", None)
            _check(response is not None and not getattr(response, "redirected", False) and
                   (not getattr(response, "url", "") or response.url == url) and
                   not (type(status) in (int, float) and 300 <= status < 400), "REDIRECT_DENIED")
            _check(status == 200, "SOURCE_UNAVAILABLE")
            content_type = response.headers.get("content-type")
            _check(type(content_type) is str and re.match(r"application/(?:[\w.-]+\+)?json(?:;|$)", content_type, re.I | re.ASCII) is not None)
            declared = response.headers.get("content-length")
            if declared is not None:
                _declared_length(declared, limits["maxResponseBytes"])
            _check(response.body is not None)
            reader = response.body.get_reader()
        except Exception:
            try:
                _cancel(response.body)
            except Exception:
                pass
            raise
        chunks, size, complete = [], 0, False
        cancel = lambda: _cancel(reader)
        signal.add_event_listener("abort", cancel, once=True)
        try:
            while True:
                part = await _resolved(reader.read())
                active()
                if part["done"]:
                    break
                chunk = part["value"]
                _check(type(chunk) in (bytes, bytearray) or type(chunk) is memoryview and chunk.ndim == 1 and chunk.format == "B")
                size += len(chunk)
                total += len(chunk)
                _check(size <= limits["maxResponseBytes"] and total <= limits["maxTotalResponseBytes"], "RESPONSE_LIMIT")
                chunks.append(bytes(chunk))
            complete = True
        finally:
            signal.remove_event_listener("abort", cancel)
            if not complete:
                cancel()
            reader.release_lock()
        return _document(b"".join(chunks))
    return await _snapshot_from_json(request, read_json, now, limits, active)


async def import_github_file(input_value, options=_UNSET):
    """Acquire one explicitly permitted fixed file; no implicit token or retry.

    Injected adapters receive the source request fields and a cooperative
    signal, returning a response or awaitable. Streams use the same Python
    read/cancel/release_lock binding as the independent Figma transport.
    """
    request, signal, timer = input_value, None, None
    try:
        validate_github_import_request(request)
        request = copy.deepcopy(request)
        options = {} if options is _UNSET else options
        if type(options) is not dict:
            raise TypeError("options")
        permission, value = options.get("permission"), request["input"]
        _check(_keys(permission, ("apiOrigin", "owner", "repository", "repositoryId")) and permission["apiOrigin"] == API_ORIGIN and
               all(permission[key] == value[key] for key in ("owner", "repository")) and _equal(permission["repositoryId"], value["repositoryId"]), "PERMISSION_DENIED")
        limits = _limits(options.get("limits", {}))
        fetch = options.get("fetchImpl")
        if fetch is None:
            fetch = _standard_fetch
        now = options.get("now")
        if now is None:
            now = lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        token = options.get("token", _UNSET)
        _check(callable(fetch) and callable(now) and (token is _UNSET or type(token) is str and
               0 < len(token.encode("utf-16-le", errors="surrogatepass")) // 2 <= 8192 and _TOKEN_SPACE.search(token) is None), "OPTIONS_INVALID")
        signal = AbortSignal()

        async def deadline():
            await asyncio.sleep(limits["timeoutMs"] / 1000)
            signal.abort()
            raise GitHubImportError("GITHUB_IMPORT_TIMEOUT")
        timer = _spawn(deadline())
        task = _spawn(_snapshot(request, fetch, token, now, limits, signal))
        done, _pending = await asyncio.wait((task, timer), return_when=asyncio.FIRST_COMPLETED)
        return await (task if task in done else timer)
    except Exception as error:
        return {"format": "morivyx.plugin-run-result/0.1", "runId": _safe_run_id(request), "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION},
                "capabilityId": CAPABILITY_ID, "status": "failure", "failure": {"code": _error_code(error), "message": MESSAGE}}
    finally:
        if timer is not None:
            timer.cancel()
        if signal is not None:
            signal.abort()


def _descriptor(output):
    return {"source": dict(output["source"]), **{key: output[key] for key in ("digest", "digestRule", "byteLength", "retrievedAt")}}


def _comparison(status, issue=None, previous=None, current=None):
    return {"format": COMPARISON_FORMAT, "externalIdentity": dict(previous["externalIdentity"]) if previous is not None else None,
        "locator": previous["locator"] if previous is not None else None, "previous": _descriptor(previous) if previous is not None else None,
        "current": current, "status": status, "issues": [] if issue is None else [{"code": issue}]}


def compare_github_import_snapshots(input_value):
    if not _keys(input_value, _COMPARISON_KEYS):
        return _comparison("invalid", "GITHUB_REIMPORT_INPUT_INVALID")
    previous_result, request, result = (input_value[key] for key in _COMPARISON_KEYS)
    try:
        validate_github_import_result(previous_result)
        if previous_result["status"] != "success":
            return _comparison("invalid", "GITHUB_REIMPORT_PREVIOUS_INVALID")
    except Exception:
        return _comparison("invalid", "GITHUB_REIMPORT_PREVIOUS_INVALID")
    previous = previous_result["output"]
    try:
        validate_github_import_request(request)
        validate_github_import_result(result, request)
    except Exception:
        return _comparison("invalid", "GITHUB_REIMPORT_CURRENT_INVALID", previous)
    value = request["input"]
    if not _equal(previous["externalIdentity"]["repositoryId"], value["repositoryId"]) or previous["locator"] != value["locator"]:
        return _comparison("invalid", "GITHUB_REIMPORT_IDENTITY_MISMATCH", previous)
    if result["status"] == "failure":
        code = result["failure"]["code"]
        status = "missing" if code == "GITHUB_IMPORT_TARGET_MISSING" else "unavailable" if code in _UNAVAILABLE else "invalid"
        current = {"status": status, "source": {"apiOrigin": API_ORIGIN, **{key: value[key] for key in ("owner", "repository", "commit")}},
                   "failureCode": code if status != "invalid" or code in _INVALID else "GITHUB_REIMPORT_UNRECOGNIZED_FAILURE"}
        if status == "missing" and previous["source"]["commit"] == value["commit"]:
            return _comparison("invalid", "GITHUB_REIMPORT_SNAPSHOT_CONTRADICTION", previous, current)
        issue = "TARGET_MISSING" if status == "missing" else "SOURCE_UNAVAILABLE" if status == "unavailable" else "CURRENT_INVALID"
        return _comparison(status, "GITHUB_REIMPORT_" + issue, previous, current)
    output = result["output"]
    current = {"status": "resolved", **_descriptor(output)}
    digest_equal, blob_equal = previous["digest"] == output["digest"], previous["source"]["blobSha"] == output["source"]["blobSha"]
    mode_equal = previous["source"]["mode"] == output["source"]["mode"]
    if digest_equal != blob_equal or digest_equal and previous["byteLength"] != output["byteLength"] or \
            previous["source"]["commit"] == output["source"]["commit"] and (not digest_equal or not mode_equal):
        return _comparison("invalid", "GITHUB_REIMPORT_SNAPSHOT_CONTRADICTION", previous, current)
    if not digest_equal or not mode_equal:
        return _comparison("stale", "GITHUB_REIMPORT_FILE_CHANGED", previous, current)
    return _comparison("current", None, previous, current)


def _target(value, deletion=False):
    if not _keys(value, ("id", "revision")) or type(value["id"]) is not str or not value["id"] or not \
            (type(value["revision"]) is str and value["revision"] or deletion and value["revision"] is None):
        return None
    return {"id": value["id"], "revision": value["revision"]}


def _assessment(compared, baseline, current, local, status, issue):
    return {"format": ASSESSMENT_FORMAT, "comparison": compared, "baselineTarget": baseline, "currentTarget": current,
        "localStatus": local, "status": status, "issues": [] if issue is None else [{"code": issue}]}


def assess_github_reimport(input_value):
    if not _keys(input_value, (*_COMPARISON_KEYS, "baselineTarget", "currentTarget")):
        return _assessment(_comparison("invalid", "GITHUB_REIMPORT_INPUT_INVALID"), None, None, None, "blocked-invalid", "GITHUB_REIMPORT_ASSESSMENT_INPUT_INVALID")
    compared = compare_github_import_snapshots({key: input_value[key] for key in _COMPARISON_KEYS})
    baseline, current = _target(input_value["baselineTarget"]), _target(input_value["currentTarget"], True)
    if baseline is None or current is None:
        return _assessment(compared, baseline, current, None, "blocked-invalid", "GITHUB_REIMPORT_TARGET_STATE_INVALID")
    if baseline["id"] != current["id"]:
        return _assessment(compared, baseline, current, None, "blocked-invalid", "GITHUB_REIMPORT_TARGET_ID_MISMATCH")
    local = "deleted" if current["revision"] is None else "baseline" if baseline["revision"] == current["revision"] else "changed"
    if compared["status"] in ("invalid", "unavailable"):
        invalid = compared["status"] == "invalid"
        return _assessment(compared, baseline, current, local, "blocked-invalid" if invalid else "blocked-unavailable",
                           "GITHUB_REIMPORT_EXTERNAL_INVALID" if invalid else "GITHUB_REIMPORT_SOURCE_UNAVAILABLE")
    statuses = {"current": {"baseline": ("unchanged", None), "changed": ("local-changed", "LOCAL_CHANGED"), "deleted": ("local-deleted", "LOCAL_DELETED")},
                "stale": {"baseline": ("external-changed", "EXTERNAL_CHANGED"), "changed": ("conflict", "CONFLICT"), "deleted": ("delete-conflict", "DELETE_CONFLICT")},
                "missing": {"baseline": ("external-missing", "EXTERNAL_MISSING"), "changed": ("missing-conflict", "MISSING_CONFLICT"), "deleted": ("both-missing", "BOTH_MISSING")}}
    status, issue = statuses[compared["status"]][local]
    return _assessment(compared, baseline, current, local, status, "GITHUB_REIMPORT_" + issue if issue is not None else None)
