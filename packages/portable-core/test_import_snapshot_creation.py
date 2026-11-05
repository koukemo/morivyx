"""Frozen reference replay and owned-filesystem failure tests for import saves."""

import asyncio
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

from import_snapshot_creation import (prepare_import_snapshot_creation, validate_import_snapshot_creation_request,
                                      write_imported_snapshot_package)
from ledger_store import read_ledger_package
import package_apply
from package_apply import write_applied_package
from schema_validation import ValidationError


VECTOR_PATH = Path(__file__).with_name("fixtures") / "import-snapshot-creation-vectors.json"
PIN = "2871c20d18e90152cad47c47168908bdaf76b7809c7ea49481b924832b7d1a07"


def fixture():
    data = VECTOR_PATH.read_bytes()
    if hashlib.sha256(data).hexdigest() != PIN:
        raise AssertionError("frozen reference digest changed")
    return json.loads(data)


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if type(value) is str else value).hexdigest()


def tree_snapshot(root):
    output = {}

    def walk(path, prefix=""):
        for child in sorted(Path(path).iterdir(), key=lambda child: child.name):
            key = prefix + child.name
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode):
                output[key] = {"kind": "link", "target": os.readlink(child)}
            elif stat.S_ISDIR(info.st_mode):
                output[key] = {"kind": "directory"}
                walk(child, key + "/")
            else:
                output[key] = {"kind": "file", "bytes": info.st_size, "sha256": sha(child.read_bytes()), "mode": stat.S_IMODE(info.st_mode)}
    walk(root)
    return output


def create_base(root, base_files):
    for name, text in base_files.items():
        path = Path(root) / "base" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def edit(value, changes=()):
    output = copy.deepcopy(value)
    for change in changes:
        owner = output
        for key in change["path"][:-1]:
            owner = owner[key]
        if change.get("remove"):
            del owner[change["path"][-1]]
        else:
            owner[change["path"][-1]] = copy.deepcopy(change["value"])
    return output


def normalized(value, root):
    if type(value) is str:
        return re.sub(r"\.[^/]+-[0-9]+-[0-9a-f-]{36}\.tmp", ".OUTPUT-TEMP.tmp", value.replace(root, "ROOT"))
    if type(value) is list:
        return [normalized(item, root) for item in value]
    if type(value) is dict:
        return {key: normalized(item, root) for key, item in value.items()}
    return value


def run_case(entry, vectors):
    spec = json.loads(entry["inputText"])
    previous, mask = os.getcwd(), os.umask(0o022)
    with tempfile.TemporaryDirectory(prefix="morivyx-snapshot-python-") as temporary:
        root = os.path.realpath(temporary)
        try:
            create_base(root, vectors["baseSets"][spec["baseSet"]] if spec.get("baseSet") else vectors["baseFiles"])
            base = read_ledger_package(os.path.join(root, "base"))
            for setup in spec.get("setup", []):
                path = Path(root) / setup["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                if setup.get("kind") == "directory":
                    path.mkdir()
                elif setup.get("kind") == "link":
                    path.symlink_to(setup["target"])
                else:
                    path.write_text(setup.get("text", "owned fixture\n"), encoding="utf-8")
            os.chdir(root)
            request = spec["request"] if "request" in spec else edit(vectors["requests"][spec.get("adapter", "repository")], spec.get("requestEdits", []))
            if "expandRepositoryRoot" in spec:
                request["runRequest"]["input"]["repositoryRoot"] = "x" * spec["expandRepositoryRoot"]
            base = spec["base"] if "base" in spec else edit(base, spec.get("baseEdits", []))
            before, input_before = tree_snapshot(root), json_text(request)
            try:
                if entry["operation"] == "validate":
                    value = validate_import_snapshot_creation_request(request)
                    outcome = {"kind": "return", "valueSha256": sha(json_text(value)), "sameInput": value is request}
                elif entry["operation"] == "prepare":
                    outcome = {"kind": "return", "value": prepare_import_snapshot_creation(base, request)}
                else:
                    base_path, output_path = spec.get("basePath", "base"), spec.get("outputPath", "output")
                    if entry["operation"] == "write-import":
                        input_value = spec["input"] if "input" in spec else {"basePath": base_path, "outputPath": output_path, "request": request}
                        pending = write_imported_snapshot_package(input_value)
                        if spec.get("mutateAfterCall") and type(input_value) is dict and input_value.get("request"):
                            input_value["request"]["artifactId"] = input_value["request"]["actor"]
                        value = asyncio.run(pending)
                    else:
                        if "writerInput" in spec:
                            input_value = {**copy.deepcopy(spec["writerInput"]), "basePath": base_path, "outputPath": output_path}
                        else:
                            prepared = prepare_import_snapshot_creation(base, request)
                            input_value = {"basePath": base_path, "outputPath": output_path, "changeSet": prepared["changeSet"],
                                           "candidateElements": [prepared["candidateElement"]], "resultingRevision": prepared["resultingRevision"]}
                        input_value = spec["input"] if "input" in spec else edit(input_value, spec.get("writerEdits", []))
                        value = asyncio.run(write_applied_package(input_value))
                    outcome = {"kind": "return", "value": value}
            except (ValueError, TypeError, OSError, KeyError, AttributeError) as error:
                name = getattr(error, "native_name", "PackageError" if isinstance(error, ValidationError) else "TypeError" if isinstance(error, TypeError) else "Error")
                outcome = {"kind": "throw", "name": name}
                for key in ("code", "path"):
                    if hasattr(error, key):
                        outcome[key] = getattr(error, key)
            after = tree_snapshot(root)
            return normalized({**outcome, "requestUnchanged": json_text(request) == input_before, "before": before, "after": after,
                               "baseUnchanged": {key: value for key, value in before.items() if key.startswith("base/")} ==
                               {key: value for key, value in after.items() if key.startswith("base/")}}, root)
        finally:
            os.chdir(previous)
            os.umask(mask)


class ImportSnapshotCreationTests(unittest.TestCase):
    def test_frozen_cases_and_digests(self):
        vectors = fixture()
        self.assertEqual(vectors["count"], 424)
        for entry in vectors["cases"]:
            with self.subTest(entry=entry["id"]):
                self.assertEqual(sha(entry["inputText"]), entry["inputSha256"])
                self.assertEqual(sha(json_text(entry["expected"])), entry["outputSha256"])
                self.assertEqual(run_case(entry, vectors), entry["expected"])

    def test_proposal_owns_separate_snapshot_copies(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            base = read_ledger_package(os.path.join(root, "base"))
            request = copy.deepcopy(vectors["requests"]["repository"])
            before = copy.deepcopy(request)
            proposal = prepare_import_snapshot_creation(base, request)
            proposal["candidateElement"]["extensions"]["morivyx.import/snapshot"]["snapshot"]["locator"] = "changed"
            self.assertEqual(proposal["changeSet"]["provenance"]["importSnapshot"]["snapshot"]["locator"], "source.txt")
            self.assertEqual(request, before)

    def test_nonlogical_values_reject_without_running_accessors(self):
        class Guarded(dict):
            def items(self):
                raise AssertionError("must not inspect foreign objects")
        cyclic = {}
        cyclic["self"] = cyclic
        for value in (Guarded(), object(), cyclic, {"x": float("nan")}, {"x": "\ud800"}):
            with self.subTest(kind=type(value)), self.assertRaises(ValidationError) as caught:
                validate_import_snapshot_creation_request(value)
            self.assertEqual(caught.exception.code, "IMPORT_SNAPSHOT_REQUEST_INVALID")

    def test_clone_happens_before_await(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            request = copy.deepcopy(vectors["requests"]["repository"])
            pending = write_imported_snapshot_package({"basePath": os.path.join(root, "base"), "outputPath": os.path.join(root, "output"), "request": request})
            request["artifactId"] = request["actor"]
            result = asyncio.run(pending)
            self.assertEqual(result["artifactId"], vectors["requests"]["repository"]["artifactId"])

    def test_failed_publish_removes_owned_output_and_staging(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            before = tree_snapshot(root)
            with patch.object(package_apply.os, "rename", side_effect=OSError(errno.EIO, "owned injected rename failure")):
                with self.assertRaises(OSError):
                    asyncio.run(write_imported_snapshot_package({"basePath": os.path.join(root, "base"), "outputPath": os.path.join(root, "output"), "request": vectors["requests"]["repository"]}))
            self.assertEqual(tree_snapshot(root), before)

    def test_reread_mismatch_removes_staging(self):
        vectors = fixture()
        original = package_apply.read_ledger_package
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            before = tree_snapshot(root)

            def changed(path):
                value = original(path)
                if os.path.basename(path).endswith(".tmp"):
                    value["elements"] = []
                return value
            with patch.object(package_apply, "read_ledger_package", side_effect=changed):
                with self.assertRaises(ValidationError) as caught:
                    asyncio.run(write_imported_snapshot_package({"basePath": os.path.join(root, "base"), "outputPath": os.path.join(root, "output"), "request": vectors["requests"]["repository"]}))
            self.assertEqual(caught.exception.code, "PACKAGE_OUTPUT_MISMATCH")
            self.assertEqual(tree_snapshot(root), before)

    def test_final_collision_preserves_unowned_output(self):
        vectors = fixture()
        original = os.mkdir
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            output = os.path.join(root, "output")

            def collide(path, *args, **kwargs):
                if os.fspath(path) == output:
                    original(path, *args, **kwargs)
                    (Path(output) / "owner.txt").write_text("other owner\n")
                    raise FileExistsError(errno.EEXIST, "owned collision", path)
                return original(path, *args, **kwargs)
            with patch.object(package_apply.os, "mkdir", side_effect=collide):
                with self.assertRaises(ValidationError) as caught:
                    asyncio.run(write_imported_snapshot_package({"basePath": os.path.join(root, "base"), "outputPath": output, "request": vectors["requests"]["repository"]}))
            self.assertEqual(caught.exception.code, "PACKAGE_OUTPUT_EXISTS")
            self.assertEqual((Path(output) / "owner.txt").read_text(), "other owner\n")
            self.assertEqual(sorted(path.name for path in Path(root).iterdir()), ["base", "output"])


if __name__ == "__main__":
    if "--probes" in sys.argv:
        vectors = fixture()
        entries = json.loads(sys.stdin.read())
        print(json.dumps([{"id": entry["id"], "outcome": run_case(entry, vectors)} for entry in entries], ensure_ascii=True))
    elif "--replay" in sys.argv:
        if "--isolated" in sys.argv:
            assert shutil.which("node") is None and shutil.which("git") is None
        vectors = fixture()
        print(json.dumps([{"id": entry["id"], "outcome": run_case(entry, vectors)} for entry in vectors["cases"]], ensure_ascii=True))
    else:
        unittest.main()
