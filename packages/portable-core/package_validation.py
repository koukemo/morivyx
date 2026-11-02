"""Independent package records, explicit Schema bindings and Graph constraints."""

import argparse
import json
import sys

from graph_validation import validate_graph
from package_records import read_package, read_package_files
from schema_registry import resolve_schema_registry


def _validate_checked_contents(contents, previous_contents=None):
    registry = resolve_schema_registry(contents["schemaLock"], contents["schemaSources"])
    result = validate_graph(
        graph_revision=contents["revision"]["id"],
        schema_lock_digest=contents["calculatedSchemaLockDigest"],
        schemas=list(registry["schemas"].values()),
        elements=contents["elements"], approvals=contents["approvals"],
        registry_issues=registry["issues"],
        previous_elements=previous_contents["elements"] if previous_contents is not None else None,
    )
    result["validation"] = {
        "scope": "package-records-schema-and-graph-constraints",
        "recordStructuresValidated": True,
        "recordAuthoringValidated": True,
        "recordDigestsValidated": True,
        "approvalLedgerValidated": True,
        "migrationBindingsValidated": True,
        "reportsValidated": True,
        "schemaLockBindingValidated": not registry["issues"],
        "graphConstraintsValidated": not registry["issues"],
        "approvalAuthorityValidated": False,
        "signaturesValidated": False,
        "packageValidated": False,
    }
    if previous_contents is not None:
        result["validation"].update({
            "previousGraphRevision": previous_contents["revision"]["id"],
            "previousRootDigest": previous_contents["revision"]["rootDigest"],
            "previousRecordStructuresValidated": True,
            "previousRecordDigestsValidated": True,
            "previousSchemaLockBindingValidated": False,
            "lifecycleTransitionsCompared": not registry["issues"],
            "historyAncestryValidated": False,
        })
    return result


def validate_package_files(files, *, previous_files=None):
    """Check the supported file mapping, with no implicit Schema or filesystem I/O.

    valid describes this scope's diagnostics, not signatures, authority or full
    YAML syntax compatibility. Malformed records raise before producing output.
    Optional prior records feed lifecycle rules; their Schema meaning and
    ancestry are not authenticated by this comparison.
    """
    previous = read_package_files(previous_files) if previous_files is not None else None
    return _validate_checked_contents(read_package_files(files), previous)


def validate_package(directory, *, previous_directory=None):
    """Read explicit current/prior directories with bounded no-follow I/O."""
    previous = read_package(previous_directory) if previous_directory is not None else None
    return _validate_checked_contents(read_package(directory), previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="explicit package directory containing revision.yaml")
    parser.add_argument("--previous", help="explicit prior package; checks records, not ancestry or prior Schema meaning")
    args = parser.parse_args()
    try:
        result = validate_package(args.directory, previous_directory=args.previous)
    except (ValueError, TypeError, KeyError, OSError, RecursionError):
        print("package validation failed; no result produced", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
