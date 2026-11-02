"""Trace an explicitly selected, checked package without changing its files.

Record structure and digest checks do not validate whole-Graph semantics,
Schema definitions, authority, authenticity, or signatures.
"""

import argparse
import json
import sys

from canonical import digest, load_json
from package_records import read_package, read_package_files
from portable_cli import read_request_bytes
from trace_query import execute_trace_query


def _trace_checked(contents, request):
    if request is None:
        request = {}
    if type(request) is not dict:
        raise ValueError("trace request must be a mapping")
    report = execute_trace_query({**request,
        "graphRevision": contents["revision"]["id"],
        "schemaLockDigest": contents["revision"]["schemaLockDigest"],
        "elements": contents["elements"]})
    return {"valid": True, "digest": digest("trace-report", report)["digest"],
            "report": report, "validation": contents["validation"]}


def trace_package_files(files, request):
    return _trace_checked(read_package_files(files), request)


def trace_package(directory, request):
    return _trace_checked(read_package(directory), request)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="explicit package directory; read only")
    args = parser.parse_args(argv)
    try:
        request = load_json(read_request_bytes(sys.stdin.buffer).decode("utf-8", errors="strict"))
        result = trace_package(args.directory, request)
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError, KeyError, IndexError, OSError, OverflowError, RecursionError) as error:
        diagnostic = {"error": {"code": getattr(error, "code", "PACKAGE_TRACE_INPUT_INVALID"),
                                "path": getattr(error, "path", "/")}}
        print(json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
