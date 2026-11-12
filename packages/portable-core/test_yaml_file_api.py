"""Replay frozen generic file reads without Node, Git or a YAML dependency."""

import asyncio
import builtins
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
from unittest.mock import patch

from yaml_authoring import read_authoring_yaml, read_yaml_record
from yaml_records import serialize_yaml_record
from report_records import read_report_source, serialize_report_yaml


FIXTURE = Path(__file__).parent / "fixtures" / "yaml-file-api-vectors.json"
EXPECTED_SHA256 = "a66814ba144c3ca7d6bcda9b7570baf1c847430af36af4b6bb2bf3215cadd275"


def frozen():
    data = FIXTURE.read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPECTED_SHA256:
        raise AssertionError("pre-implementation observations changed")
    result = json.loads(data)
    if result["count"] != 5045 or len(result["cases"]) != 5045:
        raise AssertionError("frozen case count changed")
    return result


def source_bytes(entry, templates):
    if "contentHex" in entry:
        return bytes.fromhex(entry["contentHex"])
    recipe = entry.get("recipe")
    if recipe and recipe["kind"] == "mapping-depth":
        lines = ["format: " + json.dumps(recipe["format"])] if recipe.get("format") else []
        lines.extend("  " * index + "probe:" for index in range(recipe["depth"]))
        lines.append("  " * recipe["depth"] + 'leaf: "value"')
        return ("\n".join(lines) + "\n").encode("utf-8")
    if recipe and recipe["kind"] == "repeat":
        return (recipe["prefix"] + recipe["text"] * recipe["repeat"] + recipe["suffix"]).encode("utf-8")
    if "source" in entry:
        return entry["source"].encode("utf-8")
    record = copy.deepcopy(entry.get("record", templates.get(entry.get("template"))))
    expansion = entry.get("expand")
    if expansion:
        parent = record
        for key in expansion["path"][:-1]:
            parent = parent[key]
        parent[expansion["path"][-1]] = expansion["text"] * expansion["repeat"]
    return serialize_yaml_record(record).encode("utf-8")


def logical_nodes(value):
    seen, pending, nodes = {}, [], []

    def token(item):
        if item is None:
            return ["null"]
        if type(item) is str:
            data = item.encode("utf-8")
            return ["string", {"largeUtf8Bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} if len(data) > 65536 else item]
        if type(item) is bool:
            return ["boolean", item]
        if type(item) in (int, float):
            return ["number", item]
        if type(item) not in (dict, list):
            raise AssertionError("unexpected logical value")
        if id(item) not in seen:
            seen[id(item)] = len(pending)
            pending.append(item)
        return ["ref", seen[id(item)]]

    first = token(value)
    index = 0
    while index < len(pending):
        item = pending[index]
        nodes.append({"kind": "sequence", "entries": [token(v) for v in item]} if type(item) is list else
                     {"kind": "mapping", "entries": [[key, token(item[key])] for key in sorted(item)]})
        index += 1
    return {"root": first, "nodes": nodes}


async def run_case(spec, templates):
    original_open = builtins.open
    previous_cwd, previous_mask = os.getcwd(), os.umask(0o022)
    directory = os.path.realpath(tempfile.mkdtemp(prefix="morivyx-yaml-file-py-"))
    faults = spec.get("faults", [])
    counts, fired, attempts = [0] * len(faults), [0] * len(faults), []
    escaped = False

    def safe(path):
        target = os.path.abspath(os.path.join(directory, path))
        if target != directory and not target.startswith(directory + os.sep):
            raise AssertionError("case escapes owned root")
        return target

    def normalize(path):
        return path.replace(directory, "$ROOT") if type(path) is str else path

    def layout():
        rows = []

        def visit(path, relative):
            information = os.lstat(path)
            mode = stat.S_IMODE(information.st_mode)
            if stat.S_ISLNK(information.st_mode):
                rows.append({"path": relative, "kind": "symlink", "target": normalize(os.readlink(path)), "mode": mode})
            elif stat.S_ISDIR(information.st_mode):
                if relative:
                    rows.append({"path": relative, "kind": "directory", "mode": mode})
                with os.scandir(path) as entries:
                    for entry in sorted(entries, key=lambda entry: entry.name):
                        visit(entry.path, relative + "/" + entry.name if relative else entry.name)
            else:
                if not stat.S_ISREG(information.st_mode):
                    raise AssertionError("unexpected special file in owned case")
                with original_open(path, "rb") as stream:
                    data = stream.read()
                content = {"byteLength": len(data), "sha256": hashlib.sha256(data).hexdigest()} if len(data) > 65536 else {"contentHex": data.hex()}
                rows.append({"path": relative, "kind": "file", "mode": mode, "nlink": information.st_nlink, **content})
        visit(directory, "")
        return sorted(rows, key=lambda row: row["path"])

    def read_file(path, *args, **kwargs):
        nonlocal escaped
        if type(path) is str and "\0" not in path:
            absolute = os.path.abspath(path)
            if absolute != directory and not absolute.startswith(directory + os.sep):
                escaped = True
                raise AssertionError("read escapes owned root")
            attempts.append(normalize(path))
            for index, rule in enumerate(faults):
                if rule["operation"] != "readFile" or rule.get("target") not in (None, "input", "any"):
                    raise AssertionError("unsupported controlled fault")
                counts[index] += 1
                if "nth" in rule and counts[index] != rule["nth"]:
                    continue
                fired[index] += 1
                code = rule["code"]
                error = OSError(getattr(errno, code), "controlled read failure", path)
                error.code, error.path = code, path
                raise error
        return original_open(path, *args, **kwargs)

    try:
        for entry in spec.get("entries", []):
            path = safe(entry["path"])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if entry.get("kind") == "directory":
                os.makedirs(path, exist_ok=True)
                os.chmod(path, entry.get("mode", 0o755))
            elif entry.get("kind") == "symlink":
                safe(os.path.join(os.path.dirname(path), entry["target"]))
                os.symlink(safe(entry["target"]) if entry.get("absolute") else entry["target"], path)
            elif entry.get("kind") == "hardlink":
                os.link(safe(entry["target"]), path)
            else:
                with original_open(path, "wb") as stream:
                    stream.write(source_bytes(entry, templates))
                os.chmod(path, entry.get("mode", 0o644))
        os.chdir(directory)
        os.umask(spec.get("umask", 0o022))
        before = layout()
        supplied = spec.get("path", "input.yaml")
        if type(supplied) in (int, float):
            raise AssertionError("file-descriptor reads are outside this fixture vocabulary")
        destination = supplied if spec.get("relative") or type(supplied) is not str else safe(supplied)
        with patch.object(builtins, "open", read_file):
            try:
                value = await read_yaml_record(destination, spec.get("required", True))
                result = {"ok": True, "missing": True} if value is None else {"ok": True, "logical": logical_nodes(value)}
            except Exception as error:
                result = {"ok": False, "code": getattr(error, "code", None), "path": normalize(getattr(error, "path", None))}
        if escaped:
            raise AssertionError("case attempted a read outside its owned root")
        return {"result": result, "before": before, "after": layout(), "readAttempts": attempts,
                "faultCalls": counts, "faultFired": fired}
    finally:
        os.chdir(previous_cwd)
        os.umask(previous_mask)
        shutil.rmtree(directory)


async def replay(data):
    return [await run_case(row["input"], data["templates"]) for row in data["cases"]]


class YamlFileApiTests(unittest.TestCase):
    def test_explicit_omissions_observed_during_additional_review(self):
        # These ten original-API observations were collected separately after
        # the first implementation. They do not change the frozen 5045 cohort.
        rows = [('? "key"\n', "/key"), ('? "key"\nother: "value"\n', "/key"),
                ('outer:\n  ? "key"\n', "/outer/key"), ('?\n', ""), ('? "key"\n:\n', "/key"),
                ('? true\n', ""), ('? null\n', ""), ('? 1.5\n', ""), ('? <<\n', ""), ('? ["key"]\n', "")]

        async def check():
            for source, pointer in rows:
                actual = await run_case({"path": "input.yaml", "entries": [{"path": "input.yaml", "source": source}]}, {})
                with self.subTest(source=source):
                    self.assertEqual(actual["result"], {"ok": False, "code": "PACKAGE_AUTHORING_PROFILE_INVALID",
                                                       "path": "$ROOT/input.yaml" + ("#" + pointer if pointer else "")})
                    self.assertEqual(actual["before"], actual["after"])
                    self.assertEqual(actual["readAttempts"], ["$ROOT/input.yaml"])
        asyncio.run(check())

    def test_original_file_observations(self):
        data = frozen()
        actual = asyncio.run(replay(data))
        self.assertEqual(len(actual), len(data["cases"]))
        for row, result in zip(data["cases"], actual):
            with self.subTest(case=row["id"]):
                self.assertEqual(result, row["expected"])

    def test_legacy_source_limits_and_report_entry_points_remain(self):
        with self.assertRaises(ValueError):
            read_authoring_yaml(source_bytes({"recipe": {"kind": "mapping-depth", "depth": 129}}, {}))
        with self.assertRaises(ValueError):
            read_authoring_yaml(source_bytes({"recipe": {"kind": "repeat", "prefix": 'a: "', "text": "x", "repeat": 8388609, "suffix": '"\n'}}, {}))
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
