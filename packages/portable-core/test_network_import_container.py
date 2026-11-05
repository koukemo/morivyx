"""Replay frozen original acquisition, framing and engine outcomes offline."""

import asyncio
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import network_import_container as net
import plugin_container
from canonical import canonical_json
from figma_import import AbortSignal
from plugin_runtime import _json_text
from schema_validation import ValidationError

PIN = "152d6a27d5df5c0618e9f1630d522a2f0c8b4b36a32b8defcd3014762976b843"


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def fixture():
    raw = (Path(__file__).with_name("fixtures") / "network-import-container-vectors.json").read_bytes()
    assert sha(raw) == PIN
    return json.loads(raw)


def edit(value, changes=()):
    result = copy.deepcopy(value)
    for row in changes:
        parent = result
        for key in row["path"][:-1]:
            parent = parent[key]
        if row.get("remove"):
            parent.pop(row["path"][-1], None)
        else:
            parent[row["path"][-1]] = copy.deepcopy(row["value"])
    return result


def summary(raw):
    return {"bytes": len(raw), "sha256": sha(raw)}


def tree(root):
    result = {}

    def walk(path, prefix=""):
        for child in sorted(Path(path).iterdir(), key=lambda p: p.name):
            st, key = child.lstat(), prefix + child.name
            if stat.S_ISLNK(st.st_mode):
                result[key] = {"type": "symlink"}
            elif stat.S_ISDIR(st.st_mode):
                result[key] = {"type": "directory", "mode": stat.S_IMODE(st.st_mode)}
                walk(child, key + "/")
            else:
                result[key] = {"type": "file", "mode": stat.S_IMODE(st.st_mode), **summary(child.read_bytes())}
    walk(root)
    return result


def normalized(value, root, nonce, staging):
    if type(value) is str:
        value = value.replace(root, "ROOT")
        if nonce:
            value = value.replace(nonce, "NONCE")
        if staging:
            value = value.replace(staging, "STAGING")
        return value
    if type(value) is list:
        return [normalized(v, root, nonce, staging) for v in value]
    if type(value) is dict:
        return {normalized(k, root, nonce, staging): normalized(v, root, nonce, staging) for k, v in value.items()}
    return value


def diagnostic(error):
    out = {"kind": "throw", "name": "PackageError" if isinstance(error, ValidationError) else type(error).__name__}
    for key in ("code", "path", "details", "isolation"):
        if key in error.__dict__:
            out[key] = error.__dict__[key]
    return out


class HostError(Exception):
    pass


async def run_case(entry, vectors, controls=None):
    spec = json.loads(entry["inputText"])
    provider = spec.get("provider", "figma")
    original = vectors["providers"][provider]
    outer = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-network-case-"))
    product_root = os.path.join(outer, "product")
    os.mkdir(product_root)
    mask = os.umask(0o022)
    value = copy.deepcopy(spec["input"]) if "input" in spec else edit(original["input"], spec.get("inputEdits", []))
    if type(value) is dict and type(value.get("execution")) is dict and type(value["execution"].get("artifacts")) is dict:
        package = value["execution"]["artifacts"].get("package")
        if type(package) is list:
            value["execution"]["artifacts"]["package"] = bytearray(package)
    binding = edit(original["runtimeBinding"], spec.get("bindingEdits", []))
    engine_image = value.get("execution", {}).get("imageId") if type(value) is dict and type(value.get("execution")) is dict else None
    if spec.get("rebindManifest"):
        binding["manifestDigest"] = "sha256:" + sha(canonical_json(value["execution"]["manifest"]))
    controller, calls, fetches = AbortSignal(), [], []
    state = {"foreignCalls": 0, "cancels": 0, "releases": 0, "clock": 0, "staged": None,
             "nonce": None, "info": None, "removed": False}
    if controls is not None:
        controls["controller"] = controller
    if spec.get("artifactShape") == "shadow":
        class ShadowBytes(bytearray):
            def __len__(self):
                state["foreignCalls"] += 1
                raise AssertionError("foreign length")

            def __getitem__(self, key):
                state["foreignCalls"] += 1
                raise AssertionError("foreign indexing")

            def __bytes__(self):
                state["foreignCalls"] += 1
                raise AssertionError("foreign conversion")
        value["execution"]["artifacts"]["package"] = ShadowBytes(value["execution"]["artifacts"]["package"])
    documents = {r["path"]: r["text"] for r in original["responses"]}

    class ForeignRecord(dict):
        def __getitem__(self, key):
            state["foreignCalls"] += 1
            raise AssertionError("foreign record hook")

    def foreign(item, kind):
        return item if kind == "null-prototype" else ForeignRecord(item)

    async def fetch(url, settings):
        signal = settings["signal"]
        fetches.append({"url": url, "method": settings["method"], "redirect": settings["redirect"], "headers": settings["headers"],
                        "bodyPresent": "body" in settings, "signalPresent": isinstance(signal, AbortSignal), "signalAborted": signal.aborted})
        if spec.get("mutateAtFetch"):
            value["request"]["input"]["version"] = "changed"
            value["acquisition"]["credential"]["token"] = "changed"
            value["execution"]["policy"]["capability"]["permissions"]["network"].append("https://other.invalid")
            binding["imageId"] = "invalid"
        state["clock"] += spec.get("advanceMs", 0)
        if spec.get("abortPhase") == "fetch":
            controller.abort()
        if spec.get("fetchThrow"):
            error = HostError("HOST_ONLY_FIXTURE_CREDENTIAL")
            if spec.get("errorCodeAccessor"):
                class ForeignCode(HostError):
                    @property
                    def code(self):
                        state["foreignCalls"] += 1
                        raise AssertionError("foreign code")
                error = ForeignCode("owned")
            elif spec.get("errorCodeInherited"):
                class InheritedCode(HostError):
                    code = spec["fetchThrow"]
                error = InheritedCode("owned")
            else:
                error.code = spec["fetchThrow"]
            raise error
        path = url[len(f"https://api.{provider}.com"):]
        raw = spec.get("responseText", documents.get(path, "{}")).encode("utf-8")
        if "responseLength" in spec:
            raw = b"x" * spec["responseLength"]

        class Reader:
            offset, done = 0, False

            async def read(self):
                if spec.get("abortPhase") == "read":
                    controller.abort()
                if spec.get("stream") == "throw":
                    raise HostError("HOST_ONLY_FIXTURE_CREDENTIAL")
                if spec.get("stream") == "hang":
                    state["finishRead"] = asyncio.get_running_loop().create_future()
                    return await state["finishRead"]
                if spec.get("chunkShape") and not self.done:
                    self.done = True
                    return {"done": False, "value": []}
                if self.offset >= len(raw):
                    return {"done": True}
                count = min(spec.get("chunkBytes", len(raw)), len(raw) - self.offset)
                chunk = raw[self.offset:self.offset + count]
                self.offset += count
                return {"done": False, "value": chunk}

            async def cancel(self):
                state["cancels"] += 1
                future = state.get("finishRead")
                if future is not None and not future.done():
                    future.set_result({"done": True})

            def release_lock(self):
                state["releases"] += 1
                if spec.get("releaseThrow"):
                    raise HostError("owned release failure")
        reader = Reader()

        async def body_cancel():
            state["cancels"] += 1
        headers = {"content-type": "application/json", **spec.get("headers", {})}
        return SimpleNamespace(status=spec.get("status", 200), redirected=spec.get("redirected", False),
            url=spec.get("responseUrl", ""), headers=SimpleNamespace(get=lambda k: headers.get(k)),
            body=None if spec.get("nullBody") else SimpleNamespace(get_reader=lambda: reader, cancel=body_cancel))

    async def transport(args, settings):
        assert 0 < settings["timeoutMs"] <= 30000
        signal = settings.get("signal")
        recorded = {"timeoutMs": settings["timeoutMs"], "maxOutputBytes": settings["maxOutputBytes"],
                    "signalPresent": "signal" in settings, "signalAborted": signal.aborted if signal is not None else None}
        if "input" in settings:
            recorded.update(inputBytes=len(settings["input"].encode("utf-8")), inputSha256=sha(settings["input"]))
        calls.append({"args": copy.deepcopy(args), "settings": recorded})
        if args[1] == "create":
            state["staged"] = re.search(r"source=([^,]+)", args[args.index("--mount") + 1])[1]
            state["nonce"] = args[args.index("--label") + 1].split("=")[1]
        if spec.get("abortPhase") in args[:2]:
            controller.abort()
        if spec.get("throwPhase") in args[:2]:
            error = HostError("HOST_ONLY_FIXTURE_CREDENTIAL")
            error.code = spec.get("throwCode", "OWNED_FAILURE")
            raise error
        if args[0] == "info":
            return spec.get("infoResponse", {"code": 0, "stdout": _json_text(vectors["server"])})
        if args[0] == "image":
            return {"code": 0, "stdout": engine_image}
        if args[1] == "create":
            flag = lambda k: args[args.index(k) + 1]
            state["info"] = {"Id": vectors["containerId"], "Image": engine_image,
                "Config": {"Labels": {"morivyx.run": state["nonce"]}, "User": "65534:65534", "WorkingDir": "/input"},
                "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False, "CapDrop": ["ALL"], "CapAdd": None,
                    "SecurityOpt": ["no-new-privileges=true"], "Memory": int(flag("--memory")), "MemorySwap": int(flag("--memory-swap")),
                    "PidsLimit": 32, "NanoCpus": 1000000000, "LogConfig": {"Type": "none"}, "PidMode": "", "IpcMode": "none", "CgroupnsMode": "private"},
                "Mounts": [{"Type": "bind", "Source": state["staged"], "Destination": "/input", "RW": False}]}
            state["stagedFiles"] = tree(state["staged"])
            return spec.get("createResponse", {"code": 0, "stdout": vectors["containerId"]})
        if args[1] == "inspect":
            return {"code": 0, "stdout": _json_text([edit(state["info"], spec.get("inspectEdits", []))])}
        if args[1] == "ls":
            return {"code": 0, "stdout": vectors["containerId"] if state["info"] else ""}
        if args[1] == "start":
            if controls is not None:
                controls["started"].set()
                await controls["resume"].wait()
            root = Path(state["staged"])
            if spec.get("stagedChange") == "extra":
                (root / "extra").write_text("unlisted")
            if spec.get("stagedChange") == "bytes":
                (root / "response-0-0.bin").write_text("tampered")
            if spec.get("stagedChange") == "symlink":
                (root / "response-0-0.bin").unlink()
                (root / "response-0-0.bin").symlink_to("network-input.json")
            try:
                result = await net._convert_network_import_input(json.loads(settings["input"]), state["staged"])
                result = edit(result, spec.get("resultEdits", []))
                return spec.get("startResponse", {"code": 0, "stdout": _json_text(result)})
            except Exception as error:
                state["workerFailure"] = diagnostic(error)
                return {"code": 1, "stdout": ""}
        if args[1] == "rm":
            if controls is not None:
                controls["cleanupStarted"].set()
                await controls["cleanupResume"].wait()
            state["removed"] = not spec.get("failCleanup", False)
            return {"code": 0 if state["removed"] else 1, "stdout": vectors["containerId"]}
        raise AssertionError("unexpected owned engine operation")

    try:
        with patch.object(tempfile, "tempdir", product_root), patch.object(net, "_now_ms", lambda: state["clock"]), \
             patch.object(net, "_now", lambda: vectors["time"]), \
             patch.object(plugin_container, "time", SimpleNamespace(monotonic=lambda: state["clock"] / 1000)):
            operation = spec.get("operation")
            if operation in ("pack", "read", "convert"):
                rows = [{"path": row["path"], "bytes": b"x" * row["length"] if "length" in row else row.get("text", "").encode("utf-8")}
                        for row in spec.get("responses", original["responses"])]
                if spec.get("responseForeign"):
                    rows[0] = ForeignRecord(rows[0])
                try:
                    packed = net._pack_network_import_input(value["request"], rows, spec.get("time", vectors["time"]))
                    if operation == "pack":
                        result = {"inputDigest": packed["inputDigest"], "files": [{"path": f["path"], "permission": f["permission"],
                            **summary(f["bytes"]), **({"text": f["bytes"].decode()} if f["path"] == "network-input.json" else {})} for f in packed["files"]]}
                    else:
                        root = Path(outer) / "input"
                        root.mkdir()
                        for f in packed["files"]:
                            (root / f["path"]).write_bytes(f["bytes"])
                        if spec.get("readChange") == "extra":
                            (root / "extra").write_text("extra")
                        if spec.get("readChange") == "bytes":
                            (root / "response-0-0.bin").write_text("tampered")
                        if spec.get("readChange") == "symlink":
                            (root / "response-0-0.bin").unlink()
                            (root / "response-0-0.bin").symlink_to("network-input.json")
                        if spec.get("indexEdits"):
                            index = json.loads((root / "network-input.json").read_bytes())
                            (root / "network-input.json").write_text(_json_text(edit(index, spec["indexEdits"])))
                        if operation == "convert":
                            result = await net._convert_network_import_input(value["request"], str(root))
                        else:
                            result = await net._read_network_import_input(value["request"], str(root))
                            result["responses"] = [{"path": r["path"], **summary(r["bytes"])} for r in result["responses"]]
                    outcome = {"kind": "return", "value": result}
                except Exception as error:
                    outcome = diagnostic(error)
                return {**outcome, "foreignCalls": state["foreignCalls"]}
            if spec.get("foreign"):
                value = foreign(value, spec["foreign"])
            options = copy.deepcopy(spec["options"]) if "options" in spec else {"runtimeBinding": binding}
            options = edit(options, spec.get("optionEdits", []))
            if type(options) is dict:
                if not spec.get("builtinFetch"):
                    options.setdefault("fetchImpl", fetch)
                options.setdefault("transport", transport)
                options.setdefault("now", lambda: spec.get("time", vectors["time"]))
                if spec.get("abortPhase") or spec.get("stream") == "hang":
                    options["signal"] = controller
                if spec.get("optionForeign"):
                    options = foreign(options, spec["optionForeign"])
            if spec.get("abortPhase") == "before":
                controller.abort()
            before_input = None if spec.get("foreign") else copy.deepcopy(value)
            before = tree(product_root)
            try:
                pending = net.run_network_import_container(value, options)
                if spec.get("mutateAfterCall"):
                    value["request"]["input"]["version"] = "changed"
                    value["acquisition"]["credential"]["token"] = "changed"
                    value["execution"]["artifacts"]["package"][:] = b"\0" * len(value["execution"]["artifacts"]["package"])
                    value["execution"]["imageId"] = "invalid"
                    binding["imageId"] = "invalid"
                    def replaced(*_args):
                        raise HostError("replaced host adapter")
                    options.update(fetchImpl=replaced, transport=replaced, now=lambda: "invalid")
                outcome = {"kind": "return", "value": await pending}
            except Exception as error:
                outcome = diagnostic(error)
            # Best-effort cancellation microtasks are part of the observed settlement.
            await asyncio.sleep(0)
            after = tree(product_root)
            staging = os.path.basename(os.path.dirname(state["staged"])) if state["staged"] else None
            return normalized({**outcome, "inputUnchanged": None if spec.get("foreign") else value == before_input,
                "foreignCalls": state["foreignCalls"], "fetches": fetches, "calls": calls, "cancels": state["cancels"],
                "releases": state["releases"], "listeners": len(controller._listeners), "stagedFiles": state.get("stagedFiles"),
                "workerFailure": state.get("workerFailure"), "removed": state["removed"], "before": before, "after": after},
                outer, state["nonce"], staging)
    finally:
        os.umask(mask)
        shutil.rmtree(outer)


async def replay(entries, vectors):
    return [{"id": e["id"], "outcome": await run_case(e, vectors)} for e in entries]


class NetworkContainerTests(unittest.TestCase):
    def test_original_inputs_outputs_and_digests(self):
        vectors = fixture()
        self.assertEqual(vectors["count"], 554)
        for entry in vectors["cases"]:
            self.assertEqual(sha(entry["inputText"]), entry["inputSha256"])
            self.assertEqual(sha(_json_text(entry["expected"])), entry["outputSha256"])

    def test_every_original_outcome(self):
        vectors = fixture()
        rows = asyncio.run(replay(vectors["cases"], vectors))
        for row, entry in zip(rows, vectors["cases"]):
            with self.subTest(case=entry["id"]):
                self.assertEqual(row["outcome"], entry["expected"])

    def test_owned_local_connection_full_exchange_and_short_read(self):
        vectors = fixture()
        observed, factories = [], []
        document = vectors["providers"]["figma"]["responses"][0]["text"].encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append({"path": self.path, "connection": self.headers.get("Connection"),
                                 "authorization": self.headers.get("Authorization")})
                raw = b"{}" if self.path == "/short" else document
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw) + (1 if self.path == "/short" else 0)))
                self.end_headers()
                self.wfile.write(raw)
                self.close_connection = True

            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection_class = net.http.client.HTTPConnection

        def connection(host, port=None, timeout=None):
            factories.append({"host": host, "port": port, "timeout": timeout})
            self.assertEqual(host, "api.figma.com")
            return connection_class("127.0.0.1", server.server_port, timeout=timeout)

        async def scenario():
            with patch.object(net.http.client, "HTTPSConnection", connection), patch.dict(os.environ,
                    {"HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1"}):
                row = {"id": "owned/full", "inputText": '{"builtinFetch":true}'}
                outcome = await run_case(row, vectors)
                self.assertEqual(outcome["kind"], "return")
                self.assertTrue(outcome["removed"])
                self.assertEqual(outcome["after"], {})
                self.assertEqual(outcome["value"], vectors["cases"][0]["expected"]["value"])
                # Each transport owns only its connections. Closing one leaves the other usable.
                first, second = net._OwnedTransport(1000), net._OwnedTransport(1000)
                settings = {"method": "GET", "redirect": "manual", "headers": {}, "signal": AbortSignal()}
                a = await first.fetch("https://api.figma.com/short", settings)
                b = await second.fetch("https://api.figma.com/ok", settings)
                reader = a.body.get_reader()
                self.assertEqual((await reader.read())["value"], b"{}")
                with self.assertRaises(OSError):
                    await reader.read()
                tasks = set(first.tasks) | set(second.tasks)
                await first.close()
                self.assertEqual((await b.body.get_reader().read())["value"], document)
                await second.close()
                self.assertTrue(all(t.done() for t in tasks))
                self.assertEqual(first.connections, {})
                self.assertEqual(second.connections, {})
                with self.assertRaises(net.NetworkImportError):
                    await first.fetch("https://api.figma.com/ok", settings)
        try:
            asyncio.run(scenario())
            self.assertEqual(len(observed), 3)
            self.assertTrue(all(x["connection"].lower() == "close" for x in observed))
            self.assertEqual(observed[0]["authorization"], "Bearer HOST_ONLY_FIXTURE_CREDENTIAL")
            self.assertEqual(len(factories), 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_caller_and_host_options_are_captured_before_await(self):
        vectors = fixture()
        for provider in ("figma", "github"):
            with self.subTest(provider=provider):
                entry = {"id": "owned/capture", "inputText": _json_text({"provider": provider, "mutateAfterCall": True})}
                result = asyncio.run(run_case(entry, vectors))
                expected = next(e["expected"] for e in vectors["cases"] if e["id"] == "valid/" + provider)
                self.assertEqual(result, {**expected, "inputUnchanged": False})

    def test_late_fetch_after_abort_discards_body_without_starting_engine(self):
        vectors = fixture()

        async def scenario():
            value = copy.deepcopy(vectors["providers"]["figma"]["input"])
            value["execution"]["artifacts"]["package"] = bytearray(value["execution"]["artifacts"]["package"])
            controller = AbortSignal()
            started, discarded = asyncio.Event(), asyncio.Event()
            response = asyncio.get_running_loop().create_future()
            calls = []

            async def fetch(_url, _settings):
                started.set()
                return await response

            async def cancel():
                discarded.set()

            async def transport(*args):
                calls.append(args)
                raise AssertionError("engine must not start")
            pending = asyncio.create_task(net.run_network_import_container(value, {
                "runtimeBinding": vectors["providers"]["figma"]["runtimeBinding"], "fetchImpl": fetch,
                "transport": transport, "signal": controller}))
            await asyncio.wait_for(started.wait(), 1)
            controller.abort()
            with self.assertRaises(net.NetworkImportError) as failure:
                await asyncio.wait_for(pending, 1)
            self.assertEqual(failure.exception.code, "NETWORK_IMPORT_CANCELLED")
            self.assertFalse(discarded.is_set())
            response.set_result(SimpleNamespace(body=SimpleNamespace(cancel=cancel)))
            await asyncio.wait_for(discarded.wait(), 1)
            self.assertEqual(calls, [])
            self.assertEqual(controller._listeners, [])
        asyncio.run(scenario())

    def test_cancellation_waits_for_engine_and_ownership_cleanup(self):
        vectors = fixture()

        async def scenario():
            controls = {k: asyncio.Event() for k in ("started", "resume", "cleanupStarted", "cleanupResume")}
            pending = asyncio.create_task(run_case({"id": "owned/wait", "inputText": '{"abortPhase":"manual"}'}, vectors, controls))
            await asyncio.wait_for(controls["started"].wait(), 1)
            controls["controller"].abort()
            await asyncio.sleep(0)
            self.assertFalse(pending.done())
            controls["resume"].set()
            await asyncio.wait_for(controls["cleanupStarted"].wait(), 1)
            self.assertFalse(pending.done())
            controls["cleanupResume"].set()
            result = await asyncio.wait_for(pending, 1)
            self.assertEqual(result["code"], "NETWORK_IMPORT_CANCELLED")
            self.assertTrue(result["removed"])
            self.assertEqual(result["after"], {})
        asyncio.run(scenario())

    def test_owned_pending_body_close_unblocks_only_owned_socket(self):
        started, finish = threading.Event(), threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", "10")
                self.end_headers()
                self.wfile.write(b"{")
                self.wfile.flush()
                started.set()
                finish.wait(3)

            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection_class = net.http.client.HTTPConnection

        async def scenario():
            with patch.object(net.http.client, "HTTPSConnection", lambda *_args, **kwargs:
                              connection_class("127.0.0.1", server.server_port, timeout=kwargs["timeout"])):
                owned = net._OwnedTransport(1000)
                response = await owned.fetch("https://api.figma.com/owned", {"method": "GET", "redirect": "manual",
                                                                           "headers": {}, "signal": AbortSignal()})
                self.assertTrue(started.is_set())
                pending = asyncio.create_task(response.body.get_reader().read())
                await asyncio.sleep(0.02)
                await asyncio.wait_for(owned.close(), 1)
                self.assertTrue(pending.done())
                try:
                    await pending
                except (OSError, ValueError):
                    pass
                self.assertFalse(owned.connections)
        try:
            asyncio.run(scenario())
        finally:
            finish.set()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    if "--probes" in sys.argv:
        vectors = fixture()
        print(_json_text(asyncio.run(replay(json.loads(sys.stdin.read()), vectors))))
    elif "--replay" in sys.argv:
        vectors = fixture()
        print(_json_text(asyncio.run(replay(vectors["cases"], vectors))))
    else:
        unittest.main()
