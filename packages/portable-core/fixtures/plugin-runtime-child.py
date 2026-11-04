"""Synthetic, standard-library-only child for transport tests, not a plugin."""

import base64
import json
import os
from pathlib import Path
import signal
import sys
import time


def write_all(descriptor, data):
    offset = 0
    while offset < len(data):
        offset += os.write(descriptor, data[offset:offset + 65536])


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def main():
    mode = sys.argv[1:]
    if mode in (["--early-close"], ["--output-before-read"]):
        result = {"format": "morivyx.plugin-run-result/0.1", "runId": "run-fixture",
                  "plugin": {"id": "morivyx.runtime-fixture", "version": "0.1.0"},
                  "capabilityId": "runtime.inspect", "status": "success", "output": {}}
        if mode == ["--output-before-read"]:
            result["output"] = {"text": "x" * 65536}
        write_all(1, encode(result))
        if mode == ["--early-close"]:
            return
    if mode == ["--stderr-before-read"]:
        write_all(2, b"x" * 65536)
    source = bytearray()
    while True:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        source.extend(chunk)
        if len(source) > 8 * 1024 * 1024:
            raise ValueError("fixture limit")
    if mode == ["--copy-input"]:
        write_all(1, bytes(source))
        return
    request = json.loads(source.decode("utf-8"))
    if mode == ["--output-before-read"]:
        return
    config = request["input"]
    action = config.get("action", "echo")
    if action == "wait":
        time.sleep(config.get("milliseconds", 10000) / 1000)
        return
    if action == "close-output-wait":
        os.close(1)
        os.close(2)
        time.sleep(10)
        return
    if action == "exit":
        sys.exit(config["code"])
    if action == "signal":
        os.kill(os.getpid(), signal.SIGTERM)
        return
    if action == "emit":
        write_all(1, base64.b64decode(config.get("stdoutBase64", "")))
        write_all(2, base64.b64decode(config.get("stderrBase64", "")))
        return
    result = {"format": "morivyx.plugin-run-result/0.1", "runId": request["runId"],
              "plugin": request["plugin"], "capabilityId": request["capability"]["id"], "status": "success"}
    if mode == ["--echo-raw-input"]:
        result["output"] = {"text": source.decode("utf-8")}
        write_all(1, encode(result))
        return
    if action == "failure":
        result["status"] = "failure"
        result["failure"] = {"code": "EXAMPLE_FAILURE", "message": "synthetic failure"}
    elif action == "cwd-check":
        result["output"] = {"matches": Path.cwd().name == config["expectedName"]}
    else:
        result["output"] = {"value": config.get("value", {}), "grant": json.loads(os.environ["MORIVYX_PLUGIN_EXECUTION_GRANT"]),
                            "ambientInherited": "MORIVYX_TEST_RUNTIME_AMBIENT" in os.environ}
    write_all(1, encode(result) + b"\n")


if __name__ == "__main__":
    main()
