"""Observe the public proposal package from stdin; no expected result is read."""

import asyncio
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from canonical import UNDEFINED
import package_records
from proposal_review_api import prepare_proposal_review


def _deny_external_execution(event, _arguments):
    if event.startswith(("subprocess.", "os.exec", "os.spawn")) or event in {"os.system", "socket.connect", "socket.getaddrinfo"}:
        raise AssertionError("isolated comparison forbids external execution and network access")


sys.addaudithook(_deny_external_execution)


def tree(directory):
    result = {}
    def visit(path, prefix=""):
        for entry in sorted(path.iterdir(), key=lambda p: p.name):
            key = prefix + entry.name
            if entry.is_symlink():
                result[key] = {"link": os.readlink(entry)}
            elif entry.is_dir():
                result[key] = {"directory": True}
                visit(entry, key + "/")
            else:
                result[key] = {"bytes": base64.b64encode(entry.read_bytes()).decode("ascii")}
    visit(Path(directory))
    return result


def normalize(value, directory):
    if type(value) is str:
        return value.replace(directory, "$ROOT")
    if type(value) is list:
        return [normalize(v, directory) for v in value]
    if type(value) is dict:
        return {k: normalize(v, directory) for k, v in value.items()}
    return value


async def observe(row):
    directory = tempfile.mkdtemp(prefix="morivyx-proposal-python-")
    original_io = package_records._package_api_io
    try:
        for path, entry in row["files"].items():
            assert not path.startswith("/") and ".." not in path.split("/")
            target = Path(directory, path)
            if entry.get("directory"):
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if "link" in entry:
                    target.symlink_to(entry["link"])
                else:
                    target.write_bytes(base64.b64decode(entry["bytes"]))
        before = tree(directory)
        value = json.loads(json.dumps(row["input"], ensure_ascii=False).replace("$ROOT", directory))
        mode = row.get("mode")
        getter = {"invoked": False}
        class HostObject:
            @property
            def basePath(self):
                getter["invoked"] = True
                return "unused"
        if mode == "undefined":
            value = UNDEFINED
        elif mode in ("bigint", "symbol", "function"):
            value["changeSet"] = HostObject()
        elif mode == "nonfinite":
            value["changeSet"] = float("inf")
        elif mode == "cycle":
            value["changeSet"] = value
        elif mode == "accessor":
            value = HostObject()
        untouched = deepcopy(value) if mode in (None, "mutate-after-call", "mutate-result") else None
        events, matching = [], 0
        async def io(method, path):
            nonlocal matching
            events.append({"method": method, "path": str(path).replace(directory, "$ROOT")})
            fault = row.get("fault", {})
            if fault.get("method") == method and (not fault.get("suffix") or str(path).endswith(fault["suffix"])):
                matching += 1
                if matching == fault["occurrence"]:
                    cls = FileNotFoundError if fault["code"] == "ENOENT" else OSError
                    error = cls("synthetic " + fault["code"])
                    error.name, error.code, error.path, error.syscall = "Error", fault["code"], str(path), method
                    raise error
            return await original_io(method, path)
        package_records._package_api_io = io
        aliases = None
        try:
            pending = prepare_proposal_review(value)
            if mode == "mutate-after-call":
                value["changeSet"]["provenance"]["actor"] = "urn:uuid:00000000-0000-4000-8000-000000000099"
                value["candidateElements"][0]["attributes"]["rationale"] = "呼出し後の変更"
            result = await pending
            outcome = {"returned": deepcopy(result)}
            if mode == "mutate-result":
                aliases = {"operation": result["comparison"][0]["operation"] is result["changeSet"]["operations"][0],
                           "inputOperation": result["changeSet"]["operations"][0] is value["changeSet"]["operations"][0],
                           "inputAfter": result["comparison"][0]["after"] is value["candidateElements"][0]}
                result["changeSet"]["provenance"]["actor"] = "urn:uuid:00000000-0000-4000-8000-000000000099"
                result["comparison"][0]["after"]["attributes"]["rationale"] = "返却値の変更"
        except Exception as error:
            fields = {"name": getattr(error, "name", type(error).__name__), "message": str(error)}
            for key in ("code", "path", "errno", "syscall"):
                item = getattr(error, key, None)
                if item is not None and item is not UNDEFINED:
                    fields[key] = item
            outcome = {"threw": fields}
        finally:
            package_records._package_api_io = original_io
        return normalize({"name": row["name"], **outcome, "events": events,
                          "fileTreeUnchanged": before == tree(directory), "getterInvoked": getter["invoked"],
                          "inputUnchanged": None if untouched is None or mode == "mutate-after-call" else untouched == value,
                          "aliases": aliases}, directory)
    finally:
        package_records._package_api_io = original_io
        shutil.rmtree(directory)


async def main():
    vectors = json.load(sys.stdin)
    observations = []
    for row in vectors["cases"]:
        observations.append(await observe(row))
    json.dump({"format": "morivyx.proposal-review-file-api-observations/1", "observations": observations}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    asyncio.run(main())
