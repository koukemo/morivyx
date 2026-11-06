"""Pre-implementation filesystem results and independent migration writer replay."""

import asyncio
from contextlib import ExitStack
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

import package_migration as writer
from canonical import canonical_json
from ledger_store import read_ledger_package


FIXTURE = Path(__file__).parent / "fixtures/package-migration-writer-vectors.json"
FIXTURE_HASH = "90e1ffd76d284176de463446ade3a3785ccee12639164d30c653424158069887"


def fixture():
    raw = FIXTURE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != FIXTURE_HASH:
        raise ValueError("migration writer fixture changed")
    value = json.loads(raw)
    if value["count"] != 194 or len(value["cases"]) != 194:
        raise ValueError("migration writer cases changed")
    return value


def tree(root):
    result = {}
    def walk(directory, prefix=""):
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            key, info = prefix + name, os.lstat(path)
            if stat.S_ISLNK(info.st_mode):
                result[key] = {"kind": "link", "target": os.readlink(path)}
            elif stat.S_ISDIR(info.st_mode):
                result[key] = {"kind": "directory", "mode": stat.S_IMODE(info.st_mode)}
                walk(path, key + "/")
            elif stat.S_ISREG(info.st_mode):
                result[key] = {"kind": "file", "bytes": info.st_size,
                    "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                    "mode": stat.S_IMODE(info.st_mode), "links": info.st_nlink}
            else:
                raise ValueError("unexpected fixture file kind")
    walk(root)
    return result


def owned(root, name):
    if type(name) is not str or os.path.isabs(name) or ".." in name.replace("\\", "/").split("/"):
        raise ValueError("unsafe fixture path")
    result = os.path.abspath(os.path.join(root, name))
    if os.path.commonpath((root, result)) != root:
        raise ValueError("fixture path escaped")
    return result


def run_case(spec, base_files):
    with tempfile.TemporaryDirectory(prefix="morivyx-migration-writer-") as temporary:
        root = os.path.realpath(temporary)
        base, output = os.path.join(root, "base"), os.path.join(root, "output")
        metadata = os.path.join(base, ".morivyx")
        cwd, mask = os.getcwd(), os.umask(0o022)
        temporary_names = []
        def normalize(value):
            if type(value) is str:
                value = value.replace(root, "ROOT")
                for name in temporary_names:
                    value = value.replace(name, ".output-TEMP.tmp")
                return value
            if type(value) is list:
                return [normalize(item) for item in value]
            if type(value) is dict:
                return {normalize(key): normalize(item) for key, item in value.items()}
            return value
        try:
            for name, source in base_files.items():
                path = owned(metadata, name)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                Path(path).write_text(source, encoding="utf-8")
            for mutation in spec.get("mutations", []):
                path = owned(metadata, mutation["path"])
                if mutation["kind"] == "remove":
                    if os.path.isdir(path) and not os.path.islink(path):
                        shutil.rmtree(path)
                    elif os.path.lexists(path):
                        os.unlink(path)
                else:
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    if mutation["kind"] == "write":
                        Path(path).write_text(mutation["source"], encoding="utf-8")
                    elif mutation["kind"] == "directory":
                        os.makedirs(path, exist_ok=True)
                    elif mutation["kind"] == "symlink":
                        owned(os.path.dirname(path), mutation["target"])
                        os.symlink(mutation["target"], path)
                    else:
                        raise ValueError("unknown fixture mutation")
            layout = spec.get("layout")
            if layout == "missing-base":
                shutil.rmtree(base)
            if layout in ("base-link", "output-alias-in-base"):
                os.symlink("base", os.path.join(root, "alias"))
            if layout == "output-directory":
                os.mkdir(output)
            if layout == "output-file":
                Path(output).write_text("owned-existing")
            if layout in ("output-link", "dangling-output"):
                os.symlink("base" if layout == "output-link" else "absent", output)
            if layout == "parent-file":
                Path(root, "parent-file").write_text("owned-parent")
            request = copy.deepcopy(spec["request"])
            if type(request) is dict:
                if not spec.get("omitBase"):
                    request["basePath"] = spec.get("baseValue", os.path.join(root, "alias") if layout == "base-link" else metadata if spec.get("baseMetadata") else base)
                if not spec.get("omitOutput"):
                    request["outputPath"] = spec.get("outputValue", "output" if spec.get("outputRelative") else
                        os.path.join(base, "nested") if layout == "output-inside" else
                        os.path.join(root, ".morivyx") if layout == "metadata-output" else
                        os.path.join(root, "parent-file", "output") if layout == "parent-file" else
                        os.path.join(root, "alias", "output") if layout == "output-alias-in-base" else output)
            os.chdir(root)
            os.umask(spec.get("umask", 0o022))
            before, input_before = tree(root), copy.deepcopy(request)
            faults, injected, published = [], 0, False
            originals = {"mkdir": os.mkdir, "cp": shutil.copytree, "open": os.open,
                         "rename": os.rename, "rm": shutil.rmtree, "readdir": writer.read_ledger_package}
            def wrapper(key):
                def call(*args, **kwargs):
                    nonlocal injected, published
                    path = os.fspath(args[0]) if isinstance(args[0], (str, os.PathLike)) else ""
                    name = os.path.basename(path)
                    is_stage = os.path.dirname(path) == root and re.fullmatch(r"\.output-\d+-[0-9a-f-]{36}\.tmp", name) is not None
                    if key == "mkdir" and is_stage and name not in temporary_names:
                        temporary_names.append(name)
                    staged = any(path == os.path.join(root, n) or path.startswith(os.path.join(root, n) + os.sep) for n in temporary_names)
                    fault = spec.get("fault")
                    fail = ((fault == "mkdir-stage" and key == "mkdir" and is_stage) or
                        (fault == "copy" and key == "cp") or
                        (fault == "write-record" and key == "open" and staged and "/graph/" in path) or
                        (fault == "readback" and key == "readdir" and staged) or
                        (fault == "rename-publish" and key == "rename") or
                        (fault in ("remove-stage-after-publish", "remove-stage-twice") and key == "rm" and is_stage and published))
                    if fail and injected < (2 if fault == "remove-stage-twice" else 1):
                        injected += 1
                        failure_path = os.path.join(path, ".morivyx") if key == "readdir" else path
                        faults.append({"operation": key, "path": failure_path})
                        raise PermissionError(errno.EACCES, "owned fixture fault", failure_path)
                    result = originals[key](*args, **kwargs)
                    if key == "rename":
                        published = True
                    return result
                return call
            with ExitStack() as stack:
                for key, target in (("mkdir", "os.mkdir"), ("cp", "shutil.copytree"), ("open", "os.open"),
                                    ("rename", "os.rename"), ("rm", "shutil.rmtree"), ("readdir", "package_migration.read_ledger_package")):
                    stack.enter_context(patch(target, wrapper(key)))
                try:
                    pending = writer.write_migrated_package(request)
                    after_call = spec.get("afterCall")
                    if after_call == "root-output-replaced":
                        request["outputPath"] = os.path.join(root, "replacement")
                    if after_call == "root-record-replaced":
                        request["migration"] = None
                    if after_call == "root-candidates-replaced":
                        request["candidateElements"] = []
                    if after_call == "nested-record-changed":
                        request["migration"]["targetSchemaLockDigest"] = "sha256:" + "a" * 64
                    if after_call == "nested-candidate-changed":
                        request["candidateElements"][0]["revision"] = "sha256:" + "b" * 64
                    input_before = copy.deepcopy(request)
                    outcome = {"ok": True, "result": asyncio.run(pending)}
                except Exception as error:
                    outcome = {"ok": False, "code": getattr(error, "code", errno.errorcode.get(error.errno) if isinstance(error, OSError) else None),
                               "path": getattr(error, "path", error.filename if isinstance(error, OSError) else None)}
            if request != input_before:
                raise AssertionError("writer changed request")
            reread = None
            if outcome["ok"]:
                contents = read_ledger_package(outcome["result"]["outputPath"])
                projection = {key: value for key, value in contents.items() if key != "directory"}
                reread = {"sha256": hashlib.sha256(canonical_json(projection).encode()).hexdigest(),
                    "counts": {key: len(contents[key]) for key in ("elements", "approvals", "changeSets", "migrations", "reports")}}
            return normalize({"outcome": outcome, "inputUnchanged": True, "before": before,
                              "after": tree(root), "reread": reread, "faults": faults})
        finally:
            os.chdir(cwd)
            os.umask(mask)


def first_difference(left, right, path=""):
    if type(left) is not type(right):
        return path + ": different types"
    if type(left) is dict:
        if left.keys() != right.keys():
            return path + ": keys " + repr(sorted(set(left) ^ set(right)))
        for key in left:
            difference = first_difference(left[key], right[key], path + "/" + key)
            if difference:
                return difference
    elif type(left) is list:
        if len(left) != len(right):
            return path + ": different lengths"
        for index, (a, b) in enumerate(zip(left, right)):
            difference = first_difference(a, b, path + "/" + str(index))
            if difference:
                return difference
    elif left != right:
        return path + ": " + repr(left)[:180] + " != " + repr(right)[:180]
    return None


class MigrationWriterTests(unittest.TestCase):
    def test_fixture_pinned(self):
        self.assertEqual(fixture()["referenceCommit"], "5734288be9de9b8cbfb65cd1972ad866cf110be2")

    def test_all_preimplementation_results(self):
        value = fixture()
        for case in value["cases"]:
            with self.subTest(case=case["id"]):
                actual = run_case(case["input"], value["baseFiles"])
                self.assertIsNone(first_difference(actual, case["expected"]), case["id"] + ": " + str(first_difference(actual, case["expected"])))

    def test_root_capture_and_nested_reference_timing(self):
        value = fixture()
        for after_call in ("root-output-replaced", "root-record-replaced", "root-candidates-replaced"):
            actual = run_case({"request": value["template"], "afterCall": after_call}, value["baseFiles"])
            self.assertTrue(actual["outcome"]["ok"], after_call)
            self.assertEqual(actual["outcome"]["result"]["outputPath"], "ROOT/output")
        for after_call in ("nested-record-changed", "nested-candidate-changed"):
            self.assertFalse(run_case({"request": value["template"], "afterCall": after_call}, value["baseFiles"])["outcome"]["ok"], after_call)

    def test_competing_awaitables_preserve_source_and_publish_once(self):
        value = fixture()
        with tempfile.TemporaryDirectory(prefix="morivyx-migration-competing-") as temporary:
            root = os.path.realpath(temporary)
            base, output = os.path.join(root, "base"), os.path.join(root, "output")
            for name, source in value["baseFiles"].items():
                path = owned(os.path.join(base, ".morivyx"), name)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                Path(path).write_text(source, encoding="utf-8")
            before = tree(base)
            request = {**copy.deepcopy(value["template"]), "basePath": base, "outputPath": output}
            async def compete():
                return await asyncio.gather(writer.write_migrated_package(request), writer.write_migrated_package(request), return_exceptions=True)
            results = asyncio.run(compete())
            self.assertEqual(sum(type(result) is dict and result.get("valid") is True for result in results), 1)
            errors = [result for result in results if isinstance(result, BaseException)]
            self.assertEqual(len(errors), 1)
            self.assertEqual(getattr(errors[0], "code", None), "PACKAGE_OUTPUT_EXISTS")
            self.assertEqual(tree(base), before)
            self.assertEqual(read_ledger_package(output)["revision"]["id"], value["template"]["resultingRevision"]["id"])
            self.assertEqual(sorted(os.listdir(root)), ["base", "output"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        value = json.loads(sys.stdin.read())
        print(json.dumps(run_case(value["spec"], value["baseFiles"]), ensure_ascii=False))
    elif sys.argv[1:] == ["--replay"]:
        value = fixture()
        print(json.dumps([{"id": case["id"], **run_case(case["input"], value["baseFiles"])} for case in value["cases"]], ensure_ascii=False))
    else:
        unittest.main()
