"""Apply an explicit ChangeSet to a copied package and publish a new root.

Staging, verification and cleanup concern this operation's owned output. This
does not guarantee power-loss recovery or isolation from hostile path races.
"""

import asyncio
import errno
import os
import re
import shutil
import stat
from uuid import uuid4

from canonical import canonical_json, digest, unicode_text
from changeset_apply import apply_change_set
from graph_validation import validate_graph
from ledger_store import _diagnostics, _metadata, _validate, read_ledger_package, write_change_set
from record_validation import _revision_keys
from schema_registry import resolve_schema_registry
from schema_validation import ValidationError, pointer, validate_graph_element
from yaml_records import write_yaml


def _fail(code, path):
    raise ValidationError(code, path)


def _inside(parent, path):
    return os.path.commonpath((parent, path)) == parent


@_diagnostics
def _output_root(base_path, output_path):
    if type(output_path) is not str or not output_path:
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    output = os.path.abspath(output_path)
    base_root = os.path.dirname(_metadata(base_path))
    if os.path.basename(output) == ".morivyx" or _inside(base_root, output):
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    try:
        os.stat(output)
    except FileNotFoundError:
        pass
    else:
        _fail("PACKAGE_OUTPUT_EXISTS", output)
    return output


def _registry(base):
    path = os.path.join(base["directory"], "schemas")
    locked = {entry["schemaId"] + "@" + entry["version"] + ".yaml" for entry in base["schemaLock"]["schemas"]}
    try:
        with os.scandir(path) as entries:
            unlocked = sorted(entry.name for entry in entries if entry.is_file() and entry.name.endswith(".yaml") and entry.name not in locked)
    except FileNotFoundError:
        unlocked = []
    sources = {}
    for name in locked:
        if any(character in name for character in "/\\\x00\r\n"):
            continue
        try:
            with open(os.path.join(path, name), "rb") as stream:
                sources[name] = stream.read()
        except FileNotFoundError:
            pass
        except OSError:
            # A present but unreadable/directory source is a conflict rather
            # than a missing locked definition, as in the reference reader.
            sources[name] = b""
    registry = resolve_schema_registry(base["schemaLock"], sources)
    registry["issues"] = [{"code": "SCHEMA_LOCK_CONFLICT", "phase": 2, "elementId": "", "path": "/schemas/" + name.replace("~", "~0"), "relatedId": ""}
                          for name in unlocked] + registry["issues"]
    return registry


def _graph_result(base, *, elements=None, revision=None, previous=None, registry=None):
    registry = _registry(base) if registry is None else registry
    revision = base["revision"] if revision is None else revision
    return validate_graph(graph_revision=revision["id"], schema_lock_digest=base["calculatedSchemaLockDigest"],
                          schemas=list(registry["schemas"].values()), elements=base["elements"] if elements is None else elements,
                          approvals=base["approvals"], previous_elements=previous, registry_issues=registry["issues"])


def _serialize(record):
    # write_yaml checks the record-specific null policy and authoring order.
    def nulls(value, path=""):
        if value is None:
            allowed = (record.get("format") == "morivyx.git-graph/0.1" and path.startswith("/extensions/")) or (
                record.get("format") == "morivyx.graph-revision/0.1" and path == "/parentRevision")
            if not allowed:
                _fail("YAML_SERIALIZATION_INVALID", path)
        elif type(value) is dict:
            for key in _revision_keys(value):
                nulls(value[key], pointer(path, unicode_text(key)))
        elif type(value) is list:
            for index, item in enumerate(value):
                nulls(item, pointer(path, index))
    nulls(record)
    try:
        source = write_yaml(record, max_bytes=None, max_depth=None, allow_merge_keys=True)
    except (ValueError, TypeError, RecursionError):
        _fail("YAML_SERIALIZATION_INVALID", "")

    def source_escape(match):
        slashes, code = match.groups()
        if len(slashes) % 2 == 0:
            return match[0]
        number = int(code, 16)
        replacement = chr(number) if number in (0x2028, 0x2029) else "\\" + {0: "0", 7: "a", 11: "v", 27: "e"}.get(number, "x" + code[-2:])
        return slashes[:-1] + replacement
    return re.sub(r"(\\+)u(00[01][0-9a-f]|202[89])", source_escape, source)


def _write_synced(path, record):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(_serialize(record).encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())


def _remove_file(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as failure:
        # Darwin reports unlink(directory) as EPERM; normalize the same
        # ordinary-directory case as the reference's nonrecursive rm.
        if failure.errno not in (errno.EISDIR, errno.EPERM) or not stat.S_ISDIR(os.lstat(path).st_mode):
            raise
        error = ValidationError("ERR_FS_EISDIR", path)
        error.native_name = "SystemError"
        raise error from None


def _remove_tree(path):
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def _verified(verified, applied, change_set):
    ordered = lambda values: sorted(values, key=lambda value: value["id"])
    if (verified["revision"]["id"] != applied["revision"]["id"] or
            verified["revision"]["rootDigest"] != applied["rootDigest"] or
            canonical_json(ordered(verified["elements"])) != canonical_json(ordered(applied["elements"]))):
        _fail("PACKAGE_OUTPUT_MISMATCH", "/outputPath")
    stored = next((record for record in verified["changeSets"] if record["id"] == change_set["id"]), None)
    if stored is None or digest("changeset", stored) != digest("changeset", change_set):
        _fail("PACKAGE_OUTPUT_MISMATCH", "/outputPath/.morivyx/ledger")


@_diagnostics
def _write_applied(input_value, output):
    value = input_value if type(input_value) is dict else {}
    base_path = value.get("basePath")
    change_set, candidates = value.get("changeSet"), value.get("candidateElements", [])
    resulting_revision = value.get("resultingRevision")
    applied_ids = value.get("appliedChangeSetIds", [])
    base = read_ledger_package(base_path)
    if type(candidates) is list:
        for index, candidate in enumerate(candidates):
            _validate(validate_graph_element, candidate, "/candidateElements/" + str(index))
    known, inferred, existing = [], [], None
    for record in base["changeSets"]:
        known.append(record["id"])
        if record["id"] == (change_set.get("id") if type(change_set) is dict else None):
            existing = record
        if all(record[key] == expected for key, expected in (
                ("baseRevision", base["revision"]["parentRevision"]), ("resultingRevision", base["revision"]["id"]),
                ("resultingRootDigest", base["revision"]["rootDigest"]), ("schemaLockDigest", base["revision"]["schemaLockDigest"]))):
            inferred.append(record["id"])
    effective = list(applied_ids) if type(applied_ids) is list else applied_ids
    if type(effective) is list:
        effective.extend(identity for identity in inferred if identity not in effective)
    applied = apply_change_set({"changeSet": change_set, "currentRevision": base["revision"], "currentElements": base["elements"],
                                "schemaLockDigest": base["calculatedSchemaLockDigest"], "candidateElements": candidates,
                                "resultingRevision": resulting_revision, "knownChangeSetIds": known, "appliedChangeSetIds": effective})
    if existing is not None and digest("changeset", existing) != digest("changeset", change_set):
        _fail("CHANGESET_ALREADY_EXISTS", "/changeSet/id")
    target_validation = _graph_result(base, elements=applied["elements"], revision=applied["revision"], previous=base["elements"])
    if target_validation["valid"] is not True:
        _fail("CHANGESET_TARGET_VALIDATION_FAILED", "/candidateElements")
    base_real = os.path.realpath(os.path.dirname(_metadata(base_path)), strict=True)
    # Resolve symlinks through existing ancestors, retaining absent suffixes.
    parent = os.path.dirname(output)
    ancestor, missing = parent, []
    while True:
        try:
            parent_real = os.path.join(os.path.realpath(ancestor, strict=True), *reversed(missing))
            break
        except FileNotFoundError:
            missing.append(os.path.basename(ancestor))
            previous = os.path.dirname(ancestor)
            if previous == ancestor:
                raise
            ancestor = previous
    if _inside(base_real, os.path.join(parent_real, os.path.basename(output))):
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    os.makedirs(parent, exist_ok=True)
    temporary = os.path.join(parent, f".{os.path.basename(output)}-{os.getpid()}-{uuid4()}.tmp")
    metadata = os.path.join(temporary, ".morivyx")
    temporary_created = claimed = False
    try:
        os.mkdir(temporary)
        temporary_created = True
        shutil.copytree(_metadata(base_path), metadata, symlinks=False)
        _remove_file(os.path.join(metadata, "index.json"))
        graph = os.path.join(metadata, "graph")
        if os.path.lexists(graph):
            shutil.rmtree(graph)
        _remove_file(os.path.join(metadata, "revision.yaml"))
        for kind in ("entities", "relations"):
            os.makedirs(os.path.join(graph, kind))
        for element in applied["elements"]:
            directory = "entities" if element["kind"] == "entity" else "relations"
            _write_synced(os.path.join(graph, directory, element["id"][9:] + ".yaml"), element)
        _write_synced(os.path.join(metadata, "revision.yaml"), applied["revision"])
        if existing is None:
            write_change_set(temporary, change_set)
        verified = read_ledger_package(temporary)
        _verified(verified, applied, change_set)
        output_validation = _graph_result(verified)
        if output_validation["valid"] is not True or any(output_validation[key] != target_validation[key] for key in ("graphRevision", "schemaLockDigest", "rootDigest")):
            _fail("CHANGESET_TARGET_VALIDATION_FAILED", "/outputPath")
        try:
            os.mkdir(output)
            claimed = True
        except FileExistsError:
            _fail("PACKAGE_OUTPUT_EXISTS", output)
        os.rename(metadata, os.path.join(output, ".morivyx"))
        shutil.rmtree(temporary)
    except BaseException:
        if temporary_created:
            _remove_tree(temporary)
        if claimed:
            _remove_tree(output)
        raise
    return {"valid": True, "outputPath": output, "metadataPath": os.path.join(output, ".morivyx"),
            "graphRevision": applied["revision"]["id"], "rootDigest": applied["rootDigest"],
            "elementCount": len(applied["elements"]), "changeSetId": change_set["id"]}


def write_applied_package(input_value=None):
    """Capture root fields now and return an awaitable apply-and-publish operation.

    Nested records retain their references until validation, matching the
    reference writer. Unlike the import wrapper, this is not a deep snapshot.
    """
    try:
        value = {key: input_value[key] for key in ("basePath", "outputPath", "changeSet", "candidateElements", "resultingRevision", "appliedChangeSetIds")
                 if key in input_value} if type(input_value) is dict else {}
        output = _output_root(value.get("basePath"), value.get("outputPath"))
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def apply():
        await asyncio.sleep(0)
        return _write_applied(value, output)
    return apply()
