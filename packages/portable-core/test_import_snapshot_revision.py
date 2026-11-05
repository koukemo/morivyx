"""Frozen reimport replay with owned filesystem observations."""

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

import package_apply

from import_snapshot_revision import (import_follows_observations, prepare_import_snapshot_revision,
                                      restore_import_baseline, validate_import_snapshot_revision_request,
                                      write_reimported_snapshot_package)
from ledger_store import read_ledger_package
from schema_validation import ValidationError

PIN = "26d0acf3f592142243c76c420c1c3e518e6e550d2fc7f5b2294c0cf01451d062"


def fixture():
    data = (Path(__file__).with_name("fixtures") / "import-snapshot-revision-vectors.json").read_bytes()
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
        elif type(owner) is list and change["path"][-1] == len(owner):
            owner.append(copy.deepcopy(change["value"]))
        else:
            owner[change["path"][-1]] = copy.deepcopy(change["value"])
    return output


def operation_path(root, value):
    if type(value) is not str or not value:
        return
    if os.path.isabs(value) or os.path.commonpath((root, os.path.abspath(os.path.join(root, value)))) != root:
        raise ValueError("probe path escapes owned root")


def operation_input(root, value):
    if type(value) is dict:
        for key in ("basePath", "outputPath"):
            operation_path(root, value.get(key))


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
    with tempfile.TemporaryDirectory(prefix="morivyx-reimport-python-") as temporary:
        root = os.path.realpath(temporary)
        try:
            create_base(root, vectors["baseSets"][spec.get("baseSet", spec.get("adapter", "repository"))])
            base = read_ledger_package(os.path.join(root, "base"))
            for setup in spec.get("setup", []):
                operation_path(root, setup["path"])
                path = Path(root) / setup["path"]
                if os.path.abspath(path) == root:
                    raise ValueError("probe layout must name an owned child")
                path.parent.mkdir(parents=True, exist_ok=True)
                if setup.get("kind") == "directory":
                    path.mkdir()
                elif setup.get("kind") == "link":
                    if os.path.isabs(setup["target"]) or os.path.commonpath((root, os.path.abspath(path.parent / setup["target"]))) != root:
                        raise ValueError("probe link escapes owned root")
                    path.symlink_to(setup["target"])
                else:
                    path.write_text(setup.get("text", "owned\n"), encoding="utf-8")
            os.chdir(root)
            request = spec["request"] if "request" in spec else edit(vectors["requests"][spec.get("adapter", "repository")], spec.get("requestEdits", []))
            if "expandRoot" in spec:
                request["runRequest"]["input"]["repositoryRoot"] = "x" * spec["expandRoot"]
            base = spec["base"] if "base" in spec else edit(base, spec.get("baseEdits", []))
            before, original_request, original_base = tree_snapshot(root), json_text(request), json_text(base)
            try:
                operation = entry["operation"]
                if operation == "validate":
                    value = validate_import_snapshot_revision_request(request)
                    outcome = {"kind": "return", "valueSha256": sha(json_text(value)), "sameInput": value is request}
                elif operation == "prepare":
                    outcome = {"kind": "return", "value": prepare_import_snapshot_revision(base, request)}
                elif operation == "baseline":
                    outcome = {"kind": "return", "value": restore_import_baseline(base, request)}
                elif operation == "observations":
                    outcome = {"kind": "return", "value": import_follows_observations(base, request["artifactId"],
                        request["runResult"]["output"]["retrievedAt"], request["recordedAt"])}
                else:
                    input_value = spec["input"] if "input" in spec else {"basePath": spec.get("basePath", "base"),
                        "outputPath": spec.get("outputPath") if spec.get("outputPath") is not None else "output", "request": request}
                    operation_input(root, input_value)
                    pending = write_reimported_snapshot_package(input_value)
                    if spec.get("mutateAfterCall") and type(input_value) is dict and input_value.get("request"):
                        input_value["request"]["baselineArtifactRevision"] = "bad"
                        input_value["request"]["runResult"]["output"]["digest"] = "sha256:" + "0" * 64
                    outcome = {"kind": "return", "value": asyncio.run(pending)}
            except Exception as error:
                name = getattr(error, "native_name", "PackageError" if isinstance(error, ValidationError) else "TypeError" if isinstance(error, (TypeError, AttributeError, KeyError)) else "Error")
                outcome = {"kind": "throw", "name": name}
                for key in ("code", "path"):
                    if hasattr(error, key):
                        outcome[key] = getattr(error, key)
            after = tree_snapshot(root)
            return normalized({**outcome, "requestUnchanged": json_text(request) == original_request,
                "logicalBaseUnchanged": json_text(base) == original_base, "before": before, "after": after,
                "baseUnchanged": {key: value for key, value in before.items() if key.startswith("base/")} ==
                                 {key: value for key, value in after.items() if key.startswith("base/")}}, root)
        finally:
            os.chdir(previous)
            os.umask(mask)


class ImportSnapshotRevisionTests(unittest.TestCase):
    def test_incomplete_history_boundaries(self):
        vectors = fixture()
        shapes = [("null-history", ["changeSets", 1], None),
                  ("empty-record", ["changeSets", 0, "provenance", "importSnapshot"], {}),
                  ("missing-op", ["changeSets", 0, "operations"], [{}]),
                  ("null-op", ["changeSets", 0, "operations"], [None])]
        for adapter in vectors["initialRequests"]:
            for name, path, value in shapes:
                for operation in ("prepare", "baseline", "observations"):
                    entry = {"id": adapter + "/" + operation + "/" + name, "operation": operation,
                             "inputText": json_text({"adapter": adapter, "baseEdits": [{"path": path, "value": value}]})}
                    with self.subTest(entry=entry["id"]):
                        outcome = run_case(entry, vectors)
                        if operation == "observations" and name != "null-history":
                            self.assertEqual((outcome["kind"], outcome["value"]), ("return", True))
                        elif name == "null-history" or (operation == "baseline" and name == "null-op"):
                            self.assertEqual((outcome["kind"], outcome["name"]), ("throw", "TypeError"))
                        else:
                            prefix = "IMPORT_REVISION_BASELINE_" if operation == "prepare" else "IMPORT_BASELINE_"
                            self.assertEqual(outcome["code"], prefix + ("UNRECORDED" if name == "missing-op" else "INVALID"))
                        self.assertTrue(outcome["baseUnchanged"] and outcome["requestUnchanged"] and outcome["logicalBaseUnchanged"])

    def test_frozen_reference_cases(self):
        vectors = fixture()
        self.assertEqual(vectors["count"], 575)
        for entry in vectors["cases"]:
            with self.subTest(entry=entry["id"]):
                self.assertEqual(sha(entry["inputText"]), entry["inputSha256"])
                self.assertEqual(sha(json_text(entry["expected"])), entry["outputSha256"])
                self.assertEqual(run_case(entry, vectors), entry["expected"])

    def test_nonlogical_requests_reject(self):
        cyclic = {}
        cyclic["self"] = cyclic
        for value in (object(), cyclic, {"x": float("nan")}, {"x": "\ud800"}):
            with self.subTest(kind=type(value)), self.assertRaises(ValidationError) as caught:
                validate_import_snapshot_revision_request(value)
            self.assertEqual(caught.exception.code, "IMPORT_REVISION_REQUEST_INVALID")

    def test_probe_paths_cannot_escape_owned_root(self):
        vectors = fixture()
        for setup in ({"path": "../escaped"}, {"path": "/escaped"}, {"path": "alias", "kind": "link", "target": "../../escaped"}):
            with self.subTest(setup=setup), self.assertRaises(ValueError):
                run_case({"operation": "write", "inputText": json.dumps({"setup": [setup]})}, vectors)

    def test_candidate_and_recorded_snapshots_are_detached(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseSets"]["extended"])
            base = read_ledger_package(os.path.join(root, "base"))
            before = copy.deepcopy(base)
            request = copy.deepcopy(vectors["requests"]["extended"])
            prepared = prepare_import_snapshot_revision(base, request)
            self.assertEqual(prepared["candidateElement"]["extensions"]["owned/example"], {"keep": "retained", "nullable": None})
            prepared["candidateElement"]["extensions"]["morivyx.import/snapshot"]["snapshot"]["locator"] = "changed"
            self.assertEqual(prepared["changeSet"]["provenance"]["importSnapshot"]["snapshot"]["locator"], "source.txt")
            prepared["changeSet"]["provenance"]["previousImportSnapshot"]["snapshot"]["locator"] = "changed"
            self.assertEqual(base, before)
            self.assertEqual(request, vectors["requests"]["extended"])

    def test_failed_publish_removes_owned_staging(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseSets"]["repository"])
            before = tree_snapshot(root)
            with patch.object(package_apply.os, "rename", side_effect=OSError(errno.EIO, "owned injected rename failure")):
                with self.assertRaises(OSError):
                    asyncio.run(write_reimported_snapshot_package({"basePath": os.path.join(root, "base"),
                        "outputPath": os.path.join(root, "output"), "request": vectors["requests"]["repository"]}))
            self.assertEqual(tree_snapshot(root), before)

    def test_reread_mismatch_removes_staging(self):
        vectors = fixture()
        original = package_apply.read_ledger_package
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseSets"]["repository"])
            before = tree_snapshot(root)

            def changed(path):
                value = original(path)
                if os.path.basename(path).endswith(".tmp"):
                    value["elements"] = []
                return value
            with patch.object(package_apply, "read_ledger_package", side_effect=changed):
                with self.assertRaises(ValidationError) as caught:
                    asyncio.run(write_reimported_snapshot_package({"basePath": os.path.join(root, "base"),
                        "outputPath": os.path.join(root, "output"), "request": vectors["requests"]["repository"]}))
            self.assertEqual(caught.exception.code, "PACKAGE_OUTPUT_MISMATCH")
            self.assertEqual(tree_snapshot(root), before)

    def test_publish_collision_preserves_other_owners_output(self):
        vectors = fixture()
        original = os.mkdir
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseSets"]["repository"])
            output = os.path.join(root, "output")

            def collide(path, *args, **kwargs):
                if os.fspath(path) == output:
                    original(path, *args, **kwargs)
                    (Path(output) / "owner.txt").write_text("other owner\n")
                    raise FileExistsError(errno.EEXIST, "owned collision", path)
                return original(path, *args, **kwargs)
            with patch.object(package_apply.os, "mkdir", side_effect=collide):
                with self.assertRaises(ValidationError) as caught:
                    asyncio.run(write_reimported_snapshot_package({"basePath": os.path.join(root, "base"),
                        "outputPath": output, "request": vectors["requests"]["repository"]}))
            self.assertEqual(caught.exception.code, "PACKAGE_OUTPUT_EXISTS")
            self.assertEqual((Path(output) / "owner.txt").read_text(), "other owner\n")
            self.assertEqual(sorted(path.name for path in Path(root).iterdir()), ["base", "output"])


if __name__ == "__main__":
    if "--replay" in sys.argv or "--probes" in sys.argv:
        if "--isolated" in sys.argv:
            assert shutil.which("node") is None and shutil.which("git") is None
        vectors = fixture()
        entries = json.loads(sys.stdin.read()) if "--probes" in sys.argv else vectors["cases"]
        print(json.dumps([{"id": entry["id"], "outcome": run_case(entry, vectors)} for entry in entries], ensure_ascii=True))
    else:
        unittest.main()
