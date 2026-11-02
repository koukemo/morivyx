"""Restore an explicitly pinned JSON export into a new package directory."""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/portable-core"))
from canonical import load_json
from package_restore import restore_package_files

LIMIT = 8 * 1024 * 1024


class ExampleError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def read_backup(path):
    if not all(hasattr(os, name) for name in ("O_NONBLOCK", "O_NOFOLLOW")):
        raise ExampleError("BACKUP_RUNTIME_UNSUPPORTED")
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= LIMIT:
            raise ExampleError("BACKUP_INPUT_INVALID")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(LIMIT + 1)
        after = os.fstat(descriptor)
        if (len(data) != before.st_size or
                (before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ExampleError("BACKUP_INPUT_CHANGED")
        return data
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", help="JSON export, at most 8 MiB")
    parser.add_argument("directory", help="new .morivyx directory; parent must exist")
    parser.add_argument("--sha256", required=True, help="trusted lowercase whole-file SHA-256")
    args = parser.parse_args()
    try:
        if re.fullmatch(r"[0-9a-f]{64}", args.sha256) is None:
            raise ExampleError("BACKUP_PIN_INVALID")
        data = read_backup(args.backup)
        digest = hashlib.sha256(data).hexdigest()
        if not hmac.compare_digest(digest, args.sha256):
            raise ExampleError("BACKUP_DIGEST_MISMATCH")
        files = load_json(data.decode("utf-8", errors="strict"))
        result = restore_package_files(files, args.directory)
        result["backupSha256"] = digest
    except (OSError, ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError) as error:
        allowed = {
            "BACKUP_PIN_INVALID", "BACKUP_INPUT_INVALID", "BACKUP_INPUT_CHANGED", "BACKUP_DIGEST_MISMATCH", "BACKUP_RUNTIME_UNSUPPORTED",
            "PACKAGE_RESTORE_INPUT_INVALID", "PACKAGE_RESTORE_TARGET_UNAVAILABLE", "PACKAGE_RESTORE_INCOMPLETE",
        }
        code = getattr(error, "code", "BACKUP_INPUT_INVALID")
        print(json.dumps({"error": {"code": code if code in allowed else "BACKUP_INPUT_INVALID"}}, separators=(",", ":")), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
