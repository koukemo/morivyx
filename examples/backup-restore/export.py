"""Export checked package records to a new JSON file; never overwrite a backup."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/portable-core"))
from package_records import read_package, write_package_files

LIMIT = 8 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="source .morivyx directory")
    parser.add_argument("backup", help="new JSON file; parent must exist")
    args = parser.parse_args()
    try:
        source_info = Path(args.directory).stat()
        output_parent = Path(args.backup).parent.resolve(strict=True)
        for parent in (output_parent, *output_parent.parents):
            info = parent.stat()
            if (info.st_dev, info.st_ino) == (source_info.st_dev, source_info.st_ino):
                print('{"error":{"code":"BACKUP_OUTPUT_IN_SOURCE"}}', file=sys.stderr)
                return 1
        package = read_package(args.directory)
        files = write_package_files(package)
        data = (json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(data) > LIMIT:
            raise ValueError("export exceeds the restoration example's input limit")
        descriptor = os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        result = {
            "backupCreated": True, "backupSha256": hashlib.sha256(data).hexdigest(),
            "backupBytes": len(data), "files": len(files),
            "graphRevision": package["revision"]["id"],
            "rootDigest": package["calculatedRootDigest"],
            "schemaLockDigest": package["calculatedSchemaLockDigest"],
        }
    except FileExistsError:
        print('{"error":{"code":"BACKUP_OUTPUT_EXISTS"}}', file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        print('{"error":{"code":"BACKUP_EXPORT_FAILED"}}', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
