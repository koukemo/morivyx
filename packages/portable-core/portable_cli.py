"""Invoke existing independent functions with bounded JSON on standard input.

No data files, environment credentials, clocks, network or child processes are
used. Apply operations calculate values and do not authorize or persist changes.
"""

import argparse
import json
import sys

from approval_assessment import UNSET, assess_approvals
from canonical import digest, load_json
from changeset_apply import apply_change_set
from external_comparison import compare_external_artifact_reference
from graph_index import build_graph_index, graph_index_snapshot
from graph_validation import validate_graph
from migration_apply import apply_migration
from package_records import read_package_files, write_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from semantic_diff import create_migration_semantic_diff, create_semantic_diff
from stdin_transport import read_bounded_stdin
from trace_query import execute_trace_query
from yaml_authoring import read_authoring_yaml


MAX_REQUEST_BYTES = 8 * 1024 * 1024
VALIDATION_COMMANDS = {"validate-graph", "validate-package"}


def mapping(value):
    if type(value) is not dict:
        raise ValueError("expected request mapping")
    return value


def calculate_digest(value):
    value = mapping(value)
    return digest(value["kind"], value["value"])


def validate_graph_request(value):
    value = mapping(value)
    return validate_graph(graph_revision=value["graphRevision"], schema_lock_digest=value["schemaLockDigest"],
                          schemas=value["schemas"], elements=value["elements"], registry_issues=value.get("registryIssues"),
                          previous_elements=value.get("previousElements"), approvals=value.get("approvals"))


def validate_package_request(value):
    value = mapping(value)
    return validate_package_files(value["files"], previous_files=value.get("previousFiles"))


def assess_request(value):
    value = mapping(value)
    return assess_approvals(value.get("approvals", UNSET), value.get("context", UNSET))


OPERATIONS = {
    "digest": calculate_digest,
    "read-yaml": read_authoring_yaml,
    "read-report": read_report_source,
    "serialize-report": serialize_report_yaml,
    "read-package": read_package_files,
    "export-package": lambda value: write_package_files(read_package_files(value)),
    "validate-package": validate_package_request,
    "validate-graph": validate_graph_request,
    "index": lambda value: graph_index_snapshot(build_graph_index(value)),
    "trace": execute_trace_query,
    "diff": create_semantic_diff,
    "migration-diff": create_migration_semantic_diff,
    "apply-changeset": apply_change_set,
    "apply-migration": apply_migration,
    "compare-external": compare_external_artifact_reference,
    "assess-approvals": assess_request,
}


def read_request_bytes(stream):
    return read_bounded_stdin(stream, MAX_REQUEST_BYTES)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=sorted(OPERATIONS), help="existing scoped function; request and result are JSON")
    args = parser.parse_args(argv)
    try:
        raw = read_request_bytes(sys.stdin.buffer)
        request = load_json(raw.decode("utf-8", errors="strict"))
        result = OPERATIONS[args.operation](request)
        # Encode before writing so serialization/input errors emit no prefix.
        output = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    except (ValueError, TypeError, KeyError, IndexError, OSError, OverflowError, RecursionError) as error:
        diagnostic = {"error": {"code": getattr(error, "code", "PORTABLE_INPUT_INVALID"),
                                "path": getattr(error, "path", "/")}}
        print(json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 1 if args.operation in VALIDATION_COMMANDS and result["valid"] is False else 0


if __name__ == "__main__":
    sys.exit(main())
