"""Replay original container outcomes without Node or a container daemon."""

import asyncio
import copy
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

from plugin_container import PLUGIN_CONTAINER_LIMITS, PluginIsolationError, run_plugin_container
from figma_import import AbortSignal
from plugin_runtime import _json_text
from schema_validation import ValidationError

PIN = "951401aacb717e69f1d33209f649e42c4b61076163e0c8ea871cb9f8d006de3e"


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def fixture():
    raw = (Path(__file__).with_name("fixtures") / "plugin-container-vectors.json").read_bytes()
    assert sha(raw) == PIN
    return json.loads(raw)


def edit(value, changes=()):
    result = copy.deepcopy(value)
    for entry in changes:
        parent = result
        for key in entry["path"][:-1]:
            parent = parent[key]
        key = entry["path"][-1]
        if entry.get("remove"):
            del parent[key]
        else:
            parent[key] = copy.deepcopy(entry["value"])
    return result


def tree(root):
    result = {}

    def walk(path, prefix=""):
        for child in sorted(Path(path).iterdir(), key=lambda p: p.name):
            info, key = child.lstat(), prefix + child.name
            assert not stat.S_ISLNK(info.st_mode)
            if stat.S_ISDIR(info.st_mode):
                result[key] = {"type": "directory", "mode": stat.S_IMODE(info.st_mode)}
                walk(child, key + "/")
            else:
                result[key] = {"type": "file", "mode": stat.S_IMODE(info.st_mode), "bytes": info.st_size, "sha256": sha(child.read_bytes())}
    walk(root)
    return result


def normalized(value, root, nonce, staging):
    if type(value) is str:
        value = value.replace(root, "ROOT")
        if staging:
            value = value.replace(staging, "STAGING")
        if nonce:
            value = value.replace(nonce, "NONCE")
        return value
    if type(value) is list:
        return [normalized(item, root, nonce, staging) for item in value]
    if type(value) is dict:
        return {normalized(key, root, nonce, staging): normalized(item, root, nonce, staging) for key, item in value.items()}
    return value


def snapshot(value):
    if type(value) is dict:
        return {key: snapshot(item) for key, item in value.items()}
    if type(value) is list:
        return [snapshot(item) for item in value]
    if type(value) in (str, int, float, bool, type(None)):
        return value
    ancestry = type.__dict__["__mro__"].__get__(type(value), type(type(value)))
    if any(base is bytearray for base in ancestry):
        return {"bytes": sha(bytes(bytearray.__getitem__(value, slice(None))))}
    if type(value) is bytes:
        return {"bytes": sha(value)}
    if type(value) is memoryview:
        try:
            return {"view": sha(value.tobytes())}
        except ValueError:
            return {"view": "released"}
    return {"foreign": type(value).__name__}


class HostError(Exception):
    pass


async def run_case(entry, vectors):
    spec = json.loads(entry["inputText"])
    outer = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-container-case-"))
    product_root = os.path.join(outer, "product")
    os.mkdir(product_root)
    mask = os.umask(spec.get("umask", 0o022))
    value = copy.deepcopy(spec["input"] if "input" in spec else vectors["input"])
    if "input" not in spec:
        for item in value["files"]:
            item["bytes"] = bytearray(item["bytes"])
    value = edit(value, spec.get("inputEdits", []))
    options = copy.deepcopy(spec.get("options", {}))
    controller, calls, raw_timings = AbortSignal(), [], []
    state = {"inspections": 0, "finished": False, "removed": False, "foreignCalls": 0, "info": None, "nonce": None, "staged": None}
    policy = value.get("policy") if type(value) is dict else None
    capability = policy.get("capability") if type(policy) is dict else None
    resources = capability.get("resources") if type(capability) is dict else None
    timeout = resources.get("timeoutMs") if type(resources) is dict else None
    state["grantTimeout"] = min(timeout if type(timeout) in (int, float) else 5000, 30000)
    result = edit(vectors["receipt"]["result"], spec.get("resultEdits", []))

    async def transport(args, settings):
        if args[1] == "ls":
            state["finished"] = True
        if args[:2] == ["container", "inspect"]:
            if state["inspections"] > 0:
                state["finished"] = True
            state["inspections"] += 1
        cleanup = state["finished"] or args[:2] == ["container", "rm"]
        maximum = 5000 if cleanup else state["grantTimeout"] if args[1] == "start" else min(5000, state["grantTimeout"])
        raw_timings.append({"timeoutMs": settings["timeoutMs"], "maximum": maximum})
        assert 0 < settings["timeoutMs"] <= maximum
        signal = settings.get("signal")
        recorded = {"timeout": settings["timeoutMs"] if cleanup else "positive-within-bound", "maxOutputBytes": settings["maxOutputBytes"],
                    "signalPresent": "signal" in settings, "signalAborted": signal.aborted if signal is not None else None}
        if "input" in settings:
            recorded.update(inputBytes=len(settings["input"].encode("utf-8")), inputSha256=sha(settings["input"]))
        calls.append({"args": copy.deepcopy(args), "settings": recorded})
        if spec.get("abortPhase") in args[:2]:
            controller.abort()
        if args[0] == "info":
            return copy.deepcopy(spec["serverResponse"]) if "serverResponse" in spec else {"code": 0, "stdout": _json_text(edit(vectors["server"], spec.get("serverEdits", [])))}
        if args[0] == "image":
            return copy.deepcopy(spec["imageResponse"]) if "imageResponse" in spec else {"code": 0, "stdout": value["imageId"]}
        if args[1] == "create":
            def flag(key):
                return args[args.index(key) + 1]
            state["staged"] = re.search(r"source=([^,]+)", flag("--mount"))[1]
            state["nonce"] = flag("--label").split("=")[1]
            state["info"] = {"Id": vectors["receipt"]["isolation"]["containerId"], "Image": value["imageId"],
                "Config": {"Labels": {"morivyx.run": state["nonce"]}, "User": "65534:65534", "WorkingDir": "/input"},
                "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False, "CapDrop": ["ALL"], "CapAdd": None,
                    "SecurityOpt": ["no-new-privileges=true"], "Memory": int(flag("--memory")), "MemorySwap": int(flag("--memory-swap")),
                    "PidsLimit": 32, "NanoCpus": 1000000000, "LogConfig": {"Type": "none"}, "PidMode": "", "IpcMode": "none", "CgroupnsMode": "private"},
                "Mounts": [{"Type": "bind", "Source": state["staged"], "Destination": "/input", "RW": False}]}
            state["stagedFiles"] = tree(state["staged"])
            if controller.aborted:
                state["finished"] = True
            if spec.get("throwPhase") == "create":
                state["finished"] = True
                error = HostError("owned transport failure")
                error.code = spec.get("throwCode", "OWNED_FAILURE")
                raise error
            return copy.deepcopy(spec["createResponse"]) if "createResponse" in spec else {"code": 0, "stdout": state["info"]["Id"]}
        if args[1] == "inspect":
            return copy.deepcopy(spec["inspectResponse"]) if "inspectResponse" in spec else {"code": 0, "stdout": _json_text([edit(state["info"], spec.get("infoEdits", []))])}
        if args[1] == "ls":
            return copy.deepcopy(spec["listResponse"]) if "listResponse" in spec else {"code": 0, "stdout": vectors["receipt"]["isolation"]["containerId"] if state["info"] else ""}
        if args[1] == "start":
            state["finished"] = True
            if spec.get("throwPhase") == "start":
                error = HostError("owned transport failure")
                error.code = spec.get("throwCode", "OWNED_FAILURE")
                raise error
            return copy.deepcopy(spec["startResponse"]) if "startResponse" in spec else {"code": 0, "stdout": _json_text(result)}
        if args[1] == "rm":
            output = copy.deepcopy(spec["removeResponse"]) if "removeResponse" in spec else {"code": 0, "stdout": state["info"]["Id"]}
            state["removed"] = type(output) is dict and type(output.get("code")) in (int, float) and output["code"] == 0
            return output
        raise AssertionError("unexpected owned transport operation")

    class ForeignRecord(dict):
        def __getitem__(self, key):
            state["foreignCalls"] += 1
            raise AssertionError("foreign record hook")

    class ForeignList(list):
        def __getitem__(self, key):
            state["foreignCalls"] += 1
            raise AssertionError("foreign list hook")

    class ShadowBytes(bytearray):
        def __len__(self):
            state["foreignCalls"] += 1
            raise AssertionError("foreign length hook")

        def __getitem__(self, key):
            state["foreignCalls"] += 1
            raise AssertionError("foreign item hook")

        def __bytes__(self):
            state["foreignCalls"] += 1
            raise AssertionError("foreign conversion hook")

    timer, shared = None, None
    try:
        if "requestPadding" in spec:
            value["request"]["input"]["padding"] = "x" * spec["requestPadding"]
        if "fileBytesLength" in spec:
            value["files"][0]["bytes"] = bytearray(b"x" * spec["fileBytesLength"])
        if "fileCount" in spec:
            value["files"] = [{**value["files"][0], "path": str(i) + ".txt"} for i in range(spec["fileCount"])]
        if "filePaths" in spec:
            value["files"] = [{**value["files"][0], "path": path} for path in spec["filePaths"]]
        shape = spec.get("byteShape")
        if shape == "view":
            value["files"][0]["bytes"] = memoryview(b"\0source\n\0")[1:8]
        elif shape == "buffer":
            value["files"][0]["bytes"] = b"source\n"
        elif shape in ("dataview", "clamped"):
            value["files"][0]["bytes"] = memoryview(b"x").cast("b")
        elif shape == "shared":
            shared = mmap.mmap(-1, 1)
            value["files"][0]["bytes"] = memoryview(shared)
        elif shape == "detached":
            released = memoryview(b"x")
            released.release()
            value["files"][0]["bytes"] = released
        elif shape == "shadow-getters":
            value["files"][0]["bytes"] = ShadowBytes(value["files"][0]["bytes"])
        foreign = spec.get("foreign")
        if foreign in ("input-proxy", "input-accessor"):
            value = ForeignRecord(value)
        elif foreign == "file-accessor":
            value["files"][0] = ForeignRecord(value["files"][0])
        elif foreign in ("file-list-accessor", "sparse-files"):
            value["files"] = ForeignList(value["files"])
        if type(options) is dict:
            if spec.get("nativeScenario"):
                scenario = spec["nativeScenario"]
                scripts = {"invalid": "printf 'not-json'", "utf8": "printf '\\377'", "output": "i=0; while [ \"$i\" -lt 3000 ]; do printf '%0100d' 0; i=$((i+1)); done",
                           "timeout": "while :; do :; done", "cancel": "while :; do :; done"}
                helper = Path(outer) / "owned-engine"
                helper.write_text("#!/bin/sh\n" + scripts[scenario] + "\n", encoding="utf-8")
                helper.chmod(0o755)
                options["dockerPath"] = str(helper)
                if scenario == "cancel":
                    options["signal"] = controller
                    timer = asyncio.get_running_loop().call_later(0.1, controller.abort)
            elif "transport" not in options:
                options["transport"] = transport
            if spec.get("abortPhase"):
                options["signal"] = controller
            if spec.get("abortPhase") == "before":
                controller.abort()
        if foreign == "options-accessor":
            options = ForeignRecord(options)
        before_input, before = snapshot(value), tree(product_root)
        try:
            with patch.object(tempfile, "tempdir", product_root):
                pending = run_plugin_container(value, options)
                if spec.get("mutateAfterCall"):
                    value["request"]["runId"] = "changed"
                    value["files"][0]["bytes"][:] = bytes(len(value["files"][0]["bytes"]))
                    value["files"][0]["path"] = "changed"
                    value["policy"]["capability"]["resources"]["maxOutputBytes"] = 1
                if spec.get("mutateOptionsAfterCall"):
                    options.update(transport=lambda *_: None, dockerPath="relative", signal={})
                outcome = {"kind": "return", "value": await pending}
        except Exception as error:
            state["finished"] = True
            name = "PackageError" if isinstance(error, ValidationError) else "TypeError" if isinstance(error, TypeError) else "Error"
            outcome = {"kind": "throw", "name": name}
            for key in ("code", "path", "details", "isolation"):
                if key in vars(error):
                    outcome[key] = vars(error)[key]
        after = tree(product_root)
        assert all(0 < item["timeoutMs"] <= item["maximum"] for item in raw_timings), entry["id"]
        staging = os.path.basename(os.path.dirname(state["staged"])) if state["staged"] else None
        if not staging and type(outcome.get("path")) is str and outcome["path"].startswith(product_root + "/"):
            staging = outcome["path"][len(product_root) + 1:].split("/")[0]
        # Native failures and cleanup failures may have no reported source mount.
        if not staging and after:
            staging = next(iter(after)).split("/")[0]
        outcome.update(inputUnchanged=snapshot(value) == before_input, foreignCalls=state["foreignCalls"], calls=calls,
                       stagedFiles=state.get("stagedFiles"), removed=state["removed"], before=before, after=after)
        return normalized(outcome, outer, state["nonce"], staging)
    finally:
        if timer:
            timer.cancel()
        if shared is not None:
            value["files"][0]["bytes"].release()
            shared.close()
        os.umask(mask)
        shutil.rmtree(outer)


class ContainerTests(unittest.TestCase):
    def test_frozen_input_and_output_digests(self):
        vectors = fixture()
        self.assertEqual(vectors["count"], 652)
        self.assertEqual(len(vectors["cases"]), 652)
        for entry in vectors["cases"]:
            self.assertEqual(sha(entry["inputText"]), entry["inputSha256"])
            self.assertEqual(sha(_json_text(entry["expected"])), entry["outputSha256"])

    def test_every_frozen_outcome(self):
        vectors = fixture()

        async def run():
            for entry in vectors["cases"]:
                with self.subTest(case=entry["id"]):
                    self.assertEqual(await run_case(entry, vectors), entry["expected"])
        asyncio.run(run())

    def test_limits_are_immutable(self):
        with self.assertRaises(TypeError):
            PLUGIN_CONTAINER_LIMITS["pids"] = 0


if __name__ == "__main__":
    if "--replay" in sys.argv or "--probes" in sys.argv:
        vectors = fixture()
        entries = json.load(sys.stdin) if "--probes" in sys.argv else vectors["cases"]

        async def replay():
            return [{"id": entry["id"], "outcome": await run_case(entry, vectors)} for entry in entries]
        print(json.dumps(asyncio.run(replay()), ensure_ascii=True, separators=(",", ":")))
    else:
        unittest.main()
