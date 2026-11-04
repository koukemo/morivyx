"""Compose public Python Core APIs to migrate into a new package directory.

No adoption authority, authenticated rules or implicit transformation is supplied.
"""

import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "portable-core"))
from canonical import load_json
from package_migration import FIELDS, plan_package_migration
from package_records import read_package_file_sources
from package_restore import restore_package_files
from stdin_transport import read_bounded_stdin

LIMIT = 8 * 1024 * 1024


class ExampleFailure(ValueError):
    def __init__(self, stage):
        super().__init__("migration example failed")
        self.stage = stage


def write_migration(source, destination, request):
    stage = "source"
    try:
        files = read_package_file_sources(source)
        stage = "plan"
        if type(request) is not dict or set(request) != FIELDS - {"sourceFiles"}:
            raise ValueError("invalid migration request")
        plan = plan_package_migration({**request, "sourceFiles": files})
        stage = "output"
        output = (json.dumps({"restored": True, **{key: value for key, value in plan.items() if key != "files"}},
                             ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(output) > LIMIT:
            raise ValueError("output exceeds limit")
        stage = "restore"
        source_info = os.stat(source, follow_symlinks=False)
        for parent in Path(destination).absolute().parents:
            try:
                parent_info = os.stat(parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if (parent_info.st_dev, parent_info.st_ino) == (source_info.st_dev, source_info.st_ino):
                raise ValueError("destination is inside the source package")
        restore_package_files(plan["files"], destination)
        return output
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, RecursionError, OverflowError):
        raise ExampleFailure(stage) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="existing package directory containing revision.yaml")
    parser.add_argument("destination", help="new package directory; its parent must exist")
    args = parser.parse_args()
    stage = "input"
    try:
        request = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        output = write_migration(args.source, args.destination, request)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, RecursionError, OverflowError) as error:
        stage = error.stage if isinstance(error, ExampleFailure) else stage
        print(json.dumps({"error": {"code": "EXAMPLE_MIGRATION_FAILED", "stage": stage}}, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
