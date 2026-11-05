"""Independent Figma snapshot conversion, acquisition and reimport comparison.

External JSON spelling is distinct from Core canonical form: names and text
are neither NFC-normalized nor converted to timestamps. No record is adopted.
"""

import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import re
import inspect
from types import SimpleNamespace
import urllib.error
import urllib.request
from urllib.parse import quote as url_quote

from canonical import canonical_json
from plugin_messages import validate_plugin_run_request, validate_plugin_run_result
from plugin_runtime import _json_text
from record_validation import _revision_number_text
from schema_validation import SPACE, ValidationError

PLUGIN_ID = "morivyx.figma-importer.dev"
PLUGIN_VERSION = "0.1.0"
CAPABILITY_ID = "figma.read-node"
API_ORIGIN = "https://api.figma.com"
COMPARISON_FORMAT = "morivyx.figma-import-comparison/0.1"
LIMITS = {"timeoutMs": 30000, "maxResponseBytes": 2097152, "maxDepth": 64}
MESSAGE = "Figmaの読取条件または取得結果を確認できません。"
LOSS = ["node-json-not-retained", "node-names-and-text-not-retained", "geometry-and-paint-not-retained", "images-not-downloaded",
        "component-and-style-tables-not-retained", "plugin-data-not-requested", "file-metadata-not-retained",
        "node-rename-history-not-tracked", "json-number-lexemes-not-retained"]
_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}")
_NODE_ID = re.compile(r"[A-Za-z0-9:;_-]{1,256}")
_NODE_TYPE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_UNSET = object()
_PENDING = set()
_CREDENTIAL_SPACE = re.compile("[" + SPACE + r"\x00-\x1f\x7f]")


class FigmaImportError(ValidationError):
    def __init__(self, suffix):
        super().__init__("FIGMA_IMPORT_" + suffix, "")
        self.path = None


def _check(value, suffix="RESPONSE_INVALID"):
    if not value:
        raise FigmaImportError(suffix)


def _keys(value, keys):
    return type(value) is dict and set(value) == set(keys)


def _matches(value, pattern):
    return type(value) is str and pattern.fullmatch(value) is not None


def _logical(value, suffix):
    try:
        canonical_json(value)
    except (TypeError, ValueError, RecursionError, OverflowError):
        raise FigmaImportError(suffix) from None


def _plugin():
    return {"id": PLUGIN_ID, "version": PLUGIN_VERSION}


def _error_code(error, fallback):
    if type(error) is not FigmaImportError:
        return fallback
    code = vars(error).get("code")
    try:
        if type(code) is str and code:
            canonical_json(code)
            return code
    except (ValueError, TypeError, RecursionError, OverflowError):
        pass
    return fallback


async def _resolved(value):
    return await value if inspect.isawaitable(value) else value


def validate_figma_import_request(request):
    """Return the original request after structural and fixed-source checks."""
    try:
        validate_plugin_run_request(request)
        _check(len(canonical_json(request).encode("utf-8")) <= 1048576 and request["plugin"] == _plugin() and
               request["capability"] == {"id": CAPABILITY_ID, "effect": "read-only"} and
               len(request["runId"].encode("utf-16-le")) // 2 <= 256 and canonical_json(request["runId"]) == _json_text(request["runId"]) and
               _keys(request["input"], ("fileKey", "nodeId", "version")) and
               _matches(request["input"]["fileKey"], _KEY) and _matches(request["input"]["nodeId"], _NODE_ID) and
               _matches(request["input"]["version"], _KEY), "REQUEST_INVALID")
    except Exception:
        raise FigmaImportError("REQUEST_INVALID") from None
    return request


def validate_figma_import_result(result, request=None):
    """Validate metadata and request binding; do not authenticate the source."""
    try:
        validate_plugin_run_result(result, request)
        if request is not None:
            validate_figma_import_request(request)
        _check(result["plugin"] == _plugin() and result["capabilityId"] == CAPABILITY_ID, "RESULT_INVALID")
        if result["status"] == "failure":
            return result
        value = result["output"]
        _check(_keys(value, ("kind", "externalIdentity", "locator", "source", "node", "digest", "digestRule", "retrievedAt", "informationLoss")), "RESULT_INVALID")
        identity, source, node = value["externalIdentity"], value["source"], value["node"]
        _check(value["kind"] == "figma-node-snapshot" and _keys(identity, ("system", "fileKey", "externalId")) and
               identity["system"] == "figma" and _matches(identity["fileKey"], _KEY) and _matches(value["locator"], _NODE_ID) and
               identity["externalId"] == f"figma:{identity['fileKey']}:{value['locator']}" and
               _keys(source, ("apiOrigin", "fileKey", "version")) and source["apiOrigin"] == API_ORIGIN and
               source["fileKey"] == identity["fileKey"] and _matches(source["version"], _KEY) and
               _keys(node, ("id", "type")) and node["id"] == value["locator"] and _matches(node["type"], _NODE_TYPE) and
               _matches(value["digest"], _DIGEST) and value["digestRule"] == "sha256-sorted-json-node/0.1" and
               _matches(value["retrievedAt"], _TIME) and canonical_json(value["informationLoss"]) == canonical_json(LOSS), "RESULT_INVALID")
        if request is not None:
            _check(source["fileKey"] == request["input"]["fileKey"] and value["locator"] == request["input"]["nodeId"] and
                   source["version"] == request["input"]["version"], "RESULT_MISMATCH")
    except Exception as error:
        if type(error) is FigmaImportError and vars(error).get("code") == "FIGMA_IMPORT_RESULT_MISMATCH":
            raise
        raise FigmaImportError("RESULT_INVALID") from None
    return result


def _network_bytes(value, maximum):
    valid = type(value) in (bytes, bytearray) or (type(value) is memoryview and value.ndim == 1 and value.format == "B" and
             value.c_contiguous and type(value.obj) in (bytes, bytearray))
    if not valid:
        raise ValidationError("NETWORK_IMPORT_INPUT_INVALID", "/network-import")
    if len(value) > maximum:
        raise ValidationError("NETWORK_IMPORT_INPUT_LIMIT", "/network-import")
    return bytes(value)


def _limits(overrides):
    _logical(overrides, "LIMITS_INVALID")
    _check(type(overrides) is dict and all(key in LIMITS for key in overrides), "LIMITS_INVALID")
    limits = {**LIMITS, **overrides}
    _check(all(type(value) in (int, float) and math.isfinite(value) and value == int(value) and 0 < value <= LIMITS[key]
               for key, value in limits.items()), "LIMITS_INVALID")
    return {key: int(value) for key, value in limits.items()}


def _external_document(source):
    """Parse JSON iteratively with binary64 numbers and delayed duplicate errors.

    The source first checks the last-key-wins JSON value's depth, then rejects
    duplicate keys. Retain that precedence without recursing into deep input.
    """
    def constant(_):
        raise ValueError("invalid JSON number")

    decoder = json.JSONDecoder(parse_int=float, parse_float=float, parse_constant=constant)
    frames, result, position, duplicate = [], _UNSET, 0, False
    while True:
        while position < len(source) and source[position] in " \t\r\n":
            position += 1
        if frames:
            container, state, key = frames[-1]
            closer = "}" if type(container) is dict else "]"
            if state == "comma":
                if source[position:position + 1] == closer:
                    frames.pop()
                    position += 1
                elif source[position:position + 1] == ",":
                    frames[-1][1] = "key" if type(container) is dict else "value"
                    position += 1
                else:
                    raise ValueError("invalid separator")
                continue
            if state in ("first-key", "key"):
                if state == "first-key" and source[position:position + 1] == "}":
                    frames.pop()
                    position += 1
                    continue
                if source[position:position + 1] != '"':
                    raise ValueError("expected JSON key")
                key, position = decoder.raw_decode(source, position)
                frames[-1][2], frames[-1][1] = key, "colon"
                continue
            if state == "colon":
                if source[position:position + 1] != ":":
                    raise ValueError("expected colon")
                frames[-1][1] = "value"
                position += 1
                continue
            if state == "first-value" and source[position:position + 1] == "]":
                frames.pop()
                position += 1
                continue
        elif result is not _UNSET:
            if position != len(source):
                raise ValueError("trailing JSON")
            return result, duplicate
        opening = source[position:position + 1]
        if opening in ("{", "["):
            value = {} if opening == "{" else []
            position += 1
        else:
            value, position = decoder.raw_decode(source, position)
        if frames:
            container, _, key = frames[-1]
            if type(container) is dict:
                duplicate = duplicate or key in container
                container[key] = value
            else:
                container.append(value)
            frames[-1][1] = "comma"
        else:
            result = value
        if opening in ("{", "["):
            frames.append([value, "first-key" if opening == "{" else "first-value", None])


def _external_json(value):
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is str:
        _check(not any(0xD800 <= ord(character) <= 0xDFFF for character in value))
        return json.dumps(value, ensure_ascii=False)
    if type(value) in (int, float):
        _check(math.isfinite(value) and (value != int(value) or abs(value) <= 9007199254740991))
        return _revision_number_text(value)
    if type(value) is list:
        return "[" + ",".join(_external_json(item) for item in value) + "]"
    _check(type(value) is dict)
    return "{" + ",".join(_external_json(key) + ":" + _external_json(value[key]) for key in sorted(value)) + "}"


def _selected(raw, input_value, limits):
    try:
        document, duplicate = _external_document(raw)
    except (ValueError, TypeError, OverflowError):
        raise FigmaImportError("RESPONSE_INVALID") from None
    pending = [(document, 1)]
    while pending:
        value, depth = pending.pop()
        if type(value) not in (dict, list):
            continue
        _check(depth <= limits["maxDepth"], "RESPONSE_DEPTH")
        pending.extend((child, depth + 1) for child in (value.values() if type(value) is dict else value))
    _check(not duplicate and type(document) is dict)
    _check("err" not in document or document["err"] is None or type(document["err"]) is str and document["err"] == "")
    _check(document.get("version") == input_value["version"], "IDENTITY_MISMATCH")
    nodes = document.get("nodes")
    _check(type(nodes) is dict and input_value["nodeId"] in nodes)
    selected = nodes[input_value["nodeId"]]
    _check(selected is not None, "TARGET_MISSING")
    _check(type(selected) is dict and type(selected.get("document")) is dict)
    node = selected["document"]
    _check(node.get("id") == input_value["nodeId"], "IDENTITY_MISMATCH")
    _check(_matches(node.get("type"), _NODE_TYPE))
    encoded = _external_json(node).encode("utf-8")
    _check(len(encoded) <= limits["maxResponseBytes"], "RESPONSE_LIMIT")
    return {"node": {"id": node["id"], "type": node["type"]}, "digest": "sha256:" + hashlib.sha256(encoded).hexdigest()}


def _result(request, selected, retrieved_at):
    value = request["input"]
    result = {"format": "morivyx.plugin-run-result/0.1", "runId": request["runId"], "plugin": _plugin(), "capabilityId": CAPABILITY_ID,
              "status": "success", "output": {"kind": "figma-node-snapshot", "externalIdentity": {"system": "figma", "fileKey": value["fileKey"],
              "externalId": f"figma:{value['fileKey']}:{value['nodeId']}"}, "locator": value["nodeId"],
              "source": {"apiOrigin": API_ORIGIN, "fileKey": value["fileKey"], "version": value["version"]}, **selected,
              "digestRule": "sha256-sorted-json-node/0.1", "retrievedAt": retrieved_at, "informationLoss": list(LOSS)}}
    validate_figma_import_result(result, request)
    return result


def convert_figma_import_response(request, data, retrieved_at, overrides=_UNSET):
    """Convert supplied bytes only; no credentials, transport or persistence."""
    validate_figma_import_request(request)
    limits = _limits({} if overrides is _UNSET else overrides)
    raw = _network_bytes(data, limits["maxResponseBytes"])
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeError:
        raise FigmaImportError("RESPONSE_INVALID") from None
    return _result(request, _selected(text, request["input"], limits), retrieved_at)


def _descriptor(snapshot):
    return {"version": snapshot["source"]["version"], **{key: snapshot[key] for key in ("digest", "digestRule", "retrievedAt")}}


def _report(status, codes, previous=None, current=None):
    return {"format": COMPARISON_FORMAT, "externalIdentity": dict(previous["externalIdentity"]) if previous is not None else None,
            "locator": previous["locator"] if previous is not None else None, "previous": _descriptor(previous) if previous is not None else None,
            "current": current, "status": status, "issues": [{"code": "FIGMA_REIMPORT_" + code} for code in codes]}


def _compare_times(left, right):
    first, second = json.loads(canonical_json(left)), json.loads(canonical_json(right))
    if first[:19] != second[:19]:
        return -1 if first[:19] < second[:19] else 1
    a, b = first[19:-1].removeprefix("."), second[19:-1].removeprefix(".")
    width = max(len(a), len(b))
    a, b = a.ljust(width, "0"), b.ljust(width, "0")
    return 0 if a == b else -1 if a < b else 1


def compare_figma_import_snapshots(input_value):
    """Compare metadata without fetching missing targets or authenticating it."""
    try:
        if len(canonical_json(input_value).encode("utf-8")) > 2097152 or not _keys(input_value, ("previousResult", "currentRequest", "currentResult")):
            return _report("invalid", ["INPUT_INVALID"])
    except Exception:
        return _report("invalid", ["INPUT_INVALID"])
    previous_result, request, result = (input_value[key] for key in ("previousResult", "currentRequest", "currentResult"))
    try:
        validate_figma_import_result(previous_result)
        if previous_result["status"] != "success":
            return _report("invalid", ["PREVIOUS_INVALID"])
    except Exception:
        return _report("invalid", ["PREVIOUS_INVALID"])
    previous = previous_result["output"]
    try:
        validate_figma_import_request(request)
        validate_figma_import_result(result, request)
    except Exception:
        return _report("invalid", ["CURRENT_INVALID"], previous)
    if previous["externalIdentity"]["fileKey"] != request["input"]["fileKey"] or previous["locator"] != request["input"]["nodeId"]:
        return _report("invalid", ["IDENTITY_MISMATCH"], previous)
    same_version = previous["source"]["version"] == request["input"]["version"]
    if result["status"] == "failure":
        code = result["failure"]["code"]
        if code not in ("FIGMA_IMPORT_TARGET_MISSING", "FIGMA_IMPORT_SOURCE_UNAVAILABLE", "FIGMA_IMPORT_TIMEOUT"):
            return _report("invalid", ["FAILURE_UNSUPPORTED"], previous)
        status = "missing" if code == "FIGMA_IMPORT_TARGET_MISSING" else "unavailable"
        current = {"status": status, "failureCode": code, "requestedVersion": request["input"]["version"]}
        if status == "missing" and same_version:
            return _report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current)
        return _report(status, [], previous, current)
    snapshot = result["output"]
    current = {"status": "resolved", **_descriptor(snapshot)}
    if _compare_times(snapshot["retrievedAt"], previous["retrievedAt"]) < 0:
        return _report("invalid", ["TIME_REGRESSION"], previous, current)
    if same_version and snapshot["digest"] != previous["digest"] or snapshot["digest"] == previous["digest"] and canonical_json(snapshot["node"]) != canonical_json(previous["node"]):
        return _report("invalid", ["SNAPSHOT_CONTRADICTION"], previous, current)
    return _report("current" if snapshot["digest"] == previous["digest"] else "stale", [], previous, current)


def _spawn(awaitable):
    task = asyncio.create_task(awaitable)
    _PENDING.add(task)

    def finished(done):
        _PENDING.discard(done)
        try:
            done.exception()
        except asyncio.CancelledError:
            pass
    task.add_done_callback(finished)
    return task


class AbortSignal:
    """Cooperative transport signal; does not terminate host threads or an OS."""

    def __init__(self):
        self.aborted = False
        self._listeners = []

    def add_event_listener(self, event, callback, *, once=False):
        if event != "abort":
            raise ValueError("unsupported signal event")
        self._listeners.append((callback, once))

    def remove_event_listener(self, event, callback):
        if event == "abort":
            self._listeners = [(entry, once) for entry, once in self._listeners if entry is not callback]

    def abort(self):
        if self.aborted:
            return
        self.aborted = True
        listeners = list(self._listeners)
        self._listeners = [(callback, once) for callback, once in self._listeners if not once]
        for callback, _once in listeners:
            callback()


def _cancel(body):
    async def cancel():
        try:
            result = body.cancel()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass
    _spawn(cancel())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, stream, code, message, headers, new_url):
        return None


class _HttpReader:
    def __init__(self, stream):
        self.stream = stream

    async def read(self):
        chunk = await asyncio.to_thread(self.stream.read, 65536)
        return {"done": not chunk, "value": chunk}

    async def cancel(self):
        await asyncio.to_thread(self.stream.close)

    def release_lock(self):
        self.stream.close()


class _HttpBody:
    def __init__(self, stream):
        self.reader = _HttpReader(stream)

    def get_reader(self):
        return self.reader

    async def cancel(self):
        await self.reader.cancel()


async def _standard_fetch(url, options):
    """Standard-library HTTPS transport, with redirects disabled.

    The same timeout bounds socket operations. DNS and hostile adapters remain
    host responsibilities; the logical acquisition deadline is enforced above.
    """
    signal = options["signal"]

    def open_response():
        _check(not signal.aborted, "TIMEOUT")
        request = urllib.request.Request(url, headers=options["headers"], method=options["method"])
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            response = opener.open(request, timeout=options["timeoutMs"] / 1000)
        except urllib.error.HTTPError as error:
            response = error
        return SimpleNamespace(status=response.status, redirected=False, url=response.geturl(), headers=response.headers,
                               body=_HttpBody(response))
    return await asyncio.to_thread(open_response)


async def _snapshot(request, *, fetch, credential, now, limits, signal):
    value = request["input"]
    encode = lambda text: url_quote(text, safe="~!*'()-._")
    url = f"{API_ORIGIN}/v1/files/{encode(value['fileKey'])}/nodes?ids={encode(value['nodeId'])}&version={encode(value['version'])}"
    headers = {"Accept": "application/json"}
    if credential["kind"] == "oauth":
        headers["Authorization"] = "Bearer " + credential["token"]
    else:
        headers["X-Figma-Token"] = credential["token"]

    def active():
        _check(not signal.aborted, "TIMEOUT")

    transport_options = {"method": "GET", "redirect": "manual", "cache": "no-store", "headers": headers, "signal": signal}
    # Extra transport timing is private to the built-in binding. Injected
    # adapters receive exactly the source request fields.
    response = await _resolved(fetch(url, {**transport_options, "timeoutMs": limits["timeoutMs"]} if fetch is _standard_fetch else transport_options))
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
            _check(type(declared) is str and re.fullmatch(r"[0-9]+", declared) is not None and
                   len(declared.lstrip("0")) <= 16 and int(declared) <= limits["maxResponseBytes"], "RESPONSE_LIMIT")
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
            _check(size <= limits["maxResponseBytes"], "RESPONSE_LIMIT")
            chunks.append(bytes(chunk))
        complete = True
    finally:
        signal.remove_event_listener("abort", cancel)
        if not complete:
            cancel()
        reader.release_lock()
    try:
        raw = b"".join(chunks).decode("utf-8-sig", errors="strict")
    except UnicodeError:
        raise FigmaImportError("RESPONSE_INVALID") from None
    selected = _selected(raw, value, limits)
    active()
    return _result(request, selected, now())


async def import_figma_node(input_value, options=_UNSET):
    """Acquire an explicitly permitted version; failures retain only fixed data.

    Options use permission, credential, limits, fetchImpl and now. An injected
    fetchImpl receives (url, options), returning a response or an awaitable with status,
    redirected, url, headers.get and body.get_reader/cancel. Readers expose
    async read/cancel and synchronous release_lock. No retry is performed.
    """
    run_id, timer, signal = "invalid-run", None, None
    try:
        validate_figma_import_request(input_value)
        request = copy.deepcopy(input_value)
        run_id = request["runId"]
        options = {} if options is _UNSET else options
        if type(options) is not dict:
            raise TypeError("options")
        permission, credential = options.get("permission"), options.get("credential")
        _logical(permission, "PERMISSION_DENIED")
        _check(_keys(permission, ("apiOrigin", "fileKey")) and permission["apiOrigin"] == API_ORIGIN and
               permission["fileKey"] == request["input"]["fileKey"], "PERMISSION_DENIED")
        _logical(credential, "CREDENTIAL_INVALID")
        _check(_keys(credential, ("kind", "token")) and credential["kind"] in ("oauth", "personal-access-token") and
               type(credential["token"]) is str and 0 < len(credential["token"].encode("utf-16-le")) // 2 <= 8192 and
               _CREDENTIAL_SPACE.search(credential["token"]) is None, "CREDENTIAL_INVALID")
        limits = _limits(options.get("limits", {}))
        fetch = options.get("fetchImpl", _standard_fetch)
        now = options.get("now", lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        _check(callable(fetch) and callable(now), "OPTIONS_INVALID")
        signal = AbortSignal()

        async def deadline():
            await asyncio.sleep(limits["timeoutMs"] / 1000)
            signal.abort()
            raise FigmaImportError("TIMEOUT")

        timer = _spawn(deadline())
        task = _spawn(_snapshot(request, fetch=fetch, credential=copy.deepcopy(credential), now=now, limits=limits, signal=signal))
        done, _pending = await asyncio.wait((task, timer), return_when=asyncio.FIRST_COMPLETED)
        return await (task if task in done else timer)
    except Exception as error:
        return {"format": "morivyx.plugin-run-result/0.1", "runId": run_id, "plugin": _plugin(), "capabilityId": CAPABILITY_ID,
                "status": "failure", "failure": {"code": _error_code(error, "FIGMA_IMPORT_FAILED"), "message": MESSAGE}}
    finally:
        if timer is not None:
            timer.cancel()
        if signal is not None:
            signal.abort()


async def serve_figma_importer(options, streams=_UNSET):
    """Serve one bounded message through the existing independent protocol."""
    from plugin_stdio import serve_plugin_stdio
    callbacks = {"handleRequest": lambda request: import_figma_node(request, options),
                 "validateRequest": validate_figma_import_request, "validateResult": validate_figma_import_result}
    return await serve_plugin_stdio(callbacks) if streams is _UNSET else await serve_plugin_stdio(callbacks, streams)
