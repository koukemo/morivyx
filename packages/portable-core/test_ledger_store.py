"""Frozen Node filesystem outcomes and independent ledger operation checks."""

import copy
import errno
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ledger_store
from canonical import canonical_json
from ledger_store import read_ledger_package, write_approval, write_change_set, write_migration
from schema_validation import ValidationError
from yaml_records import MAX_BYTES, read_yaml, write_yaml


FIXTURE = Path(__file__).parent / "fixtures/ledger-store-vectors.json"
FIXTURE_HASH = "0e7374160de9d9b90f2f9497f9c87b469cd89b56b61cd75b81a4cca4e77f5637"
FUNCTIONS = {"approval": write_approval, "change": write_change_set, "migration": write_migration, "read": read_ledger_package}


def fixture():
    data = FIXTURE.read_bytes()
    if hashlib.sha256(data).hexdigest() != FIXTURE_HASH:
        raise ValueError("frozen ledger fixture changed")
    result = json.loads(data)
    if result["count"] != len(result["cases"]) or result["count"] != 156:
        raise ValueError("frozen ledger cases missing")
    return result


def expanded_record(spec):
    record = json.loads(spec["recordText"], parse_int=lambda text: -0.0 if text == "-0" else int(text)) if "recordText" in spec else copy.deepcopy(spec["record"])
    expansion = spec.get("expand", {})
    if expansion.get("kind") == "operation":
        record["operation"] = "x" * expansion["length"]
    if expansion.get("kind") == "nested":
        value = "leaf"
        for _ in range(expansion["depth"]):
            value = [value]
        record["provenance"]["extra"] = value
    return record


def normalize(value, root):
    if type(value) is str:
        value = "ROOT" + value[len(root):] if value.startswith(root) else value
        return re.sub(r"/\.record-[0-9]+-[0-9a-f-]{36}\.tmp", "/.record-TEMP.tmp", value)
    if type(value) is list:
        return [normalize(item, root) for item in value]
    if type(value) is dict:
        return {key: normalize(item, root) for key, item in value.items()}
    return value


def tree_snapshot(root):
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
                result[key] = {"kind": "fifo" if stat.S_ISFIFO(info.st_mode) else "special", "mode": stat.S_IMODE(info.st_mode)}
    walk(root)
    return result


def case_path(root, parent, name):
    if type(name) is not str or os.path.isabs(name) or ".." in name.replace("\\", "/").split("/"):
        raise ValueError("unsafe fixture path")
    path = os.path.abspath(os.path.join(parent, name))
    if os.path.commonpath((root, path)) != root:
        raise ValueError("fixture escaped owned root")
    return path


def parents(root, path):
    current = root
    for part in Path(os.path.relpath(os.path.dirname(path), root)).parts:
        current = os.path.join(current, part)
        try:
            os.mkdir(current)
        except FileExistsError:
            pass
        if not stat.S_ISDIR(os.lstat(current).st_mode):
            raise ValueError("fixture parent is not an ordinary directory")


def create_base(root, base_files, layout=None):
    base = os.path.join(root, "package") if layout in ("nested", "ancestor-link") else root
    metadata = os.path.join(base, ".morivyx")
    for name, source in base_files.items():
        path = case_path(root, metadata, name)
        parents(root, path)
        Path(path).write_text(source, encoding="utf-8")
    return base, metadata


def run_case(spec, base_files):
    with tempfile.TemporaryDirectory(prefix="morivyx-python-ledger-") as root:
        root = os.path.realpath(root)
        previous, mask = os.getcwd(), os.umask(0o022)
        try:
            base, metadata = create_base(root, base_files, spec.get("layout"))
            argument = base
            layout = spec.get("layout")
            if layout == "missing":
                shutil.rmtree(metadata)
            if layout == "metadata-file":
                shutil.rmtree(metadata)
                Path(metadata).write_text("owned")
            if layout == "metadata-link":
                os.rename(metadata, os.path.join(root, "owned-metadata"))
                os.symlink("owned-metadata", metadata)
            if layout == "ancestor-link":
                os.symlink("package", os.path.join(root, "alias"))
                argument = os.path.join(root, "alias")
            for mutation in spec.get("mutations", []):
                path = case_path(root, metadata, mutation["path"])
                kind = mutation["kind"]
                if kind == "remove":
                    if os.path.isdir(path) and not os.path.islink(path):
                        shutil.rmtree(path)
                    elif os.path.lexists(path):
                        os.unlink(path)
                    continue
                parents(root, path)
                if kind == "write":
                    Path(path).write_text(mutation["source"], encoding="utf-8")
                elif kind == "bytes":
                    Path(path).write_bytes(bytes.fromhex(mutation["hex"]))
                elif kind == "directory":
                    os.makedirs(path, exist_ok=True)
                elif kind == "symlink":
                    target = os.path.abspath(os.path.join(os.path.dirname(path), mutation["target"]))
                    if os.path.commonpath((root, target)) != root:
                        raise ValueError("fixture symlink escaped root")
                    os.symlink(mutation["target"], path)
                elif kind == "hardlink":
                    os.link(case_path(root, metadata, mutation["target"]), path)
                elif kind == "fifo":
                    os.mkfifo(path)
                else:
                    raise ValueError("invalid fixture mutation")
            record = expanded_record(spec)
            before_record = copy.deepcopy(record)
            if spec.get("busy"):
                path = os.path.join(metadata, ".record-id-" + record["id"][9:] + ".lock")
                handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(handle, "wb") as stream:
                    stream.write(b"owned-busy")
            os.chdir(root)
            mode = spec.get("pathMode")
            if mode == "metadata":
                argument = metadata
            elif mode == "relative":
                argument = os.path.relpath(base, root)
            elif mode == "parent":
                argument = "unused/../"
            elif mode == "value":
                argument = spec["pathValue"]
            os.umask(spec.get("umask", 0o022))
            reread = None
            try:
                function = FUNCTIONS[spec["operation"]]
                result = function(argument) if spec["operation"] == "read" else function(argument, record)
                outcome = {"ok": True, "result": normalize(result, root)}
                if spec["operation"] != "read":
                    package = read_ledger_package(argument)
                    projection = {key: value for key, value in package.items() if key != "directory"}
                    reread = {"valid": True, "sha256": hashlib.sha256(canonical_json(projection).encode()).hexdigest(),
                              "counts": {key: len(package[key]) for key in ("elements", "approvals", "changeSets", "migrations", "reports")}}
            except (ValueError, TypeError, OSError) as error:
                outcome = {"ok": False, "code": getattr(error, "code", None), "path": normalize(getattr(error, "path", None), root)}
            if record != before_record:
                raise AssertionError("input record mutated")
            return {"outcome": outcome, "reread": reread, "tree": tree_snapshot(root)}
        finally:
            os.chdir(previous)
            os.umask(mask)


class LedgerStoreTests(unittest.TestCase):
    def test_frozen_filesystem_results(self):
        vectors = fixture()
        for entry in vectors["cases"]:
            with self.subTest(case=entry["id"]):
                self.assertEqual(run_case(entry["input"], vectors["baseFiles"]), entry["expected"])

    def test_original_yaml_limits_remain_and_explicit_options_work(self):
        vectors = fixture()
        record = copy.deepcopy(vectors["templates"]["approval"])
        record["operation"] = "x" * (MAX_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "too large"):
            write_yaml(record)
        source = write_yaml(record, max_bytes=None, max_depth=None)
        with self.assertRaises(ValueError):
            read_yaml(source)
        self.assertEqual(read_yaml(source, max_bytes=None, max_depth=None), record)
        record = copy.deepcopy(vectors["templates"]["change"])
        value = "leaf"
        for _ in range(140):
            value = [value]
        record["provenance"]["extra"] = value
        with self.assertRaisesRegex(ValueError, "too deep"):
            write_yaml(record)
        source = write_yaml(record, max_bytes=None, max_depth=None)
        with self.assertRaisesRegex(ValueError, "too deep"):
            read_yaml(source)
        self.assertEqual(read_yaml(source, max_bytes=None, max_depth=None), record)

    def test_fsync_failure_cleans_lock_and_temporary_without_publishing(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            before = tree_snapshot(root)
            with patch.object(ledger_store.os, "fsync", side_effect=OSError(errno.EIO, "injected sync failure")):
                with self.assertRaises(OSError):
                    write_change_set(root, copy.deepcopy(vectors["templates"]["change"]))
            self.assertEqual(tree_snapshot(root), before)

    def test_link_failure_cleans_owned_files_without_changing_existing_records(self):
        vectors = fixture()
        with tempfile.TemporaryDirectory() as root:
            create_base(root, vectors["baseFiles"])
            before = tree_snapshot(root)
            with patch.object(ledger_store.os, "link", side_effect=OSError(errno.EIO, "injected link failure")):
                with self.assertRaises(OSError):
                    write_migration(root, copy.deepcopy(vectors["templates"]["migration"]))
            self.assertEqual(tree_snapshot(root), before)

    def test_real_child_writers_share_id_lock_across_record_types(self):
        vectors = fixture()
        for other in ("approval", "change", "migration"):
            with self.subTest(other=other), tempfile.TemporaryDirectory() as root:
                create_base(root, vectors["baseFiles"])
                first = copy.deepcopy(vectors["templates"]["approval"])
                second = copy.deepcopy(vectors["templates"][other])
                second["id"] = first["id"]
                children = [subprocess.Popen([sys.executable, __file__, "--write", operation, root],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            text=True, encoding="utf-8") for operation in ("approval", other)]
                for child, record in zip(children, (first, second)):
                    child.stdin.write(json.dumps(record))
                    child.stdin.close()
                    child.stdin = None
                outcomes = []
                try:
                    for child in children:
                        stdout, stderr = child.communicate(timeout=15)
                        self.assertEqual(child.returncode, 0, stderr)
                        outcomes.append(json.loads(stdout))
                finally:
                    for child in children:
                        if child.poll() is None:
                            child.kill()
                            child.wait()
                self.assertEqual(sum(result["ok"] for result in outcomes), 1, outcomes)
                failure = next(result for result in outcomes if not result["ok"])
                self.assertEqual(failure["code"], "APPROVAL_ALREADY_EXISTS" if other == "approval" else "ID_DUPLICATE")
                package = read_ledger_package(root)
                self.assertEqual(sum(record["id"] == first["id"] for field in ("approvals", "changeSets", "migrations") for record in package[field]), 1)
                self.assertFalse(any(".record-" in path for path in tree_snapshot(root)))


if __name__ == "__main__":
    if sys.argv[1:2] == ["--one"]:
        print(json.dumps(run_case(json.loads(sys.stdin.read()), fixture()["baseFiles"]), ensure_ascii=True))
    elif sys.argv[1:2] == ["--replay"]:
        vectors = fixture()
        if "--isolated" in sys.argv:
            if shutil.which("node") is not None or shutil.which("git") is not None:
                raise AssertionError("isolated runtime contains Node or Git")
        print(json.dumps([{"id": entry["id"], **run_case(entry["input"], vectors["baseFiles"])} for entry in vectors["cases"]], ensure_ascii=True))
    elif sys.argv[1:2] in (["--write"], ["--write-ready"]):
        if sys.argv[1] == "--write-ready":
            print("READY", flush=True)
        record = json.loads(sys.stdin.read())
        try:
            result = {"ok": True, "result": FUNCTIONS[sys.argv[2]](sys.argv[3], record)}
        except (ValueError, TypeError, OSError) as error:
            result = {"ok": False, "code": getattr(error, "code", None), "path": getattr(error, "path", None)}
        print(json.dumps(result, ensure_ascii=True))
    else:
        unittest.main()
