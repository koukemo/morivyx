"""Frozen source outcomes, adapter cleanup and real protocol verification."""

import asyncio
import copy
import hashlib
import io
import json
import shutil
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import figma_import
from canonical import canonical_json, load_json
from figma_import import convert_figma_import_response, import_figma_node, compare_figma_import_snapshots
from figma_import import validate_figma_import_request, validate_figma_import_result, serve_figma_importer
from plugin_runtime import _json_text
from schema_validation import ValidationError

FIXTURE = Path(__file__).parent / "fixtures/figma-import-vectors.json"
PIN = "a9fe6e7ab19f3b1ce360b6f14c6c0660543c286253c46f5f489bb9dc8a591f0c"


def fixture():
    data = FIXTURE.read_bytes()
    if hashlib.sha256(data).hexdigest() != PIN:
        raise ValueError("frozen Figma fixture changed")
    value = json.loads(data)
    if value["count"] != 682 or len(value["cases"]) != 682:
        raise ValueError("frozen Figma cases missing")
    return value


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def body_bytes(spec):
    if "bodyValue" in spec:
        return spec["bodyValue"]
    if "bodyHex" in spec:
        return bytes.fromhex(spec["bodyHex"])
    if "expansion" in spec:
        part = spec["expansion"]
        text = part["prefix"] + part["unit"] * part["count"] + part["suffix"]
        if sha(text) != part["sha256"]:
            raise ValueError("expansion changed")
        return text.encode("utf-8")
    return spec.get("body", "").encode("utf-8")


def scripted_acquisition(spec):
    plan = spec.get("plan", {})
    events = {"calls": [], "reads": 0, "aborts": 0, "bodyCancels": 0, "readerCancels": 0, "releases": 0, "clocks": 0}
    data = body_bytes(spec)
    state = {"offset": 0, "late": None, "blocked": None}

    class Reader:
        async def read(self):
            events["reads"] += 1
            mode = plan.get("readMode")
            if mode == "throw":
                raise RuntimeError("OWNED_FAILURE_MUST_NOT_ESCAPE")
            if mode == "never":
                state["blocked"] = asyncio.get_running_loop().create_future()
                return await state["blocked"]
            if state["offset"] >= len(data):
                return {"done": True, "value": None}
            end = min(state["offset"] + plan.get("chunkSize", len(data)), len(data))
            value = [] if mode == "invalid" else data[state["offset"]:end]
            state["offset"] = end
            return {"done": False, "value": value}

        async def cancel(self):
            events["readerCancels"] += 1
            if state["blocked"] is not None and not state["blocked"].done():
                state["blocked"].set_result({"done": True, "value": None})

        def release_lock(self):
            events["releases"] += 1

    class Body:
        def get_reader(self):
            if plan.get("readerMode") == "throw":
                raise RuntimeError("OWNED_READER_FAILURE")
            return reader

        async def cancel(self):
            events["bodyCancels"] += 1

    reader = Reader()
    response = SimpleNamespace(status=plan.get("status", 200), redirected=plan.get("redirected", False), url=plan.get("url", ""),
                               body=None if plan.get("bodyMode") == "null" else Body(),
                               headers={"content-type": plan.get("contentType", "application/json"), "content-length": plan.get("contentLength")})

    def fetch(url, options):
        events["calls"].append({"url": url, **{key: options[key] for key in ("method", "redirect", "cache")},
                                "headers": dict(options["headers"]), "signalAborted": options["signal"].aborted})
        def aborted():
            events["aborts"] += 1
        options["signal"].add_event_listener("abort", aborted, once=True)
        mode = plan.get("fetchMode")
        if mode == "throw":
            raise RuntimeError("OWNED_FETCH_FAILURE")
        if mode == "never":
            return asyncio.get_running_loop().create_future()
        if mode == "late":
            state["late"] = asyncio.get_running_loop().create_future()
            return state["late"]
        return None if plan.get("responseMode") == "null" else response

    def now():
        events["clocks"] += 1
        if plan.get("clockMode") == "throw":
            raise RuntimeError("OWNED_CLOCK_FAILURE")
        return spec.get("retrievedAt")

    options = None if spec.get("options", {}) is None else {**spec.get("options", {}),
              "fetchImpl": False if plan.get("adapterMode") == "invalid" else fetch,
              "now": False if plan.get("clockMode") == "invalid" else now}

    async def settle():
        if state["late"] is not None and not state["late"].done():
            state["late"].set_result(response)
        for _ in range(8):
            await asyncio.sleep(0)
    return options, events, settle


async def run_case(entry):
    spec = load_json(entry["inputText"])
    before = json.dumps(spec, ensure_ascii=True)
    events, original = None, None
    try:
        operation = entry["operation"]
        if operation == "validate-request":
            original = spec
            result = validate_figma_import_request(spec)
        elif operation == "validate-result":
            original = spec.get("result")
            result = validate_figma_import_result(original, spec.get("request"))
        elif operation == "convert":
            args = (spec.get("request"), body_bytes(spec), spec.get("retrievedAt"))
            result = convert_figma_import_response(*args, spec["limits"]) if "limits" in spec else convert_figma_import_response(*args)
        elif operation == "compare":
            result = compare_figma_import_snapshots(spec)
        elif operation == "acquire":
            options, events, settle = scripted_acquisition(spec)
            result = await import_figma_node(spec.get("request"), options)
            await settle()
        else:
            raise AssertionError("unsupported operation")
        output = _json_text(result)
        value = {"accepted": True, "outputText": output, "outputSha256": sha(output), "canonicalSha256": sha(canonical_json(result)),
                 "sameInput": result is original if operation.startswith("validate-") else None, "events": events}
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        value = {"accepted": False, "code": getattr(error, "code", type(error).__name__), "path": getattr(error, "path", None), "events": events}
    if json.dumps(spec, ensure_ascii=True) != before:
        raise AssertionError("input changed")
    return value


class FigmaImportTests(unittest.TestCase):
    def test_frozen_outcomes_and_transport_events(self):
        for entry in fixture()["cases"]:
            with self.subTest(case=entry["id"]):
                self.assertEqual(asyncio.run(run_case(entry)), entry["expected"])

    def test_default_standard_library_transport_pins_request_and_closes_response(self):
        vectors = fixture()
        response = io.BytesIO(json.dumps(vectors["response"], ensure_ascii=False, separators=(",", ":")).encode())
        response.status, response.headers = 200, {"content-type": "application/json"}
        url = "https://api.figma.com/v1/files/fixtureFile/nodes?ids=1%3A2&version=1001"
        response.geturl = lambda: url
        calls = []
        def opened(request, *, timeout):
            calls.append((request.full_url, request.method, request.get_header("Authorization"), timeout))
            return response
        with patch.object(figma_import.urllib.request, "build_opener", return_value=SimpleNamespace(open=opened)) as build:
            result = asyncio.run(import_figma_node(vectors["request"], {**vectors["options"], "now": lambda: vectors["retrievedAt"]}))
        self.assertEqual(result, vectors["result"])
        self.assertEqual(calls, [(url, "GET", "Bearer owned-synthetic-test-token", 30)])
        self.assertIsInstance(build.call_args.args[0], figma_import._NoRedirect)
        self.assertIsNone(build.call_args.args[0].redirect_request(None, None, 302, "", {}, "https://invalid.example.test"))
        self.assertTrue(response.closed)

    def test_host_objects_are_not_inspected_and_exception_details_do_not_escape(self):
        class Hostile:
            def __getattribute__(self, key):
                raise AssertionError("host property inspected")
        vectors = fixture()
        result = asyncio.run(import_figma_node(Hostile()))
        self.assertEqual(result["failure"]["code"], "FIGMA_IMPORT_REQUEST_INVALID")
        self.assertEqual(result["runId"], "invalid-run")
        async def failed(*_args):
            raise RuntimeError("OWNED_SECRET_MUST_NOT_ESCAPE")
        result = asyncio.run(import_figma_node(vectors["request"], {**vectors["options"], "fetchImpl": failed}))
        self.assertEqual(result["failure"]["code"], "FIGMA_IMPORT_FAILED")
        self.assertNotIn("OWNED_SECRET", json.dumps(result))

    def test_actual_stdio_bridge_uses_the_independent_acquisition(self):
        vectors = fixture()
        spec = {"options": vectors["options"], "body": json.dumps(vectors["response"]), "retrievedAt": vectors["retrievedAt"]}
        for source, valid in [(json.dumps(vectors["request"]).encode(), True), (b"{}", False), (b"{}\n{}", False)]:
            with self.subTest(source=source):
                options, _events, _settle = scripted_acquisition(spec)
                streams = {"stdin": io.BytesIO(source), "stdout": io.BytesIO(), "stderr": io.BytesIO()}
                result = asyncio.run(serve_figma_importer(options, streams))
                self.assertEqual(result["valid"], valid)
                if valid:
                    self.assertEqual(json.loads(streams["stdout"].getvalue()), vectors["result"])
                    self.assertEqual(streams["stderr"].getvalue(), b"")
                else:
                    self.assertEqual(streams["stdout"].getvalue(), b"")

    def test_typed_bytes_preserve_source_and_reject_other_values(self):
        vectors = fixture()
        data = json.dumps(vectors["response"], separators=(",", ":")).encode()
        for body in (data, bytearray(data), memoryview(data)):
            self.assertEqual(convert_figma_import_response(vectors["request"], body, vectors["retrievedAt"]), vectors["result"])
        with self.assertRaises(ValidationError) as caught:
            convert_figma_import_response(vectors["request"], list(data), vectors["retrievedAt"])
        self.assertEqual(caught.exception.code, "NETWORK_IMPORT_INPUT_INVALID")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--probes"]:
        print(json.dumps([asyncio.run(run_case(entry)) for entry in json.loads(sys.stdin.read())], ensure_ascii=True))
    elif sys.argv[1:2] == ["--replay"]:
        if "--isolated" in sys.argv and (shutil.which("node") is not None or shutil.which("git") is not None):
            raise AssertionError("isolated execution found Node or Git")
        vectors = fixture()
        print(json.dumps([{"id": entry["id"], "outcome": asyncio.run(run_case(entry))} for entry in vectors["cases"]], ensure_ascii=True))
    elif sys.argv[1:2] == ["--stdio-worker"]:
        import base64
        spec = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
        options, _events, _settle = scripted_acquisition(spec)
        sys.exit(asyncio.run(serve_figma_importer(options))["exitCode"])
    else:
        unittest.main()
