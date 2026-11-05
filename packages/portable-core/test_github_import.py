"""Frozen source cases, bounded transport bindings and protocol driver."""

import asyncio
import base64
import copy
import hashlib
from http.client import HTTPMessage
import io
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from canonical import canonical_json
from figma_import import _external_document
import github_import
from github_import import github_import_request, validate_github_import_request, validate_github_import_result
from github_import import convert_github_import_responses, import_github_file, compare_github_import_snapshots, assess_github_reimport
from plugin_runtime import _json_text
from plugin_stdio import serve_plugin_stdio

FIXTURE = Path(__file__).parent / "fixtures/github-import-vectors.json"
PIN = "e643181fd8018d306ee234a3262855edec3ee4727d67df113db83f9c403f684e"


def fixture():
    data = FIXTURE.read_bytes()
    if hashlib.sha256(data).hexdigest() != PIN:
        raise ValueError("frozen GitHub fixture changed")
    value = json.loads(data)
    if value["count"] != 934 or len(value["cases"]) != 934:
        raise ValueError("frozen GitHub cases missing")
    return value


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def body_bytes(row):
    if "bodyValue" in row:
        return row["bodyValue"]
    if "bodyHex" in row:
        return bytes.fromhex(row["bodyHex"])
    if "expansion" in row:
        part = row["expansion"]
        text = part["prefix"] + part["unit"] * int(part["count"]) + part["suffix"]
        if sha(text) != part["sha256"]:
            raise ValueError("expansion changed")
        return text.encode("utf-8")
    return row.get("body", "").encode("utf-8")


def captured_responses(rows):
    return [(row["raw"] if "raw" in row else {"path": row.get("path"), "bytes": body_bytes(row)}) if type(row) is dict else
            {"path": None, "bytes": b""} for row in rows] if type(rows) is list else rows


def scripted_acquisition(spec):
    events = {"calls": [], "reads": 0, "aborts": 0, "bodyCancels": 0, "readerCancels": 0, "releases": 0, "clocks": 0}
    late, blocked = [], []

    def fetch(url, options):
        index = len(events["calls"])
        rows = spec.get("responses", [])
        row = rows[index] if index < len(rows) else {"body": "{}"}
        outer = spec.get("plan", {})
        plan = {**(outer if "at" not in outer or outer["at"] == index else {}), **row.get("plan", {})}
        events["calls"].append({"url": url, "method": options["method"], "redirect": options["redirect"], "cache": options["cache"],
            "headers": dict(options["headers"]), "signalAborted": options["signal"].aborted})
        def aborted():
            events["aborts"] += 1
        options["signal"].add_event_listener("abort", aborted, once=True)
        data, offset = body_bytes(row), 0
        storage = bytearray(int(plan.get("chunkSize", 7))) if plan.get("reuseChunk") else None

        class Reader:
            async def read(self):
                nonlocal offset
                events["reads"] += 1
                if plan.get("readMode") == "throw":
                    raise RuntimeError("OWNED_READ_FAILURE")
                if plan.get("readMode") == "never":
                    future = asyncio.get_running_loop().create_future()
                    blocked.append(future)
                    return await future
                if offset >= len(data):
                    return {"done": True, "value": None}
                end = min(offset + int(plan.get("chunkSize", len(data))), len(data))
                value = data[offset:end]
                if storage is not None:
                    storage[:] = b"\0" * len(storage)
                    storage[:len(value)] = value
                    value = memoryview(storage)[:len(value)]
                offset = end
                return {"done": False, "value": [] if plan.get("readMode") == "invalid" else value}

            async def cancel(self):
                events["readerCancels"] += 1
                for future in blocked:
                    if not future.done():
                        future.set_result({"done": True, "value": None})
                blocked.clear()

            def release_lock(self):
                events["releases"] += 1

        reader = Reader()

        class Body:
            def get_reader(self):
                if plan.get("readerMode") == "throw":
                    raise RuntimeError("OWNED_READER_FAILURE")
                return reader

            async def cancel(self):
                events["bodyCancels"] += 1

        class Headers:
            def get(self, name):
                if name == "content-type":
                    return plan.get("contentType", "application/json")
                if name == "content-length":
                    return plan.get("contentLength")
                return None

        response = SimpleNamespace(status=plan.get("status", 200), redirected=plan.get("redirected", False), url=plan.get("url", ""),
                                   body=None if plan.get("bodyMode") == "null" else Body(), headers=Headers())
        mode = plan.get("fetchMode")
        if mode == "throw":
            raise RuntimeError("OWNED_FETCH_FAILURE")
        if mode == "trusted":
            class Derived(github_import.GitHubImportError):
                pass
            raise Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE")
        if mode in ("never", "late"):
            future = asyncio.get_running_loop().create_future()
            if mode == "late":
                late.append((future, response))
            return future
        return None if plan.get("responseMode") == "null" else response

    def now():
        events["clocks"] += 1
        if spec.get("plan", {}).get("clockMode") == "throw":
            raise RuntimeError("OWNED_CLOCK_FAILURE")
        return spec.get("retrievedAt")

    plan = spec.get("plan", {})
    options = None if spec.get("options", {}) is None else {**spec.get("options", {}),
        "fetchImpl": False if plan.get("adapterMode") == "invalid" else fetch,
        "now": False if plan.get("clockMode") == "invalid" else now}

    async def settle():
        for future, response in late:
            if not future.done():
                future.set_result(response)
        for _ in range(4):
            await asyncio.sleep(0)
    return options, events, settle


async def outcome(entry):
    spec, _ = _external_document(entry["inputText"])
    before = json.dumps(spec, ensure_ascii=True)
    original, events, identity = None, None, False
    try:
        operation = entry["operation"]
        if operation == "make-request":
            result = github_import_request(spec)
        elif operation == "validate-request":
            original, identity = spec, True
            result = validate_github_import_request(spec)
        elif operation == "validate-result":
            original, identity = spec.get("result"), True
            result = validate_github_import_result(original, spec.get("request"))
        elif operation == "convert":
            args = [spec["request"], captured_responses(spec["responses"]), spec.get("retrievedAt")]
            if "limits" in spec:
                args.append(spec["limits"])
            result = await convert_github_import_responses(*args)
        elif operation == "compare":
            result = compare_github_import_snapshots(spec)
        elif operation == "assess":
            result = assess_github_reimport(spec)
        elif operation == "acquire":
            options, events, settle = scripted_acquisition(spec)
            result = await import_github_file(spec["request"], options)
            await settle()
        else:
            raise ValueError("unsupported fixture operation")
        assert json.dumps(spec, ensure_ascii=True) == before
        text = _json_text(result)
        return {"accepted": True, "outputText": text, "outputSha256": sha(text), "canonicalSha256": sha(canonical_json(result)),
                "sameInput": result is original if identity else None, "events": events}
    except Exception as error:
        assert json.dumps(spec, ensure_ascii=True) == before
        return {"accepted": False, "code": getattr(error, "code", type(error).__name__), "path": getattr(error, "path", None), "events": events}


async def replay(entries):
    return [{"id": entry["id"], "outcome": await outcome(entry)} for entry in entries]


class GitHubImportTests(unittest.TestCase):
    def test_frozen_source_outcomes(self):
        data = fixture()
        actual = asyncio.run(replay(data["cases"]))
        for entry, result in zip(data["cases"], actual):
            with self.subTest(case=entry["id"]):
                self.assertEqual(result["outcome"], entry["expected"])

    def test_captured_path_capacity_preserves_limit_diagnostics(self):
        data = fixture()
        for path in ["/" + '"' * 2047, "/" + "x" * 4094, "/" + "e\u0301" * 1400]:
            rows = captured_responses(data["responses"])
            rows[0]["path"] = path
            with self.assertRaises(github_import.ValidationError) as raised:
                asyncio.run(convert_github_import_responses(data["request"], rows, data["retrievedAt"]))
            self.assertEqual(raised.exception.code, "NETWORK_IMPORT_INPUT_LIMIT")
            self.assertEqual(raised.exception.path, "/network-import")

    def test_standard_http_binding_bounds_reads_and_closes_truncated_streams(self):
        data = fixture()
        streams, calls = [], []
        truncate = False

        class Response(io.BytesIO):
            def __init__(self, url, body):
                super().__init__(body[:-1] if truncate else body)
                self.url, self.status = url, 200
                self.headers = HTTPMessage()
                self.headers["Content-Type"] = " application/json\t"
                self.headers["Content-Length"] = "0" * 6000 + str(len(body))
                self.remaining = len(body)

            def geturl(self):
                return self.url

            def read(self, count=-1):
                if count <= 0 or count > self.remaining:
                    raise OSError("read beyond declared length")
                result = super().read(count)
                self.remaining -= len(result)
                return result

        def open_response(request, *, timeout):
            index = len(calls)
            row = data["responses"][index]
            self.assertEqual(request.full_url, github_import.API_ORIGIN + row["path"])
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(timeout, 30)
            self.assertEqual(request.get_header("Authorization"), "Bearer owned-synthetic-test-token")
            calls.append(request.full_url)
            stream = Response(request.full_url, body_bytes(row))
            streams.append(stream)
            return stream

        with patch("github_import.urllib.request.build_opener", return_value=SimpleNamespace(open=open_response)) as opener:
            actual = asyncio.run(import_github_file(data["request"], {**data["options"], "now": lambda: data["retrievedAt"]}))
            self.assertEqual(actual, data["result"])
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(stream.closed for stream in streams))
            self.assertIsInstance(opener.call_args.args[0], github_import._NoRedirect)
            self.assertIsNone(opener.call_args.args[0].redirect_request(None, None, 302, "owned", {}, "https://invalid.example.test"))
            truncate = True
            calls.clear()
            actual = asyncio.run(import_github_file(data["request"], {**data["options"], "now": lambda: data["retrievedAt"]}))
            self.assertEqual(actual["failure"]["code"], "GITHUB_IMPORT_FAILED")
            self.assertTrue(all(stream.closed for stream in streams))

    def test_authorized_identity_is_copied_before_adapter_runs(self):
        data = fixture()
        request = copy.deepcopy(data["request"])
        options, events, settle = scripted_acquisition({**data, "options": data["options"]})
        original = options["fetchImpl"]

        def mutate(url, fields):
            request["input"]["owner"] = "other-owner"
            request["input"]["commit"] = "a" * 40
            return original(url, fields)
        options["fetchImpl"] = mutate

        async def run():
            result = await import_github_file(request, options)
            await settle()
            return result
        self.assertEqual(asyncio.run(run()), data["result"])
        self.assertEqual(len(events["calls"]), 4)

    def test_only_trusted_own_error_data_reaches_diagnostics(self):
        data = fixture()

        class Derived(github_import.GitHubImportError):
            pass

        class Guarded(Derived):
            def __getattribute__(self, name):
                if name in ("code", "__dict__", "__class__"):
                    raise AssertionError("exception property must not run")
                return super().__getattribute__(name)

        trusted = [github_import.GitHubImportError("GITHUB_IMPORT_SOURCE_UNAVAILABLE"),
                   Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), Guarded("GITHUB_IMPORT_SOURCE_UNAVAILABLE")]
        invalid = Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE")
        invalid.code = 7
        surrogate = Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE")
        surrogate.code = "\ud800"
        for error in [*trusted, invalid, surrogate, RuntimeError("OWNED_PRIVATE_FAILURE")]:
            def fail(_url, _options):
                raise error
            result = asyncio.run(import_github_file(data["request"], {**data["options"], "fetchImpl": fail}))
            self.assertEqual(result["failure"]["code"], "GITHUB_IMPORT_SOURCE_UNAVAILABLE" if error in trusted else "GITHUB_IMPORT_FAILED")
            self.assertNotIn("OWNED_PRIVATE_FAILURE", _json_text(result))


async def stdio_worker(spec):
    options, _events, _settle = scripted_acquisition(spec)
    return await serve_plugin_stdio({"handleRequest": lambda request: import_github_file(request, options),
                                    "validateRequest": validate_github_import_request, "validateResult": validate_github_import_result})


async def trusted_probes():
    data = fixture()

    class Derived(github_import.GitHubImportError):
        pass

    class Guarded(Derived):
        def __getattribute__(self, name):
            if name in ("code", "__dict__", "__class__"):
                raise AssertionError("diagnostic getter must not run")
            return super().__getattribute__(name)
    number, surrogate = Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE")
    number.code, surrogate.code = 7, "\ud800"
    result = []
    for error in [github_import.GitHubImportError("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), Derived("GITHUB_IMPORT_SOURCE_UNAVAILABLE"),
                  Guarded("GITHUB_IMPORT_SOURCE_UNAVAILABLE"), number, surrogate, RuntimeError("OWNED_PRIVATE_FAILURE")]:
        def fail(_url, _options):
            raise error
        value = await import_github_file(data["request"], {**data["options"], "fetchImpl": fail})
        result.append(value["failure"]["code"])
    return result


if __name__ == "__main__":
    if "--replay" in sys.argv:
        if "--isolated" in sys.argv:
            assert shutil.which("node") is None and shutil.which("git") is None
        print(_json_text(asyncio.run(replay(fixture()["cases"]))))
    elif "--probes" in sys.argv:
        entries = json.loads(sys.stdin.read())
        print(_json_text(asyncio.run(replay(entries))))
    elif "--stdio-worker" in sys.argv:
        spec = json.loads(base64.b64decode(sys.argv[-1]))
        result = asyncio.run(stdio_worker(spec))
        sys.exit(result["exitCode"])
    elif "--trusted-probes" in sys.argv:
        print(_json_text(asyncio.run(trusted_probes())))
    else:
        unittest.main()
