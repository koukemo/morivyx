"""Frozen original file API observations, replayed without Node or Git."""

import asyncio
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

import package_records
from graph_index import rebuild_package_index
from semantic_diff import diff_packages


FIXTURE_SHA256 = "9557f51fd314eeb510526211ab4fa478c3afe05ff7e0cdde51e8fc79f2e57ddd"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fixture():
    source = Path(__file__).with_name("fixtures").joinpath("package-file-api-vectors.json").read_bytes()
    assert sha(source) == FIXTURE_SHA256, "frozen original observations changed"
    value = json.loads(source)
    assert value["count"] == len(value["cases"]) == 1063
    assert value["requestedCount"] == 1069 and len(value["unavailableFixtures"]) == 6
    return value


def source_bytes(value):
    if type(value) is str:
        return value.encode("utf-8")
    if "hex" in value:
        return bytes.fromhex(value["hex"])
    if "extensionDepth" in value:
        recipe = value["extensionDepth"]
        depth = recipe["depth"]
        assert type(depth) is int and 0 <= depth <= 4096
        return (recipe["prefix"] + "extensions:\n  example.test/deep:\n" +
                "".join(" " * (4 + index * 2) + "probe:\n" for index in range(depth)) +
                " " * (4 + depth * 2) + 'leaf: "value"\n').encode("utf-8")
    recipe = value["repeat"]
    return (recipe["prefix"] + recipe["text"] * recipe["count"] + recipe["suffix"]).encode("utf-8")


def logical_nodes(value):
    # BFS does not depend on the interpreter recursion limit or alias identity.
    pending, nodes = [value], []

    def token(item):
        if item is None:
            return ["null"]
        if type(item) is str:
            encoded = item.encode("utf-8")
            return ["string", {"byteLength": len(encoded), "sha256": sha(encoded)} if len(encoded) > 65536 else item]
        if type(item) is bool:
            return ["boolean", item]
        if type(item) in (int, float):
            return ["number", item]
        assert type(item) in (dict, list)
        index = len(pending)
        pending.append(item)
        return ["ref", index]

    position = 0
    while position < len(pending):
        item = pending[position]
        if type(item) is list:
            nodes.append({"kind": "sequence", "entries": [token(entry) for entry in item]})
        elif type(item) is dict:
            nodes.append({"kind": "mapping", "entries": [[key, token(item[key])] for key in sorted(item)]})
        else:
            assert position == 0
            nodes.append({"kind": "scalar", "value": token(item)})
        position += 1
    return {"root": ["ref", 0], "nodes": nodes}


def layout(directory):
    rows, root_bytes = [], os.fsencode(directory)

    def visit(path, relative):
        information = os.lstat(path)
        common = {"path": relative.decode("utf-8", errors="replace"), "pathHex": relative.hex(),
                  "mode": stat.S_IMODE(information.st_mode)}
        if stat.S_ISLNK(information.st_mode):
            target = os.readlink(path)
            if target == root_bytes or target.startswith(root_bytes + b"/"):
                target = b"$ROOT" + target[len(root_bytes):]
            rows.append({**common, "kind": "symlink", "targetHex": target.hex()})
        elif stat.S_ISDIR(information.st_mode):
            rows.append({**common, "kind": "directory"})
            for name in sorted(os.listdir(path)):
                visit(path + b"/" + name, relative + (b"/" if relative else b"") + name)
        else:
            assert stat.S_ISREG(information.st_mode)
            with open(path, "rb") as stream:
                content = stream.read()
            rows.append({**common, "kind": "file", "nlink": information.st_nlink,
                         "byteLength": len(content), "sha256": sha(content)})

    visit(root_bytes, b"")
    if len(rows) <= 256:
        return rows
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {"entries": len(rows), "byteLength": len(encoded), "sha256": sha(encoded)}


async def owned_case(spec, templates):
    assert spec.get("schedule") == "serial-io"
    directory = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-package-file-case-"))
    cwd, mask = os.getcwd(), os.umask(0o022)
    original = package_records._package_api_io
    trace, calls, fired = [], [0] * len(spec.get("faults", [])), [0] * len(spec.get("faults", []))
    queue = asyncio.Lock()

    def safe(path):
        target = os.path.abspath(os.path.join(directory, path))
        assert target == directory or target.startswith(directory + os.sep), "setup escapes owned root"
        return target

    def normalize(value):
        if type(value) is str and (value == directory or value.startswith(directory + os.sep)):
            return "$ROOT" + value[len(directory):]
        return value

    def write(path, source):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(source_bytes(source))

    async def observed(operation, path):
        valid_path = type(path) is str and "\0" not in path
        if valid_path:
            absolute = os.path.abspath(path)
            assert absolute == directory or absolute.startswith(directory + os.sep), "operation escapes owned root"
            trace.append([operation, normalize(path)])
        # FIFO execution is fixture-only, independent of the expected traces.
        async with queue:
            for index, rule in enumerate(spec.get("faults", [])):
                if not valid_path or rule["operation"] != operation:
                    continue
                if "path" in rule and normalize(path) != "$ROOT/" + rule["path"]:
                    continue
                calls[index] += 1
                if "nth" in rule and rule["nth"] != calls[index]:
                    continue
                fired[index] += 1
                error = OSError(getattr(errno, rule["code"], errno.EIO), "controlled filesystem failure", path)
                error.code, error.path = rule["code"], path
                raise error
            return await original(operation, path)

    try:
        setup = spec.get("setup", {})
        for name, template in setup.get("packages", {}).items():
            os.makedirs(safe(name), exist_ok=True)
            for path, source in templates[template].items():
                write(safe(os.path.join(name, path)), source)
        for name in setup.get("remove", []):
            path = safe(name)
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            elif os.path.lexists(path):
                os.unlink(path)
        for move in setup.get("move", []):
            os.makedirs(os.path.dirname(safe(move["to"])), exist_ok=True)
            os.rename(safe(move["from"]), safe(move["to"]))
        for item in setup.get("directories", []):
            path = safe(item if type(item) is str else item["path"])
            os.makedirs(path, exist_ok=True)
            os.chmod(path, item.get("mode", 0o755) if type(item) is dict else 0o755)
        for item in setup.get("put", []):
            path = safe(item["path"])
            write(path, item["source"])
            os.chmod(path, item.get("mode", 0o644))
        for group in setup.get("many", []):
            os.makedirs(safe(group["directory"]), exist_ok=True)
            for index in range(group["count"]):
                write(safe(os.path.join(group["directory"], group["prefix"] + str(index) + group["suffix"])), group["source"])
        assert not setup.get("rawFiles"), "unavailable fixture is not an API observation"
        for link in setup.get("links", []):
            path = safe(link["path"])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if link["kind"] == "hardlink":
                os.link(safe(link["target"]), path)
            else:
                safe(link["target"] if link.get("absolute") else os.path.join(os.path.dirname(path), link["target"]))
                os.symlink(safe(link["target"]) if link.get("absolute") else link["target"], path)
        os.chdir(directory)
        os.umask(spec.get("umask", 0o022))
        before = layout(directory)
        path_count = 2 if spec["method"] == "diff" else 1
        arguments = [safe(value["$root"]) if index < path_count and type(value) is dict and "$root" in value else
                     json.loads(json.dumps(value)) for index, value in enumerate(spec.get("args", []))]

        def snapshot_args():
            return logical_nodes([normalize(value) if index < path_count and type(value) is str else value
                                  for index, value in enumerate(arguments)])

        args_before = snapshot_args()
        package_records._package_api_io = observed
        methods = {"inspect": package_records.inspect_package, "index": rebuild_package_index, "diff": diff_packages}
        try:
            value = await methods[spec["method"]](*arguments)
        except Exception as error:
            result = {"ok": False, "code": getattr(error, "code", type(error).__name__), "path": normalize(getattr(error, "path", None))}
        else:
            result = {"ok": True, "logical": logical_nodes(value)}
        # The fixture owns this event loop. Drain any outstanding read tasks
        # before inspecting the layout and removing its temporary directory.
        while True:
            pending = [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
            if not pending:
                break
            await asyncio.gather(*pending, return_exceptions=True)
        package_records._package_api_io = original
        return {"result": result, "before": before, "after": layout(directory), "trace": trace,
                "faultCalls": calls, "faultFired": fired, "argsBefore": args_before, "argsAfter": snapshot_args()}
    finally:
        package_records._package_api_io = original
        os.chdir(cwd)
        os.umask(mask)
        shutil.rmtree(directory)


def replay(value):
    return [asyncio.run(owned_case(case["input"], value["templates"])) for case in value["cases"]]


class PackageFileApiTests(unittest.TestCase):
    def test_frozen_original_outcomes_and_nonmutation(self):
        value = fixture()
        for case in value["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(asyncio.run(owned_case(case["input"], value["templates"])), case["expected"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--replay"]:
        print(json.dumps(replay(fixture()), ensure_ascii=True, separators=(",", ":")))
    else:
        unittest.main()
