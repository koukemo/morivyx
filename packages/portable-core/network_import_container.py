"""Independent raw-response framing and acquisition-to-container exchange.

Pins and matching results are host data checks, not publisher or OS proofs.
Adapters use the same cooperative read/cancel/release_lock binding as the
independent importers. Only explicitly owned connections are closed.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import http.client
import json
import math
import os
import re
import socket
import stat
import threading
import time
from types import SimpleNamespace
from urllib.parse import quote, urlsplit

from canonical import canonical_json
from figma_import import (AbortSignal, API_ORIGIN as FIGMA_ORIGIN, LIMITS as FIGMA_LIMITS,
                          PLUGIN_ID as FIGMA_ID, _HttpHeaders, _resolved, _spawn,
                          convert_figma_import_response, import_figma_node, validate_figma_import_request)
from github_import import (API_ORIGIN as GITHUB_ORIGIN, LIMITS as GITHUB_LIMITS,
                           PLUGIN_ID as GITHUB_ID, convert_github_import_responses,
                           import_github_file, validate_github_import_request)
from plugin_container import run_plugin_container
from plugin_runtime import _TRIM, _json_text, create_plugin_execution_grant
from plugin_supply_chain import verify_plugin_supply_chain
from schema_validation import SPACE, ValidationError, safe_integer

NETWORK_IMPORT_INPUT_FORMAT = "morivyx.network-import-input/0.1"
NETWORK_IMPORT_INPUT_PERMISSION = "network-import-input"
NETWORK_IMPORT_INDEX_FILE = "network-input.json"
NETWORK_IMPORT_LIMITS = {"maxResponseBytes": 2097152, "maxTotalBytes": 8388608, "maxFileBytes": 1048576,
                       "maxIndexBytes": 65536, "maxFiles": 256, "maxRequests": 19, "timeoutMs": 30000}
_UNSET = object()
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_TOKEN_SPACE = re.compile("[" + SPACE + r"\x00-\x1f\x7f]")
_SAFE = {"NETWORK_IMPORT_" + s for s in ("INPUT_INVALID", "INPUT_LIMIT", "OPTIONS_INVALID", "BINDING_MISMATCH",
    "PACKAGE_MISMATCH", "REQUEST_INVALID", "PERMISSION_DENIED", "CREDENTIAL_INVALID", "LIMITS_INVALID", "CANCELLED",
    "TIMEOUT", "OPERATION_DENIED", "TARGET_MISMATCH", "REQUEST_LIMIT", "REDIRECT_DENIED", "SOURCE_UNAVAILABLE",
    "RESPONSE_INVALID", "RESPONSE_LIMIT", "CLOCK_INVALID", "RESULT_MISMATCH", "ISOLATION_UNAVAILABLE", "PLUGIN_FAILED")}


class NetworkImportError(ValidationError):
    def __init__(self, suffix):
        super().__init__("NETWORK_IMPORT_" + suffix, "/network-import")


def _check(value, suffix="INPUT_INVALID"):
    if not value:
        raise NetworkImportError(suffix)


def _code(error):
    try:
        data = BaseException.__dict__["__dict__"].__get__(error, type(error))
        code = dict.get(data, "code")
        return code if type(code) is str else ""
    except (TypeError, ValueError):
        return ""


def _bounded(error, fallback):
    code = _code(error)
    return NetworkImportError(code[len("NETWORK_IMPORT_"):] if code in _SAFE else fallback)


def _record(value, keys, required=None):
    return type(value) is dict and all(type(k) is str and k in keys for k in value) and all(
        k in value for k in (keys if required is None else required))


def _json(value, maximum=1048576):
    try:
        text = canonical_json(value)
    except Exception:
        raise NetworkImportError("INPUT_INVALID") from None
    _check(len(text.encode("utf-8")) <= maximum, "INPUT_LIMIT")
    raw = _json_text(value)
    _check(len(raw.encode("utf-8")) <= maximum, "INPUT_LIMIT")
    return json.loads(raw)


def _bytes(value, maximum=2097152):
    ancestry = type.__dict__["__mro__"].__get__(type(value), type(type(value)))
    try:
        if any(base is bytearray for base in ancestry):
            _check(bytearray.__len__(value) <= maximum, "INPUT_LIMIT")
            return bytes(bytearray.__getitem__(value, slice(None)))
        if any(base is bytes for base in ancestry):
            _check(bytes.__len__(value) <= maximum, "INPUT_LIMIT")
            return bytes.__getitem__(value, slice(None))
        if type(value) is memoryview and value.ndim == 1 and value.format == "B" and value.c_contiguous and type(value.obj) in (bytes, bytearray):
            _check(value.nbytes <= maximum, "INPUT_LIMIT")
            return value.tobytes()
    except NetworkImportError:
        raise
    except (ValueError, BufferError):
        pass
    raise NetworkImportError("INPUT_INVALID")


def _digest(value):
    return "sha256:" + hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def _json_digest(value):
    return _digest(canonical_json(value))


def _same(left, right):
    # Python bool equality must not collapse the source's distinct values.
    if type(left) in (dict, list) or type(right) in (dict, list):
        if type(left) is not type(right):
            return False
        if type(left) is dict:
            return left.keys() == right.keys() and all(_same(left[k], right[k]) for k in left)
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    return left == right


def _request(value):
    request = _json(value)
    plugin = request.get("plugin") if type(request) is dict else None
    plugin_id = plugin.get("id") if type(plugin) is dict else None
    if plugin_id == GITHUB_ID:
        validate_github_import_request(request)
    elif plugin_id == FIGMA_ID:
        validate_figma_import_request(request)
    else:
        raise NetworkImportError("REQUEST_INVALID")
    return request


def _timestamp(value):
    """Parse ISO source clocks, including four-digit year zero and day overflow.

    The source accepts a wider clock grammar than its input index. The latter
    still requires an exact four-digit UTC millisecond round trip.
    """
    _check(type(value) is str, "CLOCK_INVALID")
    value = value.strip(_TRIM)
    match = re.fullmatch(r"([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?"
                         r"(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?", value, re.I)
    if match is None:
        try:
            if re.fullmatch(r"[0-9]{1,6}", value):
                number = int(value)
                _check(number <= 12 or number >= 32, "CLOCK_INVALID")
                year = 2000 if number == 0 else 2001 if number <= 12 else 2000 + number if number <= 49 else 1900 + number if number <= 99 else number
                month = number if 1 <= number <= 12 else 1
                label = f"{year:04d}" if year <= 9999 else f"+{year:06d}"
                return _timestamp(f"{label}-{month:02d}-01T00:00:00")
            legacy = re.fullmatch(r"([0-9]{1,6})[/-]([0-9]{1,2})(?:[/-]([0-9]{1,6}))?", value)
            if legacy is not None:
                first, second, third = legacy.groups()
                if int(first) > 31:
                    year, month, day = int(first), int(second), int(third or 1)
                else:
                    month, day, year = int(first), int(second), int(third or 2001)
                    if year < 100:
                        year += 2000 if year <= 49 else 1900
                label = f"{year:04d}" if year <= 9999 else f"+{year:06d}"
                return _timestamp(f"{label}-{month:02d}-{day:02d}T00:00:00")
            parsed = parsedate_to_datetime(value)
            return _timestamp(parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds"))
        except Exception:
            raise NetworkImportError("CLOCK_INVALID") from None
    try:
        year_text, mo, dy, hr, mi, se, frac, zone = match.groups()
        year, month, day = int(year_text), int(mo or 1), int(dy or 1)
        hour, minute, second = int(hr or 0), int(mi or 0), int(se or 0)
        millisecond = int(((frac or "") + "000")[:3])
        _check(year_text != "-000000" and (hr is None or mo is not None and dy is not None) and
               1 <= month <= 12 and 1 <= day <= 31 and 0 <= hour <= 24 and minute <= 59 and second <= 59 and
               (hour != 24 or minute == second == millisecond == 0), "CLOCK_INVALID")
        translated = 400 + year % 400
        parsed = datetime(translated, month, 1) + timedelta(days=day - 1, hours=hour, minutes=minute,
                                                           seconds=second, milliseconds=millisecond)
        if zone and zone.upper() != "Z":
            oh, om = int(zone[1:3]), int(zone[4:6])
            _check(oh <= 23 and om <= 59, "CLOCK_INVALID")
            parsed -= timedelta(minutes=(oh * 60 + om) * (-1 if zone[0] == "-" else 1))
        elif zone is None and hr is not None:
            # Local offset rules use the actual civil year, not its leap-cycle surrogate.
            if 1 <= year <= 9999:
                translated = year
                parsed = (datetime(year, month, 1) + timedelta(days=day - 1, hours=hour, minutes=minute,
                           seconds=second, milliseconds=millisecond)).astimezone(timezone.utc).replace(tzinfo=None)
            else:
                # Outside datetime's civil range, use the same Gregorian cycle.
                # The local zone supplies its historic or recurring offset rule.
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        utc_year = parsed.year + year - translated
        previous = utc_year - 1
        days = 365 * previous + previous // 4 - previous // 100 + previous // 400 - 719162
        days += (parsed - datetime(parsed.year, 1, 1)).days
        epoch = days * 86400000 + parsed.hour * 3600000 + parsed.minute * 60000 + parsed.second * 1000 + millisecond
        _check(abs(epoch) <= 8640000000000000, "CLOCK_INVALID")
        year_label = f"{utc_year:04d}" if 0 <= utc_year <= 9999 else ("+" if utc_year >= 0 else "-") + f"{abs(utc_year):06d}"
        return f"{year_label}-{parsed.month:02d}-{parsed.day:02d}T{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}.{millisecond:03d}Z"
    except (ValueError, OverflowError):
        raise NetworkImportError("CLOCK_INVALID") from None


def _valid_time(value):
    if type(value) is not str or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value) is None:
        return False
    try:
        return _timestamp(value) == value
    except NetworkImportError:
        return False


def _responses(value):
    _check(type(value) is list and 0 < len(value) <= 19)
    out, total = [], 0
    for row in value:
        _check(_record(row, ("path", "bytes")) and type(row["path"]) is str and row["path"].startswith("/") and
               not row["path"].startswith("//") and re.search(r"[\\\x00-\x20\x7f]", row["path"]) is None)
        path, raw = _json(row["path"], 4096), _bytes(row["bytes"])
        total += len(raw)
        _check(total <= 8388608, "INPUT_LIMIT")
        out.append({"path": path, "bytes": raw})
    return out


def _pack_network_import_input(request, responses, retrieved_at):
    fixed, captured = _request(request), _responses(responses)
    _check(_valid_time(retrieved_at))
    files, entries = [], []
    for ordinal, row in enumerate(captured):
        raw, chunks = row["bytes"], []
        for offset in range(0, max(1, len(raw)), 1048576):
            name = f"response-{ordinal}-{len(chunks)}.bin"
            chunks.append(name)
            files.append({"path": name, "permission": NETWORK_IMPORT_INPUT_PERMISSION, "bytes": raw[offset:offset + 1048576]})
        entries.append({"ordinal": ordinal, "path": row["path"], "bodyBytes": len(raw), "bodyDigest": _digest(raw), "chunks": chunks})
    index = {"format": NETWORK_IMPORT_INPUT_FORMAT, "requestDigest": _json_digest(fixed), "retrievedAt": retrieved_at, "responses": entries}
    raw = _json_text(index).encode("utf-8")
    _check(len(raw) <= 65536 and len(files) + 1 <= 256 and sum(len(f["bytes"]) for f in files) + len(raw) <= 8388608, "INPUT_LIMIT")
    files.insert(0, {"path": NETWORK_IMPORT_INDEX_FILE, "permission": NETWORK_IMPORT_INPUT_PERMISSION, "bytes": raw})
    return {"files": files, "inputDigest": _digest(raw)}


def _read_bounded(root, name, maximum):
    fd = None
    try:
        fd = os.open(os.path.join(root, name), os.O_RDONLY | os.O_NOFOLLOW)
        st = os.fstat(fd)
        _check(stat.S_ISREG(st.st_mode) and st.st_size <= maximum and st.st_nlink == 1)
        chunks, size = [], 0
        while size <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        _check(size <= maximum and size == st.st_size, "INPUT_LIMIT")
        return b"".join(chunks)
    except NetworkImportError:
        raise
    except Exception:
        raise NetworkImportError("INPUT_INVALID") from None
    finally:
        if fd is not None:
            os.close(fd)


async def _read_network_import_input(request, root):
    fixed = _request(request)
    _check(type(root) is str)
    try:
        names = os.listdir(root)
    except Exception:
        raise NetworkImportError("INPUT_INVALID") from None
    _check(1 < len(names) <= 256, "INPUT_LIMIT")
    raw_index = _read_bounded(root, NETWORK_IMPORT_INDEX_FILE, 65536)
    try:
        index = _json(json.loads(raw_index.decode("utf-8-sig", errors="strict")), 65536)
    except Exception:
        raise NetworkImportError("INPUT_INVALID") from None
    _check(_record(index, ("format", "requestDigest", "retrievedAt", "responses")) and
           index["format"] == NETWORK_IMPORT_INPUT_FORMAT and index["requestDigest"] == _json_digest(fixed) and
           _valid_time(index["retrievedAt"]) and type(index["responses"]) is list and 0 < len(index["responses"]) <= 19)
    seen, responses, total = {NETWORK_IMPORT_INDEX_FILE}, [], len(raw_index)
    for ordinal, entry in enumerate(index["responses"]):
        _check(_record(entry, ("ordinal", "path", "bodyBytes", "bodyDigest", "chunks")) and _same(entry["ordinal"], ordinal) and
               safe_integer(entry["bodyBytes"]) and 0 <= entry["bodyBytes"] <= 2097152 and type(entry["bodyDigest"]) is str and
               _DIGEST.fullmatch(entry["bodyDigest"]) is not None and type(entry["chunks"]) is list and
               len(entry["chunks"]) == max(1, math.ceil(entry["bodyBytes"] / 1048576)))
        chunks = []
        for part, name in enumerate(entry["chunks"]):
            _check(name == f"response-{ordinal}-{part}.bin" and name in names and name not in seen)
            seen.add(name)
            raw = _read_bounded(root, name, 1048576)
            _check(len(raw) == min(1048576, entry["bodyBytes"] - part * 1048576))
            total += len(raw)
            _check(total <= 8388608, "INPUT_LIMIT")
            chunks.append(raw)
        raw = b"".join(chunks)
        _check(_digest(raw) == entry["bodyDigest"], "INPUT_MISMATCH")
        responses.append({"path": entry["path"], "bytes": raw})
    final_names = os.listdir(root)
    _check(len(names) == len(seen) and len(final_names) == len(seen) and all(n in seen for n in final_names))
    return {"responses": _responses(responses), "retrievedAt": index["retrievedAt"], "inputDigest": _digest(raw_index)}


def _figma_path(request):
    v = request["input"]
    encode = lambda text: quote(text, safe="~!*'()-._")
    return f"/v1/files/{encode(v['fileKey'])}/nodes?ids={encode(v['nodeId'])}&version={encode(v['version'])}"


async def _convert_network_import_input(request, root):
    fixed = _request(request)
    packed = await _read_network_import_input(fixed, root)
    responses, retrieved_at = packed["responses"], packed["retrievedAt"]
    if fixed["plugin"]["id"] == GITHUB_ID:
        return await convert_github_import_responses(fixed, responses, retrieved_at)
    _check(len(responses) == 1 and responses[0]["path"] == _figma_path(fixed), "INPUT_MISMATCH")
    return convert_figma_import_response(fixed, responses[0]["bytes"], retrieved_at)


def _prepare(input_value, options):
    _check(_record(input_value, ("request", "acquisition", "execution")))
    _check(_record(input_value["execution"], ("manifest", "policy", "imageId", "artifacts")))
    _check(_record(options, ("runtimeBinding", "fetchImpl", "transport", "dockerPath", "signal", "now"), ("runtimeBinding",)), "OPTIONS_INVALID")
    candidate = _json(input_value["request"])
    _check(candidate is not None)
    cap = candidate.get("capability") if type(candidate) is dict else None
    _check(type(cap) is dict and cap.get("effect") == "read-only", "OPERATION_DENIED")
    try:
        request = _request(candidate)
    except Exception:
        raise NetworkImportError("REQUEST_INVALID") from None
    acquisition = _json(input_value["acquisition"])
    execution = {k: _json(input_value["execution"][k]) for k in ("manifest", "policy", "imageId")}
    binding = _json(options["runtimeBinding"])
    identity = execution["manifest"].get("identity") if type(execution["manifest"]) is dict else None
    _check(_record(binding, ("manifestDigest", "packageDigest", "imageId")) and type(execution["imageId"]) is str and
           _DIGEST.fullmatch(execution["imageId"]) is not None and binding["imageId"] == execution["imageId"] and
           binding["manifestDigest"] == _json_digest(execution["manifest"]) and type(identity) is dict and
           binding["packageDigest"] == identity.get("packageDigest"), "BINDING_MISMATCH")
    artifacts = input_value["execution"]["artifacts"]
    if _record(artifacts, ("package", "signature", "sbom"), ()):
        # The wrapper accepts native byte subclasses without invoking their hooks.
        # Existing supply-chain code receives detached exact built-ins.
        try:
            artifacts = {k: _bytes(v, 16777216) for k, v in artifacts.items()}
        except NetworkImportError:
            raise NetworkImportError("PACKAGE_MISMATCH") from None
    supply = verify_plugin_supply_chain({"manifest": execution["manifest"], "expectedPackageDigest": binding["packageDigest"],
                                       "artifacts": artifacts})
    _check(supply["status"] == "matched", "PACKAGE_MISMATCH")
    _check(_record(acquisition, ("manifest", "policy", "permission", "credential", "limits"), ("manifest", "policy", "permission")))
    try:
        host = create_plugin_execution_grant(acquisition["manifest"], request, acquisition["policy"]).to_dict()
        worker = create_plugin_execution_grant(execution["manifest"], request, execution["policy"]).to_dict()
    except Exception:
        raise NetworkImportError("PERMISSION_DENIED") from None
    github = request["plugin"]["id"] == GITHUB_ID
    input_format = "morivyx.github-read-input/0.1" if github else "morivyx.figma-node-input/0.1"
    output_format = "morivyx.github-file-snapshot/0.1" if github else "morivyx.figma-node-snapshot/0.1"
    for manifest in (acquisition["manifest"], execution["manifest"]):
        capability = next(c for c in manifest["capabilities"] if c["id"] == request["capability"]["id"])
        _check(capability["inputFormat"] == input_format and capability["outputFormat"] == output_format, "REQUEST_INVALID")
    origin, secret = (GITHUB_ORIGIN, "github-read-token") if github else (FIGMA_ORIGIN, "figma-read-token")
    hp, wp = host["capability"]["permissions"], worker["capability"]["permissions"]
    _check(all(hp[k] == [] for k in ("graphRead", "fileRead", "devices")) and hp["network"] == [origin] and
           (hp["secrets"] == [secret] or github and "credential" not in acquisition and hp["secrets"] == []), "PERMISSION_DENIED")
    _check(all(wp[k] == [] for k in ("graphRead", "network", "secrets", "devices")) and
           wp["fileRead"] == [NETWORK_IMPORT_INPUT_PERMISSION], "PERMISSION_DENIED")
    permission = {"apiOrigin": origin, **{k: request["input"][k] for k in
                  (("owner", "repository", "repositoryId") if github else ("fileKey",))}}
    _check(_same(acquisition["permission"], permission), "PERMISSION_DENIED")
    if "credential" in acquisition or not github:
        credential = acquisition.get("credential")
        _check(_record(credential, ("token",) if github else ("kind", "token")) and
               (github or credential["kind"] in ("oauth", "personal-access-token")) and type(credential["token"]) is str and
               0 < len(credential["token"].encode("utf-16-le")) // 2 <= 8192 and _TOKEN_SPACE.search(credential["token"]) is None, "CREDENTIAL_INVALID")
    defaults = GITHUB_LIMITS if github else FIGMA_LIMITS
    overrides = acquisition.get("limits")
    overrides = {} if overrides is None else overrides
    _check(_record(overrides, defaults.keys(), ()), "LIMITS_INVALID")
    limits = {**defaults, **overrides}
    _check(all(safe_integer(v) and 0 < v <= defaults[k] for k, v in limits.items()), "LIMITS_INVALID")
    for grant in (host, worker):
        resources = grant["capability"]["resources"]
        _check("maxCostUnits" not in resources and resources.get("maxMemoryBytes", 134217728) >= 33554432, "LIMITS_INVALID")
    limits["timeoutMs"] = min(limits["timeoutMs"], host["capability"]["resources"]["timeoutMs"],
                              worker["capability"]["resources"]["timeoutMs"], 30000)
    execution["policy"]["capability"]["resources"]["maxOutputBytes"] = min(host["capability"]["resources"]["maxOutputBytes"],
        worker["capability"]["resources"]["maxOutputBytes"], 1048576)
    _check(len(_json_text(request).encode("utf-8")) + 1 <= 1048576 and len(canonical_json(worker).encode("utf-8")) <= 65536, "INPUT_LIMIT")
    now = options.get("now")
    now = _now if now is None else now
    _check(("fetchImpl" not in options or callable(options["fetchImpl"])) and callable(now) and
           ("transport" not in options or callable(options["transport"])) and
           ("signal" not in options or isinstance(options["signal"], AbortSignal)) and
           ("dockerPath" not in options or type(options["dockerPath"]) is str and os.path.isabs(options["dockerPath"]) and
            "\0" not in options["dockerPath"]), "OPTIONS_INVALID")
    return {"request": request, "acquisition": acquisition, "execution": execution, "binding": binding, "github": github,
            "origin": origin, "limits": limits, "fetch": options.get("fetchImpl"), "now": now,
            "transport": options.get("transport"), "signal": options.get("signal"), "dockerPath": options.get("dockerPath")}


def _now_ms():
    return time.time_ns() // 1000000


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _cancel_body(body):
    async def cancel():
        try:
            await _resolved(body.cancel())
        except Exception:
            pass
    _spawn(cancel())


class _MemoryReader:
    def __init__(self, raw):
        self.raw, self.done = raw, False

    async def read(self):
        if self.done:
            return {"done": True}
        self.done = True
        return {"done": False, "value": self.raw}

    async def cancel(self):
        self.done = True

    def release_lock(self):
        pass


class _MemoryBody:
    def __init__(self, raw):
        self.reader = _MemoryReader(raw)

    def get_reader(self):
        return self.reader

    async def cancel(self):
        await self.reader.cancel()


async def _run(p):
    signal = p["signal"]
    _check(signal is None or not signal.aborted, "CANCELLED")
    owned = _OwnedTransport(p["limits"]["timeoutMs"]) if p["fetch"] is None else None
    fetch = owned.fetch if owned is not None else p["fetch"]
    controller, responses = AbortSignal(), []
    deadline = _now_ms() + p["limits"]["timeoutMs"]
    stopped = asyncio.get_running_loop().create_future()
    state = {"stop": None, "captureError": None, "retrievedAt": None, "total": 0, "count": 0}

    def stop(code):
        if state["stop"] is None:
            state["stop"] = code
            controller.abort()
            if not stopped.done():
                stopped.set_result(None)

    abort = lambda: stop("CANCELLED")
    timer = asyncio.get_running_loop().call_later(p["limits"]["timeoutMs"] / 1000, stop, "TIMEOUT")
    if signal is not None:
        signal.add_event_listener("abort", abort, once=True)

    def active():
        if _now_ms() >= deadline:
            stop("TIMEOUT")
        _check(state["stop"] is None, state["stop"] or "TIMEOUT")

    async def captured(url, settings):
        response, reader, complete = None, None, False
        joined = AbortSignal()
        relay = joined.abort
        source_signal = settings.get("signal")
        if source_signal is not None:
            source_signal.add_event_listener("abort", relay, once=True)
        controller.add_event_listener("abort", relay, once=True)
        if controller.aborted or source_signal is not None and source_signal.aborted:
            joined.abort()

        def cancel():
            body = reader if reader is not None else getattr(response, "body", None)
            if body is not None:
                _cancel_body(body)
        try:
            active()
            _check(type(url) is str and url.startswith(p["origin"] + "/") and settings.get("method") == "GET" and
                   settings.get("redirect") == "manual" and "body" not in settings, "OPERATION_DENIED")
            path = url[len(p["origin"]):]
            v = p["request"]["input"]
            prefix = f"/repos/{v.get('owner')}/{v.get('repository')}"
            _check((path == prefix or path.startswith(prefix + "/git/") and
                    re.search(r"/(?:commits|trees|blobs)/[0-9a-f]{40}$", path) is not None) if p["github"] else
                   path == _figma_path(p["request"]), "TARGET_MISMATCH")
            state["count"] += 1
            _check(state["count"] <= (p["limits"]["maxRequests"] if p["github"] else 1), "REQUEST_LIMIT")
            response = await _resolved(fetch(url, {**settings, "signal": joined}))
            active()
            status = getattr(response, "status", None)
            _check(response is not None and not getattr(response, "redirected", False) and
                   (not getattr(response, "url", "") or response.url == url) and
                   not (type(status) in (int, float) and 300 <= status < 400), "REDIRECT_DENIED")
            _check(type(status) in (int, float) and status == 200, "SOURCE_UNAVAILABLE")
            content_type = response.headers.get("content-type")
            _check(type(content_type) is str and re.match(r"application/(?:[\w.-]+\+)?json(?:;|$)", content_type, re.I | re.ASCII) is not None, "RESPONSE_INVALID")
            declared = response.headers.get("content-length")
            if declared is not None:
                _check(type(declared) is str and re.fullmatch(r"[0-9]+", declared) is not None, "RESPONSE_LIMIT")
                digits = declared.lstrip("0") or "0"
                _check(len(digits) <= 16 and safe_integer(int(digits)) and
                       int(digits) <= p["limits"]["maxResponseBytes"], "RESPONSE_LIMIT")
            _check(response.body is not None, "RESPONSE_INVALID")
            reader = response.body.get_reader()
            controller.add_event_listener("abort", cancel, once=True)
            chunks, size = [], 0
            while True:
                part = await _resolved(reader.read())
                active()
                if part.get("done"):
                    complete = True
                    break
                try:
                    raw = _bytes(part.get("value"), p["limits"]["maxResponseBytes"])
                except Exception as error:
                    raise NetworkImportError("RESPONSE_LIMIT" if _code(error) == "NETWORK_IMPORT_INPUT_LIMIT" else "RESPONSE_INVALID") from None
                size += len(raw)
                state["total"] += len(raw)
                _check(size <= p["limits"]["maxResponseBytes"] and state["total"] <=
                       (p["limits"]["maxTotalResponseBytes"] if p["github"] else p["limits"]["maxResponseBytes"]), "RESPONSE_LIMIT")
                chunks.append(raw)
            raw = b"".join(chunks)
            state["retrievedAt"] = _timestamp(p["now"]())
            responses.append({"path": path, "bytes": raw})
            return SimpleNamespace(status=200, redirected=False, url="", headers=_HttpHeaders({"content-type": "application/json"}), body=_MemoryBody(raw))
        except Exception as error:
            state["captureError"] = _bounded(error, "SOURCE_UNAVAILABLE")
            raise state["captureError"] from None
        finally:
            controller.remove_event_listener("abort", cancel)
            controller.remove_event_listener("abort", relay)
            if source_signal is not None:
                source_signal.remove_event_listener("abort", relay)
            if not complete:
                cancel()
            try:
                if reader is not None:
                    reader.release_lock()
            except Exception:
                pass
    try:
        settings = {"permission": p["acquisition"]["permission"], "limits": p["limits"], "fetchImpl": captured,
                    "now": lambda: state["retrievedAt"]}
        if p["github"]:
            if "credential" in p["acquisition"]:
                settings["token"] = p["acquisition"]["credential"]["token"]
            acquisition = _spawn(import_github_file(p["request"], settings))
        else:
            acquisition = _spawn(import_figma_node(p["request"], {**settings, "credential": p["acquisition"]["credential"]}))
        await asyncio.wait((acquisition, stopped), return_when=asyncio.FIRST_COMPLETED)
        active()
        baseline = await acquisition
        if state["captureError"] is not None:
            raise state["captureError"]
        if baseline["status"] != "success":
            code = baseline["failure"]["code"]
            raise NetworkImportError("TARGET_MISMATCH" if code.endswith(("IDENTITY_MISMATCH", "TARGET_MISSING")) else
                "TIMEOUT" if code.endswith("TIMEOUT") else "REQUEST_LIMIT" if code.endswith("REQUEST_LIMIT") else
                "RESPONSE_LIMIT" if code.endswith(("RESPONSE_LIMIT", "RESPONSE_DEPTH")) else "RESPONSE_INVALID")
        packed = _pack_network_import_input(p["request"], responses, state["retrievedAt"])
        active()
        p["execution"]["policy"]["capability"]["resources"]["timeoutMs"] = max(1, deadline - _now_ms())
        execution_options = {"signal": controller}
        if p["transport"] is not None:
            execution_options["transport"] = p["transport"]
        if p["dockerPath"] is not None:
            execution_options["dockerPath"] = p["dockerPath"]
        # No race: the container's ownership cleanup completes before return.
        isolated = await run_plugin_container({**p["execution"], "request": p["request"], "files": packed["files"]}, execution_options)
        active()
        _check(isolated["result"]["status"] == "success", "PLUGIN_FAILED")
        _check(_same(isolated["result"], baseline), "RESULT_MISMATCH")
        active()
        return {"format": "morivyx.network-import-run/0.1", "result": isolated["result"], "isolation": isolated["isolation"],
                "acquisition": {"apiOrigin": p["origin"], "requestCount": state["count"], "responseBytes": state["total"], "retrievedAt": state["retrievedAt"]},
                "binding": {**p["binding"], "requestDigest": _json_digest(p["request"]), "inputDigest": packed["inputDigest"],
                            "status": "host-pins-matched", "authenticity": "not-verified", "executionBinding": "not-verified"}}
    except Exception as error:
        code = _code(error)
        if code == "PLUGIN_ISOLATION_CLEANUP_FAILED":
            raise
        if state["stop"] is not None:
            raise NetworkImportError(state["stop"]) from None
        if code in _SAFE:
            raise _bounded(error, "PLUGIN_FAILED") from None
        raise NetworkImportError("TIMEOUT" if code == "PLUGIN_ISOLATION_TIMEOUT" else
            "CANCELLED" if code == "PLUGIN_ISOLATION_CANCELLED" else
            "ISOLATION_UNAVAILABLE" if code in ("PLUGIN_ISOLATION_UNAVAILABLE", "PLUGIN_ISOLATION_IMAGE_UNAVAILABLE") else "PLUGIN_FAILED") from None
    finally:
        timer.cancel()
        if signal is not None:
            signal.remove_event_listener("abort", abort)
        controller.abort()
        responses.clear()
        p["acquisition"].pop("credential", None)
        if owned is not None:
            await owned.close()


def run_network_import_container(input_value, options=_UNSET):
    """Capture caller-owned data synchronously, then return an awaitable.

    runtimeBinding is required. fetchImpl, transport, signal, now and absolute
    dockerPath are host adapters, not fields accepted from extension JSON.
    """
    try:
        prepared = _prepare(input_value, {} if options is _UNSET else options)
    except Exception as error:
        raise _bounded(error, "INPUT_INVALID") from None
    return _run(prepared)


class _ConnectionReader:
    def __init__(self, response, connection, owned_socket, owner):
        self.response, self.connection, self.owned_socket, self.owner = response, connection, owned_socket, owner

    async def read(self):
        raw = await asyncio.shield(self.owner.background(asyncio.to_thread(self.response.read, 65536)))
        if not raw and self.response.length not in (None, 0):
            raise OSError("incomplete declared response")
        return {"done": not raw, "value": raw}

    async def cancel(self):
        _close_connection(self.connection, self.owned_socket)
        self.response.close()

    def release_lock(self):
        self.response.close()


class _ConnectionBody:
    def __init__(self, response, connection, owned_socket, owner):
        self.reader = _ConnectionReader(response, connection, owned_socket, owner)

    def get_reader(self):
        return self.reader

    async def cancel(self):
        await self.reader.cancel()


def _close_connection(connection, owned_socket=None):
    for sock in (connection.sock, owned_socket):
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    connection.close()


class _OwnedTransport:
    """No shared pool, proxy discovery, redirect following or retry.

    Only this invocation's standard-library connections are owned. DNS and
    operating-system cancellation remain platform behavior, not OS proof.
    """
    def __init__(self, timeout_ms):
        self.timeout_ms, self.closed = timeout_ms, False
        self.connections, self.tasks, self.lock = {}, set(), threading.Lock()

    def background(self, awaitable):
        task = _spawn(awaitable)
        self.tasks.add(task)
        return task

    async def fetch(self, url, settings):
        _check(not self.closed and not settings.get("signal").aborted, "CANCELLED")
        _check(settings.get("method") == "GET" and settings.get("redirect") == "manual", "OPERATION_DENIED")
        target = urlsplit(url)
        _check(target.scheme == "https" and target.hostname is not None and not target.username and not target.password, "OPERATION_DENIED")
        connection = http.client.HTTPSConnection(target.hostname, target.port, timeout=self.timeout_ms / 1000)
        signal = settings.get("signal")
        def abort():
            with self.lock:
                sock = self.connections.get(connection)
            _close_connection(connection, sock)
        with self.lock:
            _check(not self.closed, "CANCELLED")
            self.connections[connection] = None
        signal.add_event_listener("abort", abort, once=True)

        def request():
            try:
                _check(not self.closed and not signal.aborted, "CANCELLED")
                headers = {k.lower(): v for k, v in settings.get("headers", {}).items()}
                headers["connection"] = "close"
                connection.request("GET", target.path + ("?" + target.query if target.query else ""), headers=headers)
                owned_socket = connection.sock
                with self.lock:
                    self.connections[connection] = owned_socket
                if self.closed or signal.aborted:
                    _close_connection(connection, owned_socket)
                    raise NetworkImportError("CANCELLED")
                response = connection.getresponse()
                if self.closed or signal.aborted:
                    _close_connection(connection, owned_socket)
                    raise NetworkImportError("CANCELLED")
                return SimpleNamespace(status=response.status, redirected=False, url=url, headers=_HttpHeaders(response.headers),
                                       body=None if response.status in (204, 205, 304) else _ConnectionBody(response, connection, owned_socket, self))
            except Exception:
                _close_connection(connection)
                raise

        task = self.background(asyncio.to_thread(request))
        try:
            return await asyncio.shield(task)
        finally:
            signal.remove_event_listener("abort", abort)

    async def close(self):
        with self.lock:
            self.closed = True
            connections = list(self.connections.items())
        for connection, sock in connections:
            _close_connection(connection, sock)
        if self.tasks:
            _done, pending = await asyncio.wait(self.tasks, timeout=5)
            _check(not pending, "NETWORK_CLEANUP_FAILED")
        self.connections.clear()
        self.tasks.clear()
