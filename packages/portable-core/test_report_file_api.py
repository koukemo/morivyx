"""Replay the public file API observations using only independent Python."""

import asyncio
import builtins
import copy
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

from report_records import read_report, write_report, read_report_source, serialize_report_yaml
from yaml_records import serialize_yaml_record


FIXTURE = Path(__file__).parent / "fixtures" / "report-file-api-vectors.json"
EXPECTED_SHA256 = "cab3373891f15513869a24955ef042f85a27d1d183769867c5f77f8e171b5793"


def edit(value, changes):
    for change in changes:
        parent = value
        for key in change["path"][:-1]:
            parent = parent[key]
        key = change["path"][-1]
        if change.get("remove"):
            del parent[key]
        else:
            parent[key] = copy.deepcopy(change["value"])


def expand(value, expansion):
    if expansion:
        edit(value, [{"path": expansion["path"], "value": expansion["text"] * expansion["repeat"]}])


def fingerprint(value):
    seen, pending, rows = {}, [], []

    def reference(item):
        if type(item) in (dict, list):
            if id(item) not in seen:
                seen[id(item)] = len(pending)
                pending.append(item)
            return ["ref", seen[id(item)]]
        return [type(item).__name__, repr(item)]

    first = reference(value)
    index = 0
    while index < len(pending):
        item = pending[index]
        rows.append(["list", [reference(v) for v in item]] if type(item) is list else
                    ["dict", [[k, reference(v)] for k, v in item.items()]])
        index += 1
    return [first, rows]


def frozen():
    data = FIXTURE.read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPECTED_SHA256:
        raise AssertionError("pre-implementation observations changed")
    return json.loads(data)


async def run_case(spec, templates):
    original = {name: getattr(os, name) for name in ("open", "close", "write", "fsync", "link", "unlink", "lstat", "mkdir", "scandir", "chdir", "umask")}
    original_open = builtins.open
    previous_cwd, previous_mask = os.getcwd(), os.umask(0o022)
    directory = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-report-py-"))
    temporary, descriptors, patches = [], {}, []
    faults = spec.get("faults", [])
    counts, fired = [0] * len(faults), [0] * len(faults)

    def safe(path):
        target = os.path.abspath(os.path.join(directory, path))
        if target != directory and not target.startswith(directory + os.sep):
            raise AssertionError("case escapes owned root")
        return target

    input_path = safe(spec["path"] if type(spec.get("path")) is str and spec["path"] else "input.yaml")

    def location(path):
        if type(path) is not str:
            return None
        absolute = os.path.abspath(path)
        if absolute != directory and not absolute.startswith(directory + os.sep):
            return None
        name = os.path.basename(absolute)
        if re.fullmatch(r"\.report-[0-9]+-[0-9a-f-]+\.tmp", name):
            return "temporary"
        if re.fullmatch(r"\.record-id-.*\.lock", name):
            return "lock"
        if name == ".morivyx":
            return "metadata"
        if name == "reports":
            return "reports"
        if absolute == input_path:
            return "input"
        return "record" if name.endswith(".yaml") else "other"

    def fault(operation, path):
        kind = location(path)
        if kind is None:
            return None
        for index, rule in enumerate(faults):
            if rule["operation"] != operation or rule["target"] not in ("any", kind):
                continue
            counts[index] += 1
            if "nth" in rule and counts[index] != rule["nth"]:
                continue
            fired[index] += 1
            return rule
        return None

    def failure(rule, path):
        code = rule.get("code", "EIO")
        error = OSError(getattr(errno, code), "controlled filesystem failure", path)
        error.code, error.path = code, path
        return error

    def normalize(text):
        if type(text) is not str:
            return text
        result = text.replace(directory, "$ROOT")
        for index, path in enumerate(temporary):
            relative = path[len(directory):]
            parent = os.path.dirname(path)[len(directory):]
            result = result.replace(relative, parent + "/@temporary-" + str(index))
        return result

    def normalized(value):
        if type(value) is str:
            text = normalize(value)
            data = text.encode("utf-8")
            return {"largeUtf8Bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} if len(data) > 65536 else text
        if type(value) is list:
            return [normalized(v) for v in value]
        if type(value) is dict:
            return {k: normalized(v) for k, v in value.items()}
        return value

    def layout():
        rows = []

        def visit(path):
            information = original["lstat"](path)
            mode = stat.S_IMODE(information.st_mode)
            name = normalize(path).removeprefix("$ROOT").removeprefix("/")
            if stat.S_ISLNK(information.st_mode):
                rows.append({"path": name, "kind": "symlink", "target": normalize(os.readlink(path)), "mode": mode})
            elif stat.S_ISDIR(information.st_mode):
                if name:
                    rows.append({"path": name, "kind": "directory", "mode": mode})
                with original["scandir"](path) as entries:
                    for entry in sorted(entries, key=lambda e: e.name):
                        visit(entry.path)
            else:
                if not stat.S_ISREG(information.st_mode):
                    raise AssertionError("unexpected special file")
                with original_open(path, "rb") as stream:
                    data = stream.read()
                content = {"byteLength": len(data), "sha256": hashlib.sha256(data).hexdigest()} if len(data) > 65536 else {"contentHex": data.hex()}
                rows.append({"path": name, "kind": "file", "mode": mode, "nlink": information.st_nlink, **content})
        visit(directory)
        return sorted(rows, key=lambda r: r["path"])

    def wrap_operation(name, operation):
        def invoke(path, *args, **kwargs):
            if name == "open" and location(path) == "temporary":
                absolute = os.path.abspath(path)
                if absolute not in temporary:
                    temporary.append(absolute)
            rule = fault(operation, path)
            if rule and rule.get("action") == "race-target":
                handle = original["open"](args[0], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                try:
                    original["write"](handle, b"foreign-race")
                finally:
                    original["close"](handle)
                return original[name](path, *args, **kwargs)
            if rule:
                raise failure(rule, path)
            result = original[name](path, *args, **kwargs)
            if name == "open" and location(path) is not None:
                descriptors[result] = path
            return result
        return invoke

    def wrap_descriptor(name, operation):
        def invoke(descriptor, *args, **kwargs):
            path = descriptors.get(descriptor)
            rule = fault(operation, path)
            if rule:
                if name == "close":
                    original[name](descriptor, *args, **kwargs)
                    descriptors.pop(descriptor, None)
                raise failure(rule, path)
            result = original[name](descriptor, *args, **kwargs)
            if name == "close":
                descriptors.pop(descriptor, None)
            return result
        return invoke

    def read_file(path, *args, **kwargs):
        rule = fault("readFile", path)
        if rule:
            raise failure(rule, path)
        return original_open(path, *args, **kwargs)

    async def capture(operation):
        try:
            return {"ok": True, "value": await operation}
        except Exception as error:
            return {"ok": False, "code": getattr(error, "code", None), "path": normalize(getattr(error, "path", None))}

    try:
        for entry in spec.get("entries", []):
            path = safe(entry["path"])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if entry.get("kind") == "directory":
                os.makedirs(path, exist_ok=True)
                os.chmod(path, entry.get("mode", 0o755))
            elif entry.get("kind") == "symlink":
                os.symlink(safe(entry["target"]) if entry.get("absolute") else entry["target"], path)
            elif entry.get("kind") == "hardlink":
                os.link(safe(entry["target"]), path)
            else:
                record = copy.deepcopy(entry.get("record", templates.get(entry.get("template"))))
                expand(record, entry.get("expand"))
                data = bytes.fromhex(entry["contentHex"]) if "contentHex" in entry else (entry["source"] if "source" in entry else serialize_yaml_record(record)).encode("utf-8")
                with original_open(path, "wb") as stream:
                    stream.write(data)
                os.chmod(path, entry.get("mode", 0o644))
        original["chdir"](directory)
        original["umask"](spec.get("umask", 0o022))
        before = layout()
        value = copy.deepcopy(spec["value"] if "value" in spec else templates.get(spec.get("template")))
        expand(value, spec.get("expand"))
        edit(value, spec.get("edits", []))
        for name, operation in [("open", "open"), ("lstat", "lstat"), ("mkdir", "mkdir"), ("scandir", "readdir"), ("link", "link"), ("unlink", "unlink")]:
            patches.append(patch.object(os, name, wrap_operation(name, operation)))
        for name, operation in [("write", "writeFile"), ("fsync", "sync"), ("close", "close")]:
            patches.append(patch.object(os, name, wrap_descriptor(name, operation)))
        patches.append(patch.object(builtins, "open", read_file))
        for item in patches:
            item.start()
        path = spec.get("path", ".")
        destination = path if spec.get("relative") or type(path) is not str else safe(path)
        if spec["operation"] == "read":
            before_await = fingerprint(value)
            result = await capture(read_report(destination))
        else:
            pending = [write_report(destination, value) for _ in range(spec.get("parallel", 1))]
            edit(value, spec.get("afterCallEdits", []))
            before_await = fingerprint(value)
            completed = await asyncio.gather(*(capture(operation) for operation in pending))
            result = sorted((normalized(v) for v in completed), key=lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))) if spec.get("parallel") else completed[0]
        for item in reversed(patches):
            item.stop()
        patches.clear()
        return {"result": normalized(result), "inputUnchanged": fingerprint(value) == before_await, "before": before, "after": layout(),
                "temporaryAttempts": len(temporary), "faultCalls": counts, "faultFired": fired}
    finally:
        for item in reversed(patches):
            item.stop()
        for descriptor in list(descriptors):
            try:
                original["close"](descriptor)
            except OSError:
                pass
        original["chdir"](previous_cwd)
        original["umask"](previous_mask)
        shutil.rmtree(directory)


async def replay(data):
    return [await run_case(case["input"], data["templates"]) for case in data["cases"]]


class ReportFileApiTests(unittest.TestCase):
    def test_original_observations(self):
        data = frozen()
        self.assertEqual(data["count"], 1041)
        for case, actual in zip(data["cases"], asyncio.run(replay(data))):
            with self.subTest(case=case["id"]):
                self.assertEqual(actual, case["expected"])

    def test_existing_source_apis_remain_synchronous_and_optional_id(self):
        record = copy.deepcopy(frozen()["templates"]["trace"])
        del record["id"]
        source = serialize_report_yaml(record)
        self.assertIs(type(source), str)
        self.assertIs(type(read_report_source(source)), dict)


if __name__ == "__main__":
    if sys.argv[1:] == ["--replay"]:
        print(json.dumps(asyncio.run(replay(frozen())), ensure_ascii=True, separators=(",", ":")))
    else:
        unittest.main()
