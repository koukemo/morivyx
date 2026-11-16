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


def _serialize(record, *, _file_api=False):
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
    if _file_api:
        pending = [(record, "")]
        while pending:
            value, path = pending.pop()
            if type(value) is dict:
                pending.extend((value[key], pointer(path, unicode_text(key))) for key in reversed(_revision_keys(value)))
            elif type(value) is list:
                pending.extend((value[index], pointer(path, index)) for index in reversed(range(len(value))))
            elif value is None:
                nulls(value, path)
    else:
        nulls(record)
    try:
        source = _decision_yaml(record) if _file_api else write_yaml(record, max_bytes=None, max_depth=None, allow_merge_keys=True)
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


def _decision_nonce():
    return str(uuid4())


def _decision_yaml(record):
    """Normalize and render file-writer YAML using explicit heap frames.

    Field order, quoting and timestamps use the existing authoring rules.
    Legacy write_yaml keeps its existing depth and transport contracts.
    """
    from canonical import timestamp_text
    from yaml_records import ORDERS, field_order, plain_key, yaml_quote
    canonical_json(record)
    format_id = record.get("format")
    if format_id not in ORDERS:
        raise ValueError("unsupported record format")
    holder = [None]
    pending = [(record, (), holder, 0)]
    while pending:
        value, path, parent, key = pending.pop()
        if type(value) is dict:
            entries = {unicode_text(name): child for name, child in value.items()}
            order = field_order(format_id, path)
            keys = sorted(entries, key=lambda name: (order.index(name), "") if name in order else (len(order), name))
            normalized = {name: None for name in keys}
            parent[key] = normalized
            pending.extend((entries[name], path + (name,), normalized, name) for name in reversed(keys))
        elif type(value) is list:
            normalized = [None] * len(value)
            parent[key] = normalized
            pending.extend((value[index], path + ("*",), normalized, index) for index in reversed(range(len(value))))
        else:
            parent[key] = timestamp_text(unicode_text(value)) if type(value) is str else value
    def inline(value):
        return yaml_quote(value) if type(value) is str else canonical_json(value)
    lines, tasks = [], [("value", holder[0], 0)]
    while tasks:
        operation, value, indent = tasks.pop()
        prefix = " " * indent
        if operation == "line":
            lines.append(value)
        elif operation == "dash":
            lines[value] = prefix + "- " + lines[value][indent + 2:]
        elif operation == "item":
            tasks.append(("dash", len(lines), indent))
            tasks.append(("value", value, indent + 2))
        elif type(value) is dict and value:
            entries = []
            for name, child in value.items():
                name = name if plain_key(name) and not re.search(r"[\x7f-\x9f]", name) else yaml_quote(name)
                if len(name.encode("utf-16-le")) // 2 > 1024:
                    entries.append(("line", prefix + "? " + name, indent))
                    entry = prefix + ":"
                else:
                    entry = prefix + name + ":"
                if type(child) in (dict, list) and child:
                    entries.extend((("line", entry, indent), ("value", child, indent + 2)))
                else:
                    entries.append(("line", entry + " " + inline(child), indent))
            tasks.extend(reversed(entries))
        elif type(value) is list and value:
            tasks.extend(("item", child, indent) for child in reversed(value))
        else:
            lines.append(prefix + inline(value))
    return "\n".join(lines) + "\n"


async def _decision_api_io(operation, *arguments):
    """Actual filesystem boundary for the separate Decision file writers.

    Observers can wrap this boundary without changing filesystem primitives or
    teaching production code about fixtures, expected traces or injected faults.
    """
    from yaml_authoring import _file_os_error, _file_path
    path = arguments[0]
    def perform():
        if operation.startswith("handle."):
            descriptor = path[1]
            if operation == "handle.writeFile":
                source = memoryview(arguments[1].encode("utf-8"))
                while source:
                    written = os.write(descriptor, source)
                    if written == 0:
                        raise OSError(errno.EIO, "short write", path[0])
                    source = source[written:]
                return None
            if operation == "handle.sync":
                return os.fsync(descriptor)
            if operation == "handle.close":
                return os.close(descriptor)
        _file_path(path)
        if operation == "randomUUID":
            return _decision_nonce()
        if operation in ("lstat", "stat"):
            return getattr(os, operation)(path)
        if operation == "realpath":
            try:
                return os.path.realpath(path, strict=True)
            except OSError as error:
                error.filename = path
                raise
        if operation == "mkdir":
            if len(arguments) > 1 and arguments[1].get("recursive"):
                return os.makedirs(path, exist_ok=True)
            return os.mkdir(path)
        if operation == "cp":
            return shutil.copytree(path, arguments[1], symlinks=False, dirs_exist_ok=True,
                                   copy_function=shutil.copy)
        if operation == "rm":
            options = arguments[1]
            try:
                information = os.lstat(path)
                if stat.S_ISDIR(information.st_mode):
                    if not options.get("recursive"):
                        error = ValidationError("ERR_FS_EISDIR", path)
                        error.native_name = "SystemError"
                        raise error
                    return shutil.rmtree(path)
                return os.unlink(path)
            except FileNotFoundError:
                if not options.get("force"):
                    raise
                return None
        if operation == "rename":
            return os.rename(path, arguments[1])
        if operation == "open":
            return (path, os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, arguments[2]))
        if operation == "link":
            return os.link(path, arguments[1])
        if operation == "unlink":
            return os.unlink(path)
        raise ValueError("unsupported Decision filesystem operation")
    try:
        return await asyncio.to_thread(perform)
    except OSError as error:
        raise _file_os_error(error)


async def _decision_registry(base):
    from package_records import _package_api_io, _package_api_yaml
    from schema_validation import validate_schema_definition
    directory = os.path.join(base["directory"], "schemas")
    lock = base["schemaLock"]["schemas"]
    names = {entry["schemaId"] + "@" + entry["version"] + ".yaml" for entry in lock}
    try:
        entries = await _package_api_io("readdir", directory)
    except FileNotFoundError:
        entries = []
    def issue(code, path):
        return {"code": code, "phase": 2, "elementId": "", "path": path, "relatedId": ""}
    issues = [issue("SCHEMA_LOCK_CONFLICT", "/schemas/" + entry.name.replace("~", "~0"))
              for entry in sorted(entries, key=lambda item: item.name)
              if entry.is_file(follow_symlinks=False) and entry.name.endswith(".yaml") and entry.name not in names]
    schemas = {}
    for locked in lock:
        key = locked["schemaId"] + "@" + locked["version"]
        code = "SCHEMA_LOCK_CONFLICT"
        if re.fullmatch(r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+", locked["schemaId"]) and re.fullmatch(r"\d+(?:\.\d+)*", locked["version"]):
            try:
                definition = await _package_api_yaml(os.path.join(directory, key + ".yaml"))
                validate_schema_definition(definition)
                if (definition["schemaId"] == locked["schemaId"] and definition["version"] == locked["version"] and
                        digest("schema", definition)["digest"] == locked["digest"]):
                    schemas[key] = definition
                    continue
            except (ValidationError, OSError) as error:
                if getattr(error, "code", None) == "PACKAGE_FILE_MISSING":
                    code = "SCHEMA_LOCK_MISSING"
        issues.append(issue(code, "/schemas/" + key))
    return {"schemas": schemas, "issues": issues}


async def _decision_write_synced(path, record):
    handle = await _decision_api_io("open", path, "wx", 0o644)
    try:
        await _decision_api_io("handle.writeFile", handle, _serialize(record, _file_api=True), "utf8")
        await _decision_api_io("handle.sync", handle)
    finally:
        await _decision_api_io("handle.close", handle)


async def _decision_unlink(path):
    try:
        await _decision_api_io("unlink", path)
    except OSError as error:
        if getattr(error, "code", None) != "ENOENT":
            raise


async def _decision_write_change_set(root, change_set):
    from package_records import _read_package_api, _package_api_yaml
    from record_validation import validate_change_set
    from decision_preparation import package_records
    validate_change_set(change_set)
    directory = _metadata(root)
    try:
        information = await _decision_api_io("lstat", directory)
    except OSError as error:
        if getattr(error, "code", None) == "ENOENT":
            _fail("PACKAGE_RECORD_PACKAGE_MISSING", directory)
        raise
    if not stat.S_ISDIR(information.st_mode):
        _fail("PACKAGE_RECORD_PACKAGE_MISSING", directory)
    lock_path = os.path.join(directory, ".record-id-" + change_set["id"][9:] + ".lock")
    handle = None
    for _ in range(200):
        try:
            handle = await _decision_api_io("open", lock_path, "wx", 0o600)
            break
        except OSError as error:
            if getattr(error, "code", None) != "EEXIST":
                raise
            await asyncio.sleep(0.005)
    if handle is None:
        _fail("PACKAGE_RECORD_BUSY", lock_path)
    try:
        contents = await _read_package_api(directory)
        ledger = os.path.join(directory, "ledger")
        target = os.path.join(ledger, change_set["id"][9:] + ".yaml")
        if any(record.get("id") == change_set["id"] for record in package_records(contents)):
            same_kind = any(record["id"] == change_set["id"] for record in contents["changeSets"])
            _fail("CHANGESET_ALREADY_EXISTS" if same_kind else "ID_DUPLICATE", target)
        try:
            await _decision_api_io("mkdir", ledger)
        except OSError as error:
            if getattr(error, "code", None) != "EEXIST":
                raise
            information = await _decision_api_io("lstat", ledger)
            if not stat.S_ISDIR(information.st_mode):
                _fail("PACKAGE_RECORD_OUTPUT_INVALID", ledger)
        temporary = os.path.join(ledger, f".record-{os.getpid()}-{_decision_nonce()}.tmp")
        stream = await _decision_api_io("open", temporary, "wx", 0o644)
        try:
            await _decision_api_io("handle.writeFile", stream, _serialize(change_set, _file_api=True), "utf8")
            await _decision_api_io("handle.sync", stream)
        except BaseException:
            await _decision_api_io("handle.close", stream)
            await _decision_unlink(temporary)
            raise
        await _decision_api_io("handle.close", stream)
        try:
            persisted = await _package_api_yaml(temporary)
            _validate(validate_change_set, persisted, temporary)
            if canonical_json(persisted) != canonical_json(change_set) or digest("changeset", persisted) != digest("changeset", change_set):
                _fail("PACKAGE_RECORD_DIGEST_MISMATCH", temporary)
            await _decision_api_io("link", temporary, target)
        except OSError as error:
            if getattr(error, "code", None) == "EEXIST":
                _fail("CHANGESET_ALREADY_EXISTS", target)
            raise
        finally:
            await _decision_unlink(temporary)
    finally:
        await _decision_api_io("handle.close", handle)
        await _decision_unlink(lock_path)


def _decision_applied_values(base, prepared):
    """Apply the prepared single create/revise, checking a reread base.

    Only the Decision writers call this helper. General ChangeSet application
    retains its independent API and deepcopy limits.
    """
    from decision_preparation import _decision_clone
    change, candidate = prepared["changeSet"], prepared["candidateElement"]
    if base["revision"]["id"] != change["baseRevision"]:
        _fail("CHANGESET_BASE_REVISION_MISMATCH", "/baseRevision")
    if base["calculatedSchemaLockDigest"] != change["schemaLockDigest"]:
        _fail("CHANGESET_SCHEMA_LOCK_MISMATCH", "/schemaLockDigest")
    operation = change["operations"][0]
    elements = {element["id"]: element for element in base["elements"]}
    identity = candidate["id"]
    if operation["op"] == "create":
        if identity in elements:
            _fail("CHANGESET_PRECONDITION_FAILED", "/operations/0/targetId")
    else:
        if identity not in elements:
            _fail("CHANGESET_PRECONDITION_FAILED", "/operations/0/targetId")
        if elements[identity]["revision"] != operation["beforeRevision"]:
            _fail("CHANGESET_PRECONDITION_FAILED", "/operations/0/beforeRevision")
    elements[identity] = candidate
    result = sorted(elements.values(), key=lambda element: element["id"])
    root = digest("root", result)["digest"]
    if root != change["resultingRootDigest"]:
        _fail("CHANGESET_RESULT_MISMATCH", "/resultingRootDigest")
    return {"elements": _decision_clone(result), "revision": _decision_clone(prepared["resultingRevision"]), "rootDigest": root}


async def _write_decision_applied(base_path, output_path, prepared):
    from package_records import _read_package_api
    from yaml_authoring import _file_path
    if type(output_path) is not str or not output_path:
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    output = os.path.abspath(output_path)
    base_root = os.path.dirname(_metadata(base_path))
    if os.path.basename(output) == ".morivyx" or _inside(base_root, output):
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    try:
        await _decision_api_io("stat", _file_path(output))
    except OSError as error:
        if getattr(error, "code", None) != "ENOENT":
            raise
    else:
        _fail("PACKAGE_OUTPUT_EXISTS", output)
    base = await _read_package_api(base_path)
    from decision_preparation import checked
    checked(validate_graph_element, prepared["candidateElement"], "/candidateElements/0")
    applied = _decision_applied_values(base, prepared)
    change_set = prepared["changeSet"]
    existing = next((record for record in base["changeSets"] if record["id"] == change_set["id"]), None)
    if existing is not None and digest("changeset", existing) != digest("changeset", change_set):
        _fail("CHANGESET_ALREADY_EXISTS", "/changeSet/id")
    registry = await _decision_registry(base)
    target_validation = _graph_result(base, elements=applied["elements"], revision=applied["revision"], previous=base["elements"], registry=registry)
    if target_validation["valid"] is not True:
        _fail("CHANGESET_TARGET_VALIDATION_FAILED", "/candidateElements")
    parent = os.path.dirname(output)
    async def resolve_parent():
        ancestor, missing = parent, []
        while True:
            try:
                return os.path.join(await _decision_api_io("realpath", ancestor), *reversed(missing))
            except OSError as error:
                if getattr(error, "code", None) != "ENOENT":
                    raise
                previous = os.path.dirname(ancestor)
                if previous == ancestor:
                    raise
                missing.append(os.path.basename(ancestor))
                ancestor = previous
    base_real, parent_real = await asyncio.gather(_decision_api_io("realpath", base_root), resolve_parent())
    if _inside(base_real, os.path.join(parent_real, os.path.basename(output))):
        _fail("PACKAGE_OUTPUT_INVALID", "/outputPath")
    await _decision_api_io("mkdir", parent, {"recursive": True})
    temporary = os.path.join(parent, f".{os.path.basename(output)}-{os.getpid()}-{_decision_nonce()}.tmp")
    metadata = os.path.join(temporary, ".morivyx")
    temporary_created = claimed = False
    try:
        await _decision_api_io("mkdir", temporary)
        temporary_created = True
        await _decision_api_io("cp", _metadata(base_path), metadata, {"recursive": True, "dereference": True})
        await _decision_api_io("rm", os.path.join(metadata, "index.json"), {"force": True})
        await _decision_api_io("rm", os.path.join(metadata, "graph"), {"recursive": True, "force": True})
        await _decision_api_io("rm", os.path.join(metadata, "revision.yaml"), {"force": True})
        for kind in ("entities", "relations"):
            await _decision_api_io("mkdir", os.path.join(metadata, "graph", kind), {"recursive": True})
        for element in applied["elements"]:
            kind = "entities" if element["kind"] == "entity" else "relations"
            await _decision_write_synced(os.path.join(metadata, "graph", kind, element["id"][9:] + ".yaml"), element)
        await _decision_write_synced(os.path.join(metadata, "revision.yaml"), applied["revision"])
        if existing is None:
            await _decision_write_change_set(temporary, change_set)
        verified = await _read_package_api(temporary)
        _verified(verified, applied, change_set)
        validation_base = await _read_package_api(temporary)
        validation = _graph_result(validation_base, registry=await _decision_registry(validation_base))
        if validation["valid"] is not True or any(validation[key] != target_validation[key] for key in ("graphRevision", "schemaLockDigest", "rootDigest")):
            _fail("CHANGESET_TARGET_VALIDATION_FAILED", "/outputPath")
        try:
            await _decision_api_io("mkdir", output)
            claimed = True
        except OSError as error:
            if getattr(error, "code", None) == "EEXIST":
                _fail("PACKAGE_OUTPUT_EXISTS", output)
            raise
        await _decision_api_io("rename", metadata, os.path.join(output, ".morivyx"))
        await _decision_api_io("rm", temporary, {"recursive": True, "force": True})
    except BaseException:
        if temporary_created:
            await _decision_api_io("rm", temporary, {"recursive": True, "force": True})
        if claimed:
            await _decision_api_io("rm", output, {"recursive": True, "force": True})
        raise
    return {"valid": True, "outputPath": output, "metadataPath": os.path.join(output, ".morivyx"),
            "graphRevision": applied["revision"]["id"], "rootDigest": applied["rootDigest"],
            "elementCount": len(applied["elements"]), "changeSetId": change_set["id"]}
