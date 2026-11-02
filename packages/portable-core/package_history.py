"""Inspect one explicit parent-linked package chain without acquiring history.

Parent labels are declarations, not authenticated Git history or approval.
Every supplied snapshot must validate before any lifecycle comparison is used.
"""

import json
import sys

from canonical import load_json
from package_records import read_package_files
from package_validation import _validate_checked_contents
from portable_cli import read_request_bytes


class PackageHistoryError(ValueError):
    def __init__(self, suffix, path="/"):
        self.code, self.path = "PACKAGE_HISTORY_" + suffix, path
        super().__init__(self.code)


def fail(suffix, path="/"):
    raise PackageHistoryError(suffix, path)


def inspect_package_history(value):
    """Return root-to-tip checks for exactly the supplied complete linear chain.

    Record, Schema or standalone Graph errors reject the request. A disallowed
    lifecycle edge returns valid=False with the existing Graph diagnostics.
    This does not authenticate the declared parent relation or apply Migration.
    """
    if (type(value) is not dict or set(value) != {"tipRevision", "packages"}
            or type(value["tipRevision"]) is not str or not value["tipRevision"].startswith("graph:")
            or type(value["packages"]) is not list or not 1 <= len(value["packages"]) <= 128):
        fail("INPUT_INVALID")
    count, total = 0, 0
    for index, files in enumerate(value["packages"]):
        path = "/packages/" + str(index)
        if type(files) is not dict or any(type(p) is not str or type(s) is not str for p, s in files.items()):
            fail("PACKAGE_INVALID", path)
        count += len(files)
        if count > 4096:
            fail("LIMIT_EXCEEDED")
        for name, source in files.items():
            if len(name) > 4096:
                fail("PACKAGE_INVALID", path)
            try:
                if len(name.encode("utf-8", errors="strict")) > 4096:
                    fail("PACKAGE_INVALID", path)
                size = len(source.encode("utf-8", errors="strict"))
            except UnicodeError:
                fail("PACKAGE_INVALID", path)
            total += size
            if size > 1024 * 1024 or total > 64 * 1024 * 1024:
                fail("LIMIT_EXCEEDED")
    snapshots, schema_bindings = {}, {}
    for index, files in enumerate(value["packages"]):
        path = "/packages/" + str(index)
        try:
            contents = read_package_files(files)
            checked = _validate_checked_contents(contents)
        except (ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError):
            fail("PACKAGE_INVALID", path)
        if checked["valid"] is not True:
            fail("PACKAGE_INVALID", path)
        for schema in contents["schemaLock"]["schemas"]:
            key = (schema["schemaId"], schema["version"])
            if key in schema_bindings and schema_bindings[key] != schema["digest"]:
                fail("SCHEMA_CONFLICT", path)
            schema_bindings[key] = schema["digest"]
        identity = contents["revision"]["id"]
        if identity in snapshots:
            fail("DUPLICATE_REVISION", path)
        snapshots[identity] = contents
    ordered, seen, identity = [], set(), value["tipRevision"]
    while identity is not None:
        if identity in seen:
            fail("CYCLE", "/packages")
        if identity not in snapshots:
            fail("MISSING_REVISION", "/packages")
        seen.add(identity)
        contents = snapshots[identity]
        ordered.append(contents)
        identity = contents["revision"]["parentRevision"]
    if len(seen) != len(snapshots):
        fail("UNUSED_SNAPSHOT", "/packages")
    entries, previous = [], None
    for contents in reversed(ordered):
        checked = _validate_checked_contents(contents, previous) if previous is not None else None
        comparison = ({k: checked[k] for k in ("valid", "graphRevision", "schemaLockDigest", "rootDigest", "issues")}
                      if checked is not None else None)
        entries.append({**contents["revision"], "comparison": comparison})
        previous = contents
    return {"valid": all(e["comparison"] is None or e["comparison"]["valid"] for e in entries),
            "tipRevision": value["tipRevision"], "entries": entries,
            "checks": {"declaredParentChainComplete": True, "allSuppliedSnapshotsUsed": True,
                       "eachSchemaAndGraphValidatedWithoutPrior": True,
                       "immutableSchemaBindingsAcrossSnapshots": True, "comparedEdges": len(entries) - 1,
                       "actualHistoryAuthenticated": False, "migrationPlansValidated": False,
                       "adoptionAuthorityValidated": False, "signaturesValidated": False}}


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if args:
            fail("INPUT_INVALID")
        try:
            raw = read_request_bytes(sys.stdin.buffer)
        except ValueError:
            fail("LIMIT_EXCEEDED")
        value = load_json(raw.decode("utf-8", errors="strict"))
        result = inspect_package_history(value)
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError, KeyError, IndexError, OSError, OverflowError, RecursionError) as error:
        known = isinstance(error, PackageHistoryError)
        print(json.dumps({"error": {"code": error.code if known else "PACKAGE_HISTORY_INPUT_INVALID",
                                   "path": error.path if known else "/"}}, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
