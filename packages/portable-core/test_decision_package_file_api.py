"""Replay frozen Decision file writer observations without Node or Git.

The observer records real adapter arrivals, bytes and owned output layouts.
Expected outcomes are consulted only by assertions after a case has completed.
"""

import asyncio
import copy
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

import decision_preparation
import package_apply
import package_records


FIXTURE_SHA256 = "433e67d86746b420f9d18171fb2a880c16039df8122843d3e790c582ca109e19"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def utf8(value):
    # Buffer.from(string) replaces lone UTF-16 surrogates in byte observations;
    # the corresponding logical string itself keeps its original code units.
    return value.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace").encode("utf-8")


def fixture():
    source = Path(__file__).with_name("fixtures").joinpath("decision-package-file-api-vectors.json").read_bytes()
    assert sha(source) == FIXTURE_SHA256, "frozen original observations changed"
    value = json.loads(source)
    assert value["count"] == len(value["cases"]) == 664
    assert not value["unavailableFixtures"]
    return value


def source_bytes(value):
    if type(value) is str:
        return utf8(value)
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
    pending, nodes = [value], []
    def token(item):
        if item is None:
            return ["null"]
        if type(item) is str:
            encoded = utf8(item)
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


async def owned_case(spec, templates):
    assert spec["schedule"] == "serial-io"
    directory = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-decision-package-case-"))
    cwd, mask = os.getcwd(), os.umask(0o022)
    original_reader, original_writer = package_records._package_api_io, package_apply._decision_api_io
    original_nonce = package_apply._decision_nonce
    trace, nonces, handles = [], [], []
    rules = spec.get("faults", [])
    calls, fired, queue = [0] * len(rules), [0] * len(rules), asyncio.Lock()

    def safe(path):
        target = os.path.abspath(os.path.join(directory, path))
        assert target == directory or target.startswith(directory + os.sep), "setup escapes owned root"
        return target

    def normalize(value):
        if type(value) is not str:
            return value
        if value == directory or value.startswith(directory + os.sep):
            value = "$ROOT" + value[len(directory):]
        for index, nonce in enumerate(nonces):
            suffix = f"-{os.getpid()}-{nonce}.tmp"
            value = os.sep.join(part.replace(suffix, f"-$PID-$UUID{index}.tmp")
                                if part.startswith(".") and (part.endswith(suffix) or suffix + "#" in part) else part
                                for part in value.split(os.sep))
        return value

    def normalize_bytes(value):
        parts = value.split(b"/")
        for position, part in enumerate(parts):
            if not part.startswith(b"."):
                continue
            for index, nonce in enumerate(nonces):
                suffix = f"-{os.getpid()}-{nonce}.tmp".encode()
                if part.endswith(suffix):
                    parts[position] = part[:-len(suffix)] + f"-$PID-$UUID{index}.tmp".encode()
        return b"/".join(parts)

    def layout():
        rows, root_bytes = [], os.fsencode(directory)
        pending = [(root_bytes, b"")]
        while pending:
            path, relative = pending.pop()
            information, normalized = os.lstat(path), normalize_bytes(relative)
            common = {"path": normalized.decode("utf-8", errors="replace"), "pathHex": normalized.hex(),
                      "mode": stat.S_IMODE(information.st_mode)}
            if stat.S_ISLNK(information.st_mode):
                target = os.readlink(path)
                if target == root_bytes or target.startswith(root_bytes + b"/"):
                    target = b"$ROOT" + target[len(root_bytes):]
                rows.append({**common, "kind": "symlink", "targetHex": normalize_bytes(target).hex()})
            elif stat.S_ISDIR(information.st_mode):
                rows.append({**common, "kind": "directory"})
                for name in os.listdir(path):
                    pending.append((path + b"/" + name, relative + (b"/" if relative else b"") + name))
            else:
                assert stat.S_ISREG(information.st_mode)
                with open(path, "rb") as stream:
                    content = stream.read()
                rows.append({**common, "kind": "file", "nlink": information.st_nlink,
                             "byteLength": len(content), "sha256": sha(content)})
        rows.sort(key=lambda row: bytes.fromhex(row["pathHex"]))
        if len(rows) <= 256:
            return rows
        encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return {"entries": len(rows), "byteLength": len(encoded), "sha256": sha(encoded)}

    def remove(path):
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        elif os.path.lexists(path):
            os.unlink(path)

    def write(path, source):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(source_bytes(source))

    def nonce():
        result = original_nonce()
        trace.append(["randomUUID", "$UUID" + str(len(nonces))])
        nonces.append(result)
        return result

    async def observed(original, operation, arguments):
        count = 2 if operation in ("cp", "rename", "link") else 1
        paths = list(arguments[:count])
        if operation.startswith("handle."):
            paths[0] = paths[0][0]
        valid = all(type(path) is str and "\0" not in path for path in paths)
        if valid:
            for path in paths:
                safe(path)
        normalized = [normalize(path) for path in paths]
        detail = list(arguments[count:])
        if operation == "readdir":
            detail = [{"withFileTypes": True}]
        elif operation == "handle.writeFile":
            data = utf8(arguments[1])
            detail = [{"byteLength": len(data), "sha256": sha(data)}, *arguments[2:]]
        if valid:
            trace.append([operation, *normalized, *copy.deepcopy(detail)])
        async with queue:
            for index, rule in enumerate(rules):
                if not valid or rule["operation"] != operation:
                    continue
                if "path" in rule and normalized[0] != ("$ROOT/" + rule["path"] if rule["path"] else "$ROOT"):
                    continue
                if "suffix" in rule and not normalized[0].endswith(rule["suffix"]):
                    continue
                if "destination" in rule and normalized[1] != ("$ROOT/" + rule["destination"] if rule["destination"] else "$ROOT"):
                    continue
                calls[index] += 1
                if "nth" in rule and rule["nth"] != calls[index]:
                    continue
                fired[index] += 1
                effect = rule.get("effect")
                if effect:
                    target = safe(paths[0] if effect["path"] == "$OPERATION" else paths[1] if effect["path"] == "$DESTINATION" else effect["path"])
                    if effect["kind"] == "write":
                        write(target, effect["source"])
                    elif effect["kind"] == "remove":
                        remove(target)
                    elif effect["kind"] == "directory":
                        os.makedirs(target, exist_ok=True)
                    elif effect["kind"] == "write-prefix":
                        with open(target, "wb") as stream:
                            stream.write(utf8(arguments[1])[:effect["bytes"]])
                    else:
                        raise AssertionError("unknown fault effect")
                if "code" in rule:
                    error = OSError(getattr(errno, rule["code"], errno.EIO), "controlled filesystem failure", paths[0])
                    error.code, error.path = rule["code"], paths[0]
                    raise error
            result = await original(operation, *arguments)
            if operation == "open":
                handles.append(result)
            return result

    async def reader(operation, path):
        return await observed(original_reader, operation, (path,))

    async def writer(operation, *arguments):
        return await observed(original_writer, operation, arguments)

    try:
        setup = spec.get("setup", {})
        for name, template in setup.get("packages", {}).items():
            os.makedirs(safe(name), exist_ok=True)
            for path, source in templates[template].items():
                write(safe(os.path.join(name, path)), source)
        for name in setup.get("remove", []):
            remove(safe(name))
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
        before = layout()
        arguments = copy.deepcopy(spec.get("args", []))
        if arguments and type(arguments[0]) is dict:
            for key in ("basePath", "outputPath"):
                if type(arguments[0].get(key)) is dict and "$root" in arguments[0][key]:
                    arguments[0][key] = safe(arguments[0][key]["$root"])
            for recipe in spec.get("argumentRecipes", []):
                target = arguments[0]
                for key in recipe["path"][:-1]:
                    target = target[key]
                if "repeat" in recipe:
                    result = source_bytes(recipe).decode("utf-8")
                else:
                    depth = recipe["depth"]
                    assert type(depth["count"]) is int and 0 <= depth["count"] <= 4096
                    result = depth["leaf"]
                    for _ in range(depth["count"]):
                        result = {depth["key"]: result}
                target[recipe["path"][-1]] = result

        def snapshot_args():
            values = list(arguments)
            if values and type(values[0]) is dict:
                values[0] = {**values[0], **{key: normalize(values[0][key]) for key in ("basePath", "outputPath") if key in values[0]}}
            return logical_nodes(values)

        args_before = snapshot_args()
        package_records._package_api_io, package_apply._decision_api_io = reader, writer
        package_apply._decision_nonce = nonce
        methods = {"create": decision_preparation.write_created_decision_package,
                   "revise": decision_preparation.write_revised_decision_package}
        try:
            value = await methods[spec["method"]](arguments[0] if arguments else None)
        except Exception as error:
            result = {"ok": False, "code": getattr(error, "code", "TypeError" if isinstance(error, TypeError) else type(error).__name__),
                      "path": normalize(getattr(error, "path", None))}
        else:
            result = {"ok": True, "logical": logical_nodes({**value, "outputPath": normalize(value["outputPath"]),
                                                           "metadataPath": normalize(value["metadataPath"])})}
        while True:
            pending = [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
            if not pending:
                break
            await asyncio.gather(*pending, return_exceptions=True)
        return {"result": result, "before": before, "after": layout(), "trace": trace,
                "faultCalls": calls, "faultFired": fired, "argsBefore": args_before, "argsAfter": snapshot_args()}
    finally:
        package_records._package_api_io, package_apply._decision_api_io = original_reader, original_writer
        package_apply._decision_nonce = original_nonce
        os.chdir(cwd)
        os.umask(mask)
        for _, descriptor in handles:
            try:
                os.close(descriptor)
            except OSError:
                pass
        shutil.rmtree(directory)


def replay(value):
    return [asyncio.run(owned_case(case["input"], value["templates"])) for case in value["cases"]]


class DecisionPackageFileApiTests(unittest.TestCase):
    def test_request_path_is_attached_to_existing_id_diagnostic(self):
        value = fixture()
        case = next(case for case in value["cases"] if case["expected"]["result"].get("code") == "DECISION_CREATION_ID_EXISTS")
        spec = copy.deepcopy(case["input"])
        spec["args"][0]["requestPath"] = "creation-request.json"
        actual = asyncio.run(owned_case(spec, value["templates"]))
        self.assertEqual(actual["result"], {"ok": False, "code": "DECISION_CREATION_ID_EXISTS",
                                            "path": "creation-request.json#/decisionId"})
        self.assertEqual(actual["before"], actual["after"])
        self.assertEqual(actual["argsBefore"], actual["argsAfter"])

    def test_missing_staging_metadata_has_record_package_diagnostic(self):
        value = fixture()
        case = next(case for case in value["cases"] if case["id"] == "create/baseline")
        spec = copy.deepcopy(case["input"])
        spec["faults"] = [{"operation": "lstat", "suffix": "/.morivyx", "nth": 3, "code": "ENOENT"}]
        actual = asyncio.run(owned_case(spec, value["templates"]))
        self.assertEqual(actual["result"], {"ok": False, "code": "PACKAGE_RECORD_PACKAGE_MISSING",
                                            "path": "$ROOT/.output-$PID-$UUID0.tmp/.morivyx"})
        self.assertEqual(actual["before"], actual["after"])
        self.assertEqual(actual["faultFired"], [1])

    def test_frozen_original_outcomes_and_nonmutation(self):
        value = fixture()
        for case in value["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(asyncio.run(owned_case(case["input"], value["templates"])), case["expected"])

    def test_rejection_is_awaitable_and_validates_before_io(self):
        for method in (decision_preparation.write_created_decision_package,
                       decision_preparation.write_revised_decision_package):
            promise = method({"request": None})
            self.assertTrue(hasattr(promise, "__await__"))
            with self.assertRaisesRegex(ValueError, "DECISION_"):
                asyncio.run(promise)


if __name__ == "__main__":
    if sys.argv[1:] == ["--replay"]:
        print(json.dumps(replay(fixture()), ensure_ascii=True, separators=(",", ":")))
    elif sys.argv[1:] == ["--replay-log"]:
        value = fixture()
        for case in value["cases"]:
            actual = asyncio.run(owned_case(case["input"], value["templates"]))
            print(json.dumps({"id": case["id"], "actual": actual}, ensure_ascii=True, separators=(",", ":")), flush=True)
    else:
        unittest.main()
