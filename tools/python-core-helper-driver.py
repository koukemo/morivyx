"""Call the five portable helpers using input recipes, never expected outcomes."""

import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages/portable-core"))
import canonical
import graph_validation
import schema_registry
import schema_validation
import semantic_diff

UNDEFINED = canonical.UNDEFINED
METHODS = {
    "PackageError": schema_validation.PackageError,
    "compareUnicode": canonical.compare_unicode,
    "schemaKey": schema_registry.schema_key,
    "compareSemanticDiffEntries": semantic_diff.compare_semantic_diff_entries,
    "compareIssues": graph_validation.compare_issues,
}


def materialize(value):
    if type(value) is list:
        return [materialize(child) for child in value]
    if type(value) is not dict:
        return value
    if "$fixture" in value:
        kind = value["$fixture"]
        if kind == "undefined":
            return UNDEFINED
        if kind == "negative-zero":
            return -0.0
        if kind == "nan":
            return math.nan
        if kind == "infinity":
            return math.inf
        if kind == "bytes":
            assert len(value["hex"]) <= 131072
            return bytes.fromhex(value["hex"])
        if kind == "cycle":
            result = {}
            result["probe"] = result
            return result
        if kind == "depth":
            assert type(value["count"]) is int and 0 <= value["count"] <= 2048
            result = value["leaf"]
            for _ in range(value["count"]):
                result = {"probe": result}
            return result
        raise AssertionError("unknown input recipe")
    return {key: materialize(child) for key, child in value.items()}


def observe(value, owned_root):
    queue, seen, nodes = [], {}, []

    def token(item):
        if item is UNDEFINED:
            return ["undefined"]
        if item is None:
            return ["null"]
        if type(item) is str:
            return ["string", item.replace(owned_root, "$ROOT")]
        if type(item) is bool:
            return ["boolean", item]
        if type(item) in (int, float):
            number = ("NaN" if math.isnan(item) else "+Infinity" if item == math.inf else
                      "-Infinity" if item == -math.inf else "-0" if item == 0 and math.copysign(1, item) < 0 else item)
            return ["number", number]
        identity = id(item)
        if identity not in seen:
            seen[identity] = len(queue)
            queue.append(item)
        return ["ref", seen[identity]]

    first, position = token(value), 0
    while position < len(queue):
        assert len(queue) <= 20000
        item = queue[position]
        if type(item) in (bytes, bytearray):
            nodes.append({"kind": "bytes", "hex": bytes(item).hex()})
        elif type(item) is list:
            nodes.append({"kind": "sequence", "entries": [token(child) for child in item]})
        elif type(item) is dict:
            keys = list(item)
            indexed = [key for key in keys if key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < 4294967295]
            ordered = sorted(indexed, key=int) + [key for key in keys if key not in indexed]
            nodes.append({"kind": "mapping", "entries": [[key.replace(owned_root, "$ROOT"), token(item[key])] for key in ordered]})
        else:
            raise AssertionError("unsupported observation value")
        position += 1
    return {"root": first, "nodes": nodes}


def layout(root):
    rows, pending = [], [(os.fsencode(root), b"")]
    while pending:
        path, relative = pending.pop()
        state = os.lstat(path)
        common = {"pathHex": relative.hex(), "mode": stat.S_IMODE(state.st_mode)}
        if stat.S_ISLNK(state.st_mode):
            rows.append({**common, "kind": "symlink", "targetHex": os.readlink(path).hex()})
        elif stat.S_ISDIR(state.st_mode):
            rows.append({**common, "kind": "directory"})
            for name in os.listdir(path):
                pending.append((path + b"/" + name, relative + (b"/" if relative else b"") + name))
        else:
            assert stat.S_ISREG(state.st_mode)
            with open(path, "rb") as stream:
                content = stream.read()
            rows.append({**common, "kind": "file", "nlink": state.st_nlink, "bytes": len(content),
                         "sha256": hashlib.sha256(content).hexdigest()})
    return sorted(rows, key=lambda row: bytes.fromhex(row["pathHex"]))


def run_case(specification):
    name = specification["function"]
    function = METHODS[name]
    root = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-core-helper-"))
    cwd, mask = os.getcwd(), os.umask(0o022)
    try:
        os.chdir(root)
        args = materialize(specification["args"])
        before, files_before = observe(args, root), layout(root)
        awaitable = False
        try:
            result = function(*args)
            awaitable = inspect.isawaitable(result)
            assert not awaitable, "synchronous helper returned an awaitable"
            if name == "PackageError":
                value = {"name": result.name, "message": result.message, "code": result.code, "path": result.path,
                         "issue": result.toIssue(), "inheritsError": isinstance(result, Exception)}
            else:
                value = result
            is_object = type(result) in (dict, list, bytes, bytearray)
            aliases = [index for index, argument in enumerate(args) if is_object and result is argument]
            outcome = {"ok": True, "value": observe(value, root), "returnAliases": aliases}
        except Exception as error:
            outcome = {"ok": False, "name": getattr(error, "name", type(error).__name__),
                       "message": observe(getattr(error, "message", str(error)), root),
                       "code": observe(getattr(error, "code", UNDEFINED), root),
                       "path": observe(getattr(error, "path", UNDEFINED), root)}
        return {"id": specification["id"], "function": name, "awaitable": awaitable, "outcome": outcome,
                "argumentsBefore": before, "argumentsAfter": observe(args, root),
                "filesystemBefore": files_before, "filesystemAfter": layout(root),
                "pythonCall": {"module": function.__module__, "symbol": function.__name__}}
    finally:
        os.chdir(cwd)
        os.umask(mask)
        shutil.rmtree(root)


def capture(input_path=None):
    assert sys.version_info[:2] in ((3, 14), (3, 15)), "Python 3.14 or 3.15 required"
    path = input_path or ROOT / "packages/portable-core/fixtures/core-helper-vectors.json"
    vectors = canonical.load_json(Path(path).read_text(encoding="utf-8"))
    assert vectors["format"] == "morivyx.core-helper-vectors/1"
    assert vectors["count"] == len(vectors["cases"]) == 1945
    assert len({row["id"] for row in vectors["cases"]}) == vectors["count"]
    assert set(row["function"] for row in vectors["cases"]) == set(METHODS)
    observations = [run_case(row) for row in vectors["cases"]]
    return {"format": "morivyx.function-direct-observations/1", "runtime": "python",
            "version": ".".join(map(str, sys.version_info[:3])), "count": len(observations), "observations": observations}


if __name__ == "__main__":
    assert sys.argv[1:] == ["--capture"]
    print(json.dumps(capture(), ensure_ascii=True, separators=(",", ":")))
