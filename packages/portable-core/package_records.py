"""Independent record structure, digest and binding checks; not full Graph validation."""

import argparse
import asyncio
import json
import os
from pathlib import PurePath
import re
import stat
import sys

from canonical import digest
from approval_validation import validate_approval, validate_approval_ledger
from migration_validation import validate_migration, validate_migration_change_set
from record_validation import validate_change_set, validate_graph_revision, validate_schema_lock
from report_records import prepare_report, serialize_report_yaml
from schema_validation import ValidationError, validate_graph_element
from yaml_authoring import read_authoring_yaml
from yaml_records import MAX_BYTES, write_yaml


MAX_FILES = 10_000
MAX_TOTAL_BYTES = 64 * 1024 * 1024
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
STABLE_ID = re.compile(r"urn:uuid:" + UUID)
RECORD_PATH = re.compile(
    r"(graph/entities|graph/relations|approvals|ledger|migrations)/(" + UUID + r")\.yaml"
)
REPORT_PATH = re.compile(r"reports/[^/\\\x00\r\n]*\.yaml")
DIRECTORIES = {"graph", "graph/entities", "graph/relations", "approvals", "ledger", "migrations", "reports", "schemas"}
RECORDS = {
    "graph/entities": ("elements", "morivyx.git-graph/0.1", "entity"),
    "graph/relations": ("elements", "morivyx.git-graph/0.1", "relation"),
    "approvals": ("approvals", "morivyx.approval/0.1", None),
    "ledger": ("changeSets", "morivyx.changeset/0.1", None),
    "migrations": ("migrations", "morivyx.migration/0.1", None),
    "reports": ("reports", None, None),
}
HEADERS = {"schema.lock.yaml": ("schemaLock", "morivyx.schema-lock/0.1"),
           "revision.yaml": ("revision", "morivyx.graph-revision/0.1")}


def read_order(path):
    if path in HEADERS:
        return (list(HEADERS).index(path), path)
    if path.startswith("schemas/"):
        return (8, path)
    if REPORT_PATH.fullmatch(path):
        return (7, path)
    directory = RECORD_PATH.fullmatch(path).group(1)
    return (2 + list(RECORDS).index(directory), path)


def checked_path(path):
    if type(path) is not str:
        raise ValueError("package path must be text")
    schema_path = re.fullmatch(r"schemas/[^/\\\x00\r\n]+\.yaml", path)
    if path not in HEADERS and not RECORD_PATH.fullmatch(path) and not REPORT_PATH.fullmatch(path) and not schema_path:
        raise ValueError("unsupported package path")
    return path


def record_id(record):
    if type(record) is not dict or type(record.get("id")) is not str or not STABLE_ID.fullmatch(record["id"]):
        raise ValueError("invalid stable record ID")
    return record["id"]


def read_package_files(files):
    """Read bounded contents, checking record structures, digests and bindings.

    Checks do not authenticate records, bind schema definitions or validate
    Graph references. Approval withdrawal and migration change-set references
    are checked, without assessing authority or applying any change.
    """
    if type(files) is not dict or len(files) > MAX_FILES:
        raise ValueError("invalid or oversized package file mapping")
    if not HEADERS.keys() <= files.keys():
        raise ValueError("required package header missing")
    for path in files:
        checked_path(path)
    result = {"elements": [], "approvals": [], "changeSets": [], "migrations": [], "reports": [], "schemaSources": {}}
    entries, prepared_reports, total = [], {}, 0
    validators = {"elements": validate_graph_element, "approvals": validate_approval,
                  "changeSets": validate_change_set, "migrations": validate_migration}
    for path in sorted(files, key=read_order):
        checked_path(path)
        source = files[path]
        if type(source) is str:
            source = source.encode("utf-8")
        if type(source) is not bytes or len(source) > MAX_BYTES:
            raise ValueError("invalid or oversized record source")
        total += len(source)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("package byte limit exceeded")
        if path.startswith("schemas/"):
            # Preserve source bytes as UTF-8 text, including malformed YAML, so
            # explicit registry validation can diagnose it at phase two.
            result["schemaSources"][path[len("schemas/"):]] = source.decode("utf-8")
            continue
        record = read_authoring_yaml(source)
        if path in HEADERS:
            field, format_id = HEADERS[path]
            (validate_schema_lock if field == "schemaLock" else validate_graph_revision)(record)
            result[field] = record
            continue
        if REPORT_PATH.fullmatch(path):
            directory, filename_id = "reports", None
        else:
            directory, filename_id = RECORD_PATH.fullmatch(path).groups()
        field, format_id, kind = RECORDS[directory]
        if field == "reports":
            prepared = prepare_report(record)
            if "id" not in record:
                raise ValidationError("REPORT_ID_REQUIRED", "/id")
        else:
            validators[field](record)
        identity = record_id(record)
        if field != "reports" and identity[9:] != filename_id:
            raise ValueError("filename and record ID mismatch")
        entries.append(record)
        format_matches = field == "reports" or record.get("format") == format_id
        if not format_matches or (kind and record.get("kind") != kind):
            raise ValueError("record format or kind does not match directory")
        if field == "reports":
            prepared_reports[identity] = prepared
        result[field].append(record)
    seen = set()
    for record in entries:
        if record["id"] in seen:
            raise ValueError("duplicate stable ID across package records")
        seen.add(record["id"])
    for field in ("elements", "approvals", "changeSets", "migrations", "reports"):
        result[field].sort(key=lambda record: record["id"])
    validate_approval_ledger(result["approvals"])
    change_sets = {record["id"]: record for record in result["changeSets"]}
    for migration in result["migrations"]:
        validate_migration_change_set(migration, change_sets.get(migration["changeSetId"]))
    for element in result["elements"]:
        if element["revision"] != digest("revision", element)["digest"]:
            raise ValueError("element revision mismatch")
    schema_digest = digest("schema-lock", result["schemaLock"])["digest"]
    root_digest = digest("root", result["elements"])["digest"]
    if result["revision"].get("schemaLockDigest") != schema_digest:
        raise ValueError("schema lock digest mismatch")
    if result["revision"].get("rootDigest") != root_digest:
        raise ValueError("Graph root digest mismatch")
    result["reports"] = [prepared_reports[report["id"]] for report in result["reports"]]
    result["calculatedSchemaLockDigest"] = schema_digest
    result["calculatedRootDigest"] = root_digest
    result["validation"] = {
        "scope": "record-structures-digests-and-bindings",
        "recordStructuresValidated": True,
        "recordAuthoringValidated": True,
        "schemaValidated": False, "graphReferencesValidated": False,
        "approvalLedgerValidated": True, "migrationBindingsValidated": True,
        "signaturesValidated": False, "reportsValidated": True,
    }
    return result


def write_package_files(package):
    """Return a checked file mapping; never write into a filesystem."""
    if type(package) is not dict:
        raise ValueError("package must be a logical mapping")
    files = {}
    total = 0

    def put_source(path, source):
        nonlocal total
        checked_path(path)
        if path in files:
            raise ValueError("duplicate package output path")
        if len(files) >= MAX_FILES:
            raise ValueError("package file limit exceeded")
        if type(source) is not str or len(source.encode("utf-8")) > MAX_BYTES:
            raise ValueError("invalid or oversized output source")
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ValueError("package byte limit exceeded")
        files[path] = source

    def put(path, record):
        put_source(path, write_yaml(record))

    for path, (field, _format) in HEADERS.items():
        put(path, package[field])
    sources = package.get("schemaSources", {})
    if type(sources) is not dict:
        raise ValueError("schema sources must be a mapping")
    for name, source in sources.items():
        if type(name) is not str or "/" in name or "\\" in name:
            raise ValueError("schema source name must be a basename")
        put_source("schemas/" + name, source)
    for field in ("elements", "approvals", "changeSets", "migrations", "reports"):
        if type(package[field]) is not list:
            raise ValueError("package record collection must be an array")
        for item in package[field]:
            record = item["report"] if field == "reports" else item
            identity = record_id(record)
            if field == "elements":
                directory = {"entity": "graph/entities", "relation": "graph/relations"}.get(record.get("kind"))
                if not directory:
                    raise ValueError("unsupported element kind")
            else:
                directory = {"approvals": "approvals", "changeSets": "ledger",
                             "migrations": "migrations", "reports": "reports"}[field]
            path = directory + "/" + identity[9:] + ".yaml"
            if field == "reports":
                put_source(path, serialize_report_yaml(record))
            else:
                put(path, record)
    read_package_files(files)
    return dict(sorted(files.items()))


def _directory_flags():
    if not all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK")):
        raise OSError("safe directory traversal is unavailable on this platform")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_directory(path):
    flags = _directory_flags()
    path = PurePath(path)
    if ".." in path.parts:
        raise ValueError("parent traversal is unsupported")
    descriptor = os.open(path.anchor or ".", flags)
    try:
        for part in path.parts:
            if part == path.anchor or part == ".":
                continue
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read_package_sources(directory):
    """Read the explicitly selected package directory through no-follow handles.

    No symlinked path component, special file, hard link or unknown entry is read.
    This is not an atomic snapshot of a concurrently edited directory.
    """
    root = _open_directory(directory)
    files, total, entries_seen = {}, 0, 0

    def walk(descriptor, prefix):
        nonlocal total, entries_seen
        with os.scandir(descriptor) as entries:
            for entry in entries:
                entries_seen += 1
                if entries_seen > MAX_FILES + len(DIRECTORIES):
                    raise ValueError("package entry limit exceeded")
                path = prefix + entry.name
                if path in DIRECTORIES:
                    child = os.open(entry.name, _directory_flags(), dir_fd=descriptor)
                    try:
                        walk(child, path + "/")
                    finally:
                        os.close(child)
                    continue
                checked_path(path)
                if len(files) >= MAX_FILES:
                    raise ValueError("package file limit exceeded")
                handle = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                try:
                    before = os.fstat(handle)
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                        raise ValueError("package record is not a single regular file")
                    if before.st_size > MAX_BYTES or total + before.st_size > MAX_TOTAL_BYTES:
                        raise ValueError("package byte limit exceeded")
                    content = bytearray()
                    while True:
                        chunk = os.read(handle, min(65536, MAX_BYTES + 1 - len(content)))
                        if not chunk:
                            break
                        content.extend(chunk)
                        if len(content) > MAX_BYTES or total + len(content) > MAX_TOTAL_BYTES:
                            raise ValueError("package byte limit exceeded")
                    after = os.fstat(handle)
                    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
                    ) or after.st_nlink != 1 or len(content) != before.st_size:
                        raise ValueError("package record changed while reading")
                    files[path] = bytes(content)
                    total += len(content)
                finally:
                    os.close(handle)
    try:
        walk(root, "")
    finally:
        os.close(root)
    return files


def read_package(directory):
    """Read and validate the logical package through no-follow handles."""
    return read_package_files(_read_package_sources(directory))


def read_package_file_sources(directory):
    """Return checked UTF-8 sources, retaining spelling and report filenames.

    Uses the same bounded no-follow reader and structural checks as read_package.
    Does not validate Schema/Graph constraints or authenticate any record.
    Observed file changes are rejected; concurrent edits are not fully excluded.
    """
    files = _read_package_sources(directory)
    read_package_files(files)
    return {path: source.decode("utf-8", errors="strict") for path, source in files.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="explicit package directory containing revision.yaml")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--export", action="store_true", help="emit logical records instead of counts")
    output.add_argument("--export-files", action="store_true", help="emit a checked relative-path to YAML-text mapping")
    args = parser.parse_args()
    try:
        package = read_package(args.directory)
        result = write_package_files(package) if args.export_files else package if args.export else {
            "graphRevision": package["revision"]["id"],
            "counts": {field: len(package[field]) for field in (
                "elements", "approvals", "changeSets", "migrations", "reports"
            )},
            "calculatedSchemaLockDigest": package["calculatedSchemaLockDigest"],
            "calculatedRootDigest": package["calculatedRootDigest"],
            "validation": package["validation"],
        }
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (ValueError, TypeError, KeyError, OSError, RecursionError):
        print("package read failed; no result produced", file=sys.stderr)
        return 1


async def _package_api_io(operation, path):
    """One asynchronous filesystem boundary; no fixture policy in production."""
    def perform():
        if operation == "lstat":
            return os.lstat(path)
        if operation == "readdir":
            with os.scandir(path) as entries:
                return list(entries)
        if operation == "readFile":
            with open(path, "rb") as stream:
                return stream.read()
        raise ValueError("unsupported package operation")
    from yaml_authoring import _file_os_error
    try:
        return await asyncio.to_thread(perform)
    except OSError as error:
        raise _file_os_error(error)


def _package_api_validate(validator, record, path, *arguments):
    try:
        return validator(record, *arguments)
    except ValidationError as error:
        raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None


async def _package_api_yaml(path):
    from yaml_authoring import (_file_parse_yaml, _file_check_profile,
                                _file_profile_diagnostic, _FileYamlSyntaxError)
    try:
        source = await _package_api_io("readFile", path)
    except FileNotFoundError:
        raise ValidationError("PACKAGE_FILE_MISSING", path) from None
    try:
        text = source.decode("utf-8", errors="strict")
    except UnicodeError:
        raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path) from None
    if (text.startswith("\ufeff") or "\r" in text or "\t" in text or
            re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text) or not text.endswith("\n") or
            re.search(r"\n *\n$", text) or re.search(r"^(?:%.*|---(?:[ \t]|$)|\.\.\.(?:[ \t]|$))", text, re.M)):
        raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path)
    try:
        return _file_check_profile(_file_parse_yaml(text))
    except ValidationError as error:
        raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
    except (ValueError, TypeError) as error:
        if isinstance(error, _FileYamlSyntaxError) or str(error) in (
                "unsupported YAML escape", "unfinished YAML escape", "invalid YAML Unicode escape"):
            raise ValidationError("PACKAGE_YAML_INVALID", path) from None
        location, syntax = _file_profile_diagnostic(text)
        location = getattr(error, "_yaml_profile_path", location)
        if not syntax and location is not None:
            raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path + ("#" + location if location else "")) from None
        raise ValidationError("PACKAGE_YAML_INVALID", path) from None


async def _package_api_tree(directory):
    try:
        information = await _package_api_io("lstat", directory)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(information.st_mode):
        raise ValidationError("PACKAGE_PATH_INVALID", directory)
    pending = [directory]
    while pending:
        current = pending.pop()
        for entry in sorted(await _package_api_io("readdir", current), key=lambda item: item.name):
            path = os.path.join(current, entry.name)
            if entry.is_symlink() or not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                raise ValidationError("PACKAGE_PATH_INVALID", path)
            if entry.is_dir(follow_symlinks=False):
                pending.append(path)


async def _package_api_group(directory, validator=None, kind=None, report=False):
    try:
        entries = await _package_api_io("readdir", directory)
    except FileNotFoundError:
        return []
    paths = sorted(os.path.join(directory, entry.name) for entry in entries
                   if entry.is_file(follow_symlinks=False) and entry.name.endswith(".yaml"))
    records = []
    for path in paths:
        record = await _package_api_yaml(path)
        if report:
            from report_records import _report_validate
            prepared = _report_validate(record, path)
            result = {"valid": True, "type": prepared["type"],
                      "digest": digest(prepared["type"], record)["digest"], "report": record}
            if "id" not in record:
                raise ValidationError("REPORT_ID_REQUIRED", path + "#/id")
            records.append((path, result))
            continue
        _package_api_validate(validator, record, path)
        if os.path.basename(path) != record["id"][9:] + ".yaml":
            raise ValidationError("PACKAGE_FILENAME_ID_MISMATCH", path)
        if kind is not None and record["kind"] != kind:
            raise ValidationError("GRAPH_ELEMENT_KIND_MISMATCH", path)
        records.append((path, record))
    return records


async def _read_package_api(path):
    """Read the separate file API contract without the legacy bounded reader."""
    from yaml_authoring import _file_path
    absolute = os.path.abspath(_file_path(path))
    directory = absolute if os.path.basename(absolute) == ".morivyx" else os.path.join(absolute, ".morivyx")
    await _package_api_tree(directory)
    schema_path, revision_path = (os.path.join(directory, name) for name in ("schema.lock.yaml", "revision.yaml"))
    schema_lock = await _package_api_yaml(schema_path)
    revision = await _package_api_yaml(revision_path)
    _package_api_validate(validate_schema_lock, schema_lock, schema_path)
    _package_api_validate(validate_graph_revision, revision, revision_path)
    entities = await _package_api_group(os.path.join(directory, "graph/entities"), validate_graph_element, "entity")
    relations = await _package_api_group(os.path.join(directory, "graph/relations"), validate_graph_element, "relation")
    approvals = await _package_api_group(os.path.join(directory, "approvals"), validate_approval)
    changes = await _package_api_group(os.path.join(directory, "ledger"), validate_change_set)
    migrations = await _package_api_group(os.path.join(directory, "migrations"), validate_migration)
    reports = await _package_api_group(os.path.join(directory, "reports"), report=True)
    element_entries = entities + relations
    seen = set()
    for file_path, record in element_entries + approvals + changes + migrations + [(p, r["report"]) for p, r in reports]:
        if record["id"] in seen:
            raise ValidationError("ID_DUPLICATE", file_path)
        seen.add(record["id"])
    try:
        validate_approval_ledger([record for _, record in approvals])
    except ValidationError as error:
        match = re.match(r"/approvals/(\d+)(.*)$", error.path)
        if match:
            raise ValidationError(error.code, approvals[int(match[1])][0] + "#" + match[2]) from None
        raise
    by_id = {record["id"]: record for _, record in changes}
    for file_path, migration in migrations:
        _package_api_validate(validate_migration_change_set, migration, file_path, by_id.get(migration["changeSetId"]))
    for file_path, element in element_entries:
        if element["revision"] != digest("revision", element)["digest"]:
            raise ValidationError("REVISION_ID_MISMATCH", file_path)
    elements = sorted((record for _, record in element_entries), key=lambda record: record["id"])
    schema_digest = digest("schema-lock", schema_lock)["digest"]
    if revision["schemaLockDigest"] != schema_digest:
        raise ValidationError("SCHEMA_LOCK_DIGEST_MISMATCH", revision_path)
    root_digest = digest("root", elements)["digest"]
    if revision["rootDigest"] != root_digest:
        raise ValidationError("ROOT_DIGEST_MISMATCH", revision_path)
    return {"directory": directory, "schemaLock": schema_lock, "revision": revision, "elements": elements,
            "approvals": [record for _, record in approvals], "changeSets": [record for _, record in changes],
            "migrations": [record for _, record in migrations], "reports": [result for _, result in reports],
            "calculatedSchemaLockDigest": schema_digest, "calculatedRootDigest": root_digest}


async def inspect_package(path):
    """Inspect stored record structure and digests; not a Graph or trust verdict."""
    package = await _read_package_api(path)
    revision = package["revision"]
    return {"valid": True, "graphRevision": revision["id"], "parentRevision": revision["parentRevision"],
            **{name + "Count": len(package[field]) for name, field in (
                ("element", "elements"), ("approval", "approvals"), ("changeSet", "changeSets"),
                ("migration", "migrations"), ("report", "reports"))},
            "schemaLockDigest": {"recorded": revision["schemaLockDigest"], "calculated": package["calculatedSchemaLockDigest"]},
            "rootDigest": {"recorded": revision["rootDigest"], "calculated": package["calculatedRootDigest"]},
            "elements": [{field: element[field] for field in ("id", "kind", "revision")} for element in package["elements"]]}


if __name__ == "__main__":
    sys.exit(main())
