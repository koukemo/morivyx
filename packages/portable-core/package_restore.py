"""Restore checked file contents into a new directory; never replace existing data."""

import argparse
import json
import os
from pathlib import PurePath
import stat
import sys

from canonical import load_json
from package_records import _directory_flags, _open_directory, read_package_files
from portable_cli import read_request_bytes


INCOMPLETE = ".morivyx-restore-incomplete"


class RestoreError(ValueError):
    def __init__(self, code):
        super().__init__("package restore failed; no existing output was replaced")
        self.code = code


def _stamp(value):
    return value.st_dev, value.st_ino


def _named_directory(parent, name, descriptor):
    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(current.st_mode) or _stamp(current) != _stamp(os.fstat(descriptor)):
        raise OSError("output directory changed")


def _write_file(parent, name, source):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK
    handle = os.open(name, flags, 0o600, dir_fd=parent)
    try:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != 0:
            raise OSError("output is not a new regular file")
        remaining = memoryview(source)
        while remaining:
            written = os.write(handle, remaining)
            if written <= 0:
                raise OSError("output write did not advance")
            remaining = remaining[written:]
        after = os.fstat(handle)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if after.st_nlink != 1 or after.st_size != len(source) or _stamp(current) != _stamp(after):
            raise OSError("output file changed")
    finally:
        os.close(handle)


def _check_file(parent, name, expected):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != len(expected):
            raise OSError("restored file shape mismatch")
        content = bytearray()
        while len(content) <= len(expected):
            chunk = os.read(handle, min(65536, len(expected) + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        after = os.fstat(handle)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        fields = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if bytes(content) != expected or fields(before) != fields(after) or fields(current) != fields(after):
            raise OSError("restored file contents changed")
    finally:
        os.close(handle)


def restore_package_files(files, directory):
    """Check the mapping before creation, preserve bytes and leave failed output marked.

    The self-referencing marker link is never followed. Both readers reject it,
    including readers that ignore unknown ordinary metadata files.
    No atomic publication, hostile concurrent-writer exclusion or power-loss
    durability is claimed. The caller must protect the output parent.
    """
    if type(files) is not dict:
        raise ValueError("package files must be a mapping")
    owned = dict(files)
    contents = read_package_files(owned)
    sources = {name: source.encode("utf-8") if type(source) is str else source for name, source in owned.items()}
    receipt = {"restored": True, "filesWritten": len(sources), "bytesWritten": sum(map(len, sources.values())),
               "revision": contents["revision"]["id"], "rootDigest": contents["calculatedRootDigest"],
               "schemaLockDigest": contents["calculatedSchemaLockDigest"], "validation": contents["validation"]}
    # Validate the CLI receipt encoding before creating output, too.
    json.dumps(receipt, ensure_ascii=False, allow_nan=False).encode("utf-8")
    target = PurePath(directory)
    if not target.name or ".." in target.parts:
        raise RestoreError("PACKAGE_RESTORE_TARGET_UNAVAILABLE")
    parent = None
    directories = {}
    marker = None
    created = False
    try:
        # Capability and all parent components are checked before creating output.
        flags = _directory_flags()
        parent = _open_directory(target.parent)
        os.mkdir(target.name, 0o700, dir_fd=parent)
        created = True
        root = os.open(target.name, flags, dir_fd=parent)
        directories[""] = root
        os.symlink(INCOMPLETE, INCOMPLETE, dir_fd=root)
        marker = os.stat(INCOMPLETE, dir_fd=root, follow_symlinks=False)
        expected = {"": {INCOMPLETE}}
        needed = set()
        for name in sources:
            parts = PurePath(name).parts
            for index in range(1, len(parts)):
                needed.add("/".join(parts[:index]))
        for name in sorted(needed, key=lambda value: (value.count("/"), value)):
            path = PurePath(name)
            prefix = str(path.parent) if str(path.parent) != "." else ""
            owner = directories[prefix]
            os.mkdir(path.name, 0o700, dir_fd=owner)
            directories[name] = os.open(path.name, flags, dir_fd=owner)
            expected.setdefault(prefix, set()).add(path.name)
            expected[name] = set()
        for name, source in sorted(sources.items()):
            path = PurePath(name)
            prefix = str(path.parent) if str(path.parent) != "." else ""
            _write_file(directories[prefix], path.name, source)
            expected[prefix].add(path.name)
        for name, descriptor in directories.items():
            if set(os.listdir(descriptor)) != expected[name]:
                raise OSError("unexpected restored entry")
            if name:
                path = PurePath(name)
                prefix = str(path.parent) if str(path.parent) != "." else ""
                _named_directory(directories[prefix], path.name, descriptor)
        for name, source in sorted(sources.items()):
            path = PurePath(name)
            prefix = str(path.parent) if str(path.parent) != "." else ""
            _check_file(directories[prefix], path.name, source)
        _named_directory(parent, target.name, root)
        current = os.stat(INCOMPLETE, dir_fd=root, follow_symlinks=False)
        if not stat.S_ISLNK(current.st_mode) or _stamp(current) != _stamp(marker) or os.readlink(INCOMPLETE, dir_fd=root) != INCOMPLETE:
            raise OSError("incomplete marker was modified")
        os.unlink(INCOMPLETE, dir_fd=root)
        return receipt
    except (OSError, ValueError, TypeError):
        code = "PACKAGE_RESTORE_INCOMPLETE" if created else "PACKAGE_RESTORE_TARGET_UNAVAILABLE"
        raise RestoreError(code) from None
    finally:
        for descriptor in reversed(list(directories.values())):
            os.close(descriptor)
        if parent is not None:
            os.close(parent)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="new package directory; its parent must already exist")
    args = parser.parse_args(argv)
    try:
        files = load_json(read_request_bytes(sys.stdin.buffer).decode("utf-8", errors="strict"))
        result = restore_package_files(files, args.directory)
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError, KeyError, IndexError, OSError, OverflowError, RecursionError) as error:
        code = getattr(error, "code", "PACKAGE_RESTORE_INPUT_INVALID")
        if code not in {"PACKAGE_RESTORE_INPUT_INVALID", "PACKAGE_RESTORE_TARGET_UNAVAILABLE", "PACKAGE_RESTORE_INCOMPLETE"}:
            code = "PACKAGE_RESTORE_INPUT_INVALID"
        print(json.dumps({"error": {"code": code, "path": "/"}}, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
