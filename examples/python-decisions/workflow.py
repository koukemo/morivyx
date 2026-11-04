"""Compose the public Python Core APIs; this example grants no adoption authority."""

import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "portable-core"))
from canonical import load_json
from changeset_apply import apply_change_set
from decision_preparation import prepare_decision_creation, prepare_decision_revision
from package_records import read_package_file_sources, read_package_files, write_package_files
from package_restore import restore_package_files
from package_validation import validate_package_files
from stdin_transport import read_bounded_stdin

LIMIT = 8 * 1024 * 1024


class ExampleFailure(ValueError):
    def __init__(self, stage):
        super().__init__("decision example failed")
        self.stage = stage


def write_decision(operation, source, destination, request):
    stage = "source"
    try:
        previous = read_package_file_sources(source)
        contents = read_package_files(previous)
        if not validate_package_files(previous)["valid"]:
            raise ValueError("source Graph is invalid")
        stage = "prepare"
        if operation not in ("create", "revise"):
            raise ValueError("unknown operation")
        prepare = prepare_decision_creation if operation == "create" else prepare_decision_revision
        plan = prepare(contents, request)
        applied = apply_change_set({
            "changeSet": plan["changeSet"], "currentRevision": contents["revision"],
            "schemaLockDigest": contents["calculatedSchemaLockDigest"],
            "currentElements": contents["elements"], "candidateElements": [plan["candidateElement"]],
            "resultingRevision": plan["resultingRevision"],
        })
        stage = "validation"
        contents.update(elements=applied["elements"], revision=applied["revision"])
        contents["changeSets"].append(plan["changeSet"])
        generated = write_package_files(contents)
        # These preparations change one Decision and add one ChangeSet only.
        # Keep every other checked source, including report aliases, verbatim.
        updated = ("revision.yaml",
                   "graph/entities/" + plan["candidateElement"]["id"][9:] + ".yaml",
                   "ledger/" + plan["changeSet"]["id"][9:] + ".yaml")
        files = {**previous, **{path: generated[path] for path in updated}}
        report = validate_package_files(files, previous_files=previous)
        if not report["valid"]:
            raise ValueError("result Graph is invalid")
        reread = read_package_files(files)
        stage = "output"
        output = (json.dumps({
            "restored": True, "decisionId": plan["candidateElement"]["id"],
            "decisionRevision": plan["candidateElement"]["revision"], "changeSetId": plan["changeSet"]["id"],
            "revision": reread["revision"]["id"], "rootDigest": reread["calculatedRootDigest"],
            "schemaLockDigest": reread["calculatedSchemaLockDigest"], "graphValidation": report,
        }, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
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
        restore_package_files(files, destination)
        return output
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError, OverflowError):
        raise ExampleFailure(stage) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "revise"))
    parser.add_argument("source", help="existing package directory containing revision.yaml")
    parser.add_argument("destination", help="new package directory; its parent must exist")
    args = parser.parse_args()
    stage = "input"
    try:
        request = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        output = write_decision(args.operation, args.source, args.destination, request)
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError, OverflowError) as error:
        stage = error.stage if isinstance(error, ExampleFailure) else stage
        print(json.dumps({"error": {"code": "EXAMPLE_DECISION_FAILED", "stage": stage}}, separators=(",", ":")), file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
