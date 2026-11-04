"""Test-only stdlib driver; independently frozen Node outcomes remain the oracle."""

import asyncio
import base64
import copy
import hashlib
import io
import json
import re
import sys


def edited(value, edits):
    for edit in edits:
        if not edit["path"]:
            value = copy.deepcopy(edit["value"])
            continue
        owner = value
        for key in edit["path"][:-1]:
            owner = owner[key]
        key = edit["path"][-1]
        if edit.get("delete"):
            del owner[key]
        elif type(owner) is list and key == len(owner):
            owner.append(copy.deepcopy(edit["value"]))
        else:
            owner[key] = copy.deepcopy(edit["value"])
    return value


def wire(value):
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return re.sub(r"[\ud800-\udfff]", lambda m: "\\u" + format(ord(m[0]), "04x"), text)


def values(vectors, entry):
    value = copy.deepcopy(vectors["templates"])
    if "messageSpec" in entry:
        spec = entry["messageSpec"]
        value = edited(copy.deepcopy(vectors["messageTemplates"][spec["template"]]), spec["edits"])
    if entry.get("inputDepth"):
        deep = 0
        for _ in range(entry["inputDepth"]):
            deep = [deep]
        value["request"]["input"] = {"deep": deep}
    if "inputText" in entry:
        source = entry["inputText"].encode()
    elif "inputBase64" in entry:
        source = base64.b64decode(entry["inputBase64"])
    elif "inputLength" in entry:
        source = bytes([entry["repeatByte"]]) * entry["inputLength"]
    else:
        source = (entry.get("padding", "") + (wire(value["request"]) if "request" in value else "undefined") + "\n" + entry.get("padding", "")).encode()
    return value, source


class Input(io.BytesIO):
    def __init__(self, source, entry):
        super().__init__(source)
        self.entry = entry
        self.read_calls = 0

    def read(self, size=-1):
        self.read_calls += 1
        mode = self.entry.get("readMode")
        if mode == "error":
            raise OSError("INPUT_SENTINEL")
        if mode == "number":
            return 123
        if mode == "object":
            return {}
        return super().read(min(size, self.entry.get("chunkSize", size)))


class Sink(io.RawIOBase):
    def __init__(self, mode=None):
        self.data = bytearray()
        self.mode = mode
        self.writes = 0

    def write(self, data):
        self.writes += 1
        if self.mode in ("error", "throw", "closed", "broken"):
            raise OSError("INPUT_SENTINEL")
        if self.mode == "partial-failure":
            if self.writes > 1:
                raise OSError("INPUT_SENTINEL")
            self.data.extend(data[:3])
            return 3
        self.data.extend(data)
        return len(data)


async def run_case(vectors, entry):
    from plugin_stdio import serve_plugin_stdio

    value, source = values(vectors, entry)
    mutable = copy.deepcopy(value.get("result"))
    calls = []

    def callback(mode, current):
        if mode == "false":
            return False
        if mode == "throw":
            raise RuntimeError("INPUT_SENTINEL")
        if mode == "zero":
            return 0
        if mode == "empty-string":
            return ""
        if mode == "mutate":
            current["runId"] = "changed"
        return None

    async def validate_request(current):
        calls.append("validateRequest")
        await asyncio.sleep(0)
        return callback(entry.get("validateRequest"), current)

    async def handle(current):
        calls.append("handleRequest")
        await asyncio.sleep(0)
        mode = entry.get("handler")
        if mode == "throw":
            raise RuntimeError("INPUT_SENTINEL")
        if mode == "empty":
            return {}
        if mode == "cycle":
            result = copy.deepcopy(mutable)
            result["output"]["self"] = result
            return result
        if mode == "mutate-input":
            current["runId"] = "changed"
        if mode == "mutate-identity":
            return {**mutable, "runId": "changed"}
        if mode == "failure":
            result = {**mutable, "status": "failure", "failure": {"code": "EXAMPLE_FAILURE", "message": "synthetic failure"}}
            del result["output"]
            return result
        if mode == "unicode":
            return {**mutable, "output": {"text": "e\u0301 / 日本語 / 2024-01-01T00:00:00+00:00"}}
        if mode == "large-output":
            return {**mutable, "output": {"text": "x" * 1048576}}
        if mode == "deep-output":
            deep = 0
            for _ in range(600):
                deep = [deep]
            return {**mutable, "output": {"deep": deep}}
        return mutable

    async def validate_result(current, sent):
        calls.append("validateResult")
        if entry.get("validateResult") == "mutate-external":
            mutable["runId"] = "changed"
        if entry.get("validateResult") == "mutate":
            sent["runId"] = "changed"
        await asyncio.sleep(0)
        return callback(entry.get("validateResult"), current)

    options = {"handleRequest": handle, "validateRequest": validate_request, "validateResult": validate_result, **entry.get("limits", {})}
    if entry.get("badCallback"):
        options[entry["badCallback"]] = None
    stdin = Input(source, entry)
    stdout, stderr = Sink(entry.get("writeMode")), Sink(entry.get("diagnosticMode"))
    streams = {"stdin": stdin, "stdout": stdout, "stderr": stderr}
    if entry.get("badStream"):
        streams[entry["badStream"]] = {}
    status = await serve_plugin_stdio(options, streams)
    return {"status": status, "stdoutSha256": hashlib.sha256(stdout.data).hexdigest(), "stdoutBytes": len(stdout.data),
            "stderr": stderr.data.decode(), "calls": calls}


async def main():
    sys.path.insert(0, sys.argv[1])
    vectors = json.load(sys.stdin)
    results = [await run_case(vectors, entry) for entry in vectors["cases"]]
    print(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    asyncio.run(main())
