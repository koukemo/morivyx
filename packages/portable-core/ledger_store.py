"""Independent append-only ledger file operations and compatible package reader.

Checks structures, authoring, digests and ledger bindings. Does not authenticate
actors, apply Graph changes or provide a snapshot against unrelated writers.
Same-ID cooperating writers share an exclusive lock and publish by hard link.
"""

from contextlib import contextmanager
import errno
from functools import wraps
import os
import re
import stat
import time
from uuid import uuid4

from approval_validation import validate_approval, validate_approval_ledger
from canonical import canonical_json, digest, unicode_text
from migration_validation import validate_migration, validate_migration_change_set
from record_validation import _revision_keys, validate_change_set, validate_graph_revision, validate_schema_lock
from report_records import prepare_report
from schema_validation import ValidationError, pointer, validate_graph_element
from yaml_authoring import read_authoring_yaml
from yaml_records import read_yaml, write_yaml


COLLECTIONS = (
    ("graph/entities", "elements", validate_graph_element, "entity"),
    ("graph/relations", "elements", validate_graph_element, "relation"),
    ("approvals", "approvals", validate_approval, None),
    ("ledger", "changeSets", validate_change_set, None),
    ("migrations", "migrations", validate_migration, None),
    ("reports", "reports", prepare_report, None),
)


def _diagnostics(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except OSError as error:
            error.code = errno.errorcode.get(error.errno)
            error.path = error.filename
            raise
    return call


def _metadata(path):
    if type(path) is not str:
        error = TypeError("package path must be a string")
        error.code = "ERR_INVALID_ARG_TYPE"
        raise error
    absolute = os.path.abspath(path)
    return absolute if os.path.basename(absolute) == ".morivyx" else os.path.join(absolute, ".morivyx")


def _logical_order(value, memo=None):
    """Reproduce source object-key enumeration without invoking host methods."""
    if type(value) not in (dict, list):
        return value
    memo = {} if memo is None else memo
    if id(value) in memo:
        return memo[id(value)]
    result = {} if type(value) is dict else []
    memo[id(value)] = result
    if type(value) is dict:
        for key in _revision_keys(value):
            result[key] = _logical_order(value[key], memo)
    else:
        result.extend(_logical_order(entry, memo) for entry in value)
    return result


def _validate(function, value, path=""):
    try:
        return function(_logical_order(value))
    except ValidationError as error:
        if path:
            raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
        raise


def _approval_ledger(records, paths):
    try:
        validate_approval_ledger(records)
    except ValidationError as error:
        match = re.match(r"/approvals/([0-9]+)(.*)", error.path)
        if match and paths[int(match[1])]:
            path = paths[int(match[1])]
            raise ValidationError(error.code, path + ("#" + match[2] if match[2] else "")) from None
        raise


def _migration_binding(record, change_set, path=""):
    try:
        validate_migration_change_set(record, change_set)
    except ValidationError as error:
        if path:
            raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
        raise


def _read_yaml(path):
    try:
        with open(path, "rb") as stream:
            source = stream.read()
    except FileNotFoundError:
        raise ValidationError("PACKAGE_FILE_MISSING", path) from None
    try:
        text = source.decode("utf-8", errors="strict")
    except UnicodeError:
        raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path) from None
    if text.startswith("\ufeff") or "\r" in text or "\t" in text or any(ord(c) < 32 and c != "\n" for c in text):
        raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path)
    try:
        return read_authoring_yaml(text, max_bytes=None, max_depth=None)
    except ValidationError as error:
        raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
    except (ValueError, TypeError) as error:
        if "merge key" in str(error):
            # The source writer can emit this key, but its readback authoring
            # policy rejects it at the containing map. Never perform a merge.
            try:
                parsed = read_yaml(text, max_bytes=None, max_depth=None, allow_merge_keys=True)
            except (ValueError, TypeError):
                pass
            else:
                def reject_merge(value, location=""):
                    if type(value) is dict:
                        if "<<" in value:
                            raise ValidationError("PACKAGE_AUTHORING_PROFILE_INVALID", path + ("#" + location if location else ""))
                        for key, item in value.items():
                            reject_merge(item, pointer(location, key))
                    elif type(value) is list:
                        for index, item in enumerate(value):
                            reject_merge(item, pointer(location, index))
                reject_merge(parsed)
        raise ValidationError("PACKAGE_YAML_INVALID", path) from None


def _safe_tree(directory):
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        raise ValidationError("PACKAGE_PATH_INVALID", directory)
    pending = [directory]
    while pending:
        current = pending.pop()
        with os.scandir(current) as entries:
            entries = sorted(entries, key=lambda entry: entry.name)
        for entry in entries:
            if entry.is_symlink() or not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                raise ValidationError("PACKAGE_PATH_INVALID", entry.path)
            if entry.is_dir(follow_symlinks=False):
                pending.append(entry.path)


def _yaml_files(directory):
    try:
        with os.scandir(directory) as entries:
            return sorted(entry.path for entry in entries if entry.is_file(follow_symlinks=False) and entry.name.endswith(".yaml"))
    except FileNotFoundError:
        return []


@_diagnostics
def read_ledger_package(path):
    """Read the Node ledger package selection, including ordinary unknown files.

    Unlike the separate bounded package_records reader, ancestor symlinks and
    regular hard links are accepted. All symlinks/special files inside the
    metadata tree are rejected. This is not a concurrent filesystem snapshot.
    """
    directory = _metadata(path)
    _safe_tree(directory)
    lock_path = os.path.join(directory, "schema.lock.yaml")
    revision_path = os.path.join(directory, "revision.yaml")
    schema_lock, revision = _read_yaml(lock_path), _read_yaml(revision_path)
    _validate(validate_schema_lock, schema_lock, lock_path)
    _validate(validate_graph_revision, revision, revision_path)
    result = {"directory": directory, "schemaLock": schema_lock, "revision": revision,
              **{field: [] for field in ("elements", "approvals", "changeSets", "migrations", "reports")}}
    paths, records = {field: [] for field in result if type(result[field]) is list}, []
    for subdirectory, field, validator, kind in COLLECTIONS:
        for source_path in _yaml_files(os.path.join(directory, subdirectory)):
            record = _read_yaml(source_path)
            prepared = _validate(validator, record, source_path)
            if field == "reports":
                if "id" not in record:
                    raise ValidationError("REPORT_ID_REQUIRED", source_path + "#/id")
            else:
                if os.path.basename(source_path) != record["id"][9:] + ".yaml":
                    raise ValidationError("PACKAGE_FILENAME_ID_MISMATCH", source_path)
                if kind and record["kind"] != kind:
                    raise ValidationError("GRAPH_ELEMENT_KIND_MISMATCH", source_path)
            records.append((source_path, record))
            result[field].append(prepared if field == "reports" else record)
            paths[field].append(source_path)
    seen = set()
    for source_path, record in records:
        if record["id"] in seen:
            raise ValidationError("ID_DUPLICATE", source_path)
        seen.add(record["id"])
    _approval_ledger(result["approvals"], paths["approvals"])
    changes = {record["id"]: record for record in result["changeSets"]}
    for record, source_path in zip(result["migrations"], paths["migrations"]):
        _migration_binding(record, changes.get(record["changeSetId"]), source_path)
    for record, source_path in zip(result["elements"], paths["elements"]):
        if record["revision"] != digest("revision", record)["digest"]:
            raise ValidationError("REVISION_ID_MISMATCH", source_path)
    result["elements"].sort(key=lambda record: record["id"])
    result["calculatedSchemaLockDigest"] = digest("schema-lock", schema_lock)["digest"]
    if revision["schemaLockDigest"] != result["calculatedSchemaLockDigest"]:
        raise ValidationError("SCHEMA_LOCK_DIGEST_MISMATCH", revision_path)
    result["calculatedRootDigest"] = digest("root", result["elements"])["digest"]
    if revision["rootDigest"] != result["calculatedRootDigest"]:
        raise ValidationError("ROOT_DIGEST_MISMATCH", revision_path)
    return result


@contextmanager
def _id_lock(directory, identity):
    path = os.path.join(directory, ".record-id-" + identity[9:] + ".lock")
    for _attempt in range(200):
        try:
            handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            time.sleep(0.005)
    else:
        raise ValidationError("PACKAGE_RECORD_BUSY", path)
    try:
        yield
    finally:
        os.close(handle)
        _remove(path)


def _remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _serialize(record):
    active = set()

    def structure(value, path):
        if type(value) is str:
            try:
                unicode_text(value)
            except ValueError:
                raise ValidationError("YAML_SERIALIZATION_INVALID", path) from None
        elif type(value) in (dict, list):
            if id(value) in active:
                raise ValidationError("YAML_SERIALIZATION_INVALID", path)
            active.add(id(value))
            try:
                entries = value.items() if type(value) is dict else enumerate(value)
                for key, item in entries:
                    if type(value) is dict:
                        if type(key) is not str:
                            raise ValidationError("YAML_SERIALIZATION_INVALID", path)
                        structure(key, path)
                    structure(item, pointer(path, key))
            finally:
                active.remove(id(value))
        elif value is not None and type(value) not in (int, float, bool):
            raise ValidationError("YAML_SERIALIZATION_INVALID", path)

    def normalized(value, path):
        if value is None:
            raise ValidationError("YAML_SERIALIZATION_INVALID", path)
        if type(value) is dict:
            seen = set()
            for key in _revision_keys(value):
                name = unicode_text(key)
                location = pointer(path, name)
                if name in seen:
                    raise ValidationError("YAML_SERIALIZATION_INVALID", location)
                seen.add(name)
                normalized(value[key], location)
        elif type(value) is list:
            for index, item in enumerate(value):
                normalized(item, pointer(path, index))
        else:
            try:
                canonical_json(value)
            except (TypeError, ValueError):
                raise ValidationError("YAML_SERIALIZATION_INVALID", path) from None

    try:
        structure(record, "")
        # Source serialization checks nulls throughout before normalizing values.
        def nulls(value, path=""):
            if value is None:
                raise ValidationError("YAML_SERIALIZATION_INVALID", path)
            if type(value) is dict:
                for key in _revision_keys(value):
                    nulls(value[key], pointer(path, unicode_text(key)))
            elif type(value) is list:
                for index, item in enumerate(value):
                    nulls(item, pointer(path, index))
        nulls(record)
        normalized(record, "")
        source = write_yaml(record, max_bytes=None, max_depth=None, allow_merge_keys=True)
        # Match the source writer's spelling without changing quoted literal
        # backslashes. Other YAML entry points keep their existing spelling.
        def source_escape(match):
            slashes, code = match.groups()
            if len(slashes) % 2 == 0:
                return match[0]
            number = int(code, 16)
            if number in (0x2028, 0x2029):
                replacement = chr(number)
            else:
                replacement = "\\" + {0: "0", 7: "a", 11: "v", 27: "e"}.get(number, "x" + code[-2:])
            return slashes[:-1] + replacement
        return re.sub(r"(\\+)u(00[01][0-9a-f]|202[89])", source_escape, source)
    except ValidationError:
        raise
    except (TypeError, ValueError):
        raise ValidationError("YAML_SERIALIZATION_INVALID", "") from None


def _publish(directory, record, validator, exists_code, digest_kind):
    try:
        os.mkdir(directory)
    except FileExistsError:
        if not stat.S_ISDIR(os.lstat(directory).st_mode):
            raise ValidationError("PACKAGE_RECORD_OUTPUT_INVALID", directory) from None
    target = os.path.join(directory, record["id"][9:] + ".yaml")
    temporary = os.path.join(directory, f".record-{os.getpid()}-{uuid4()}.tmp")
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(_serialize(record).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        persisted = _read_yaml(temporary)
        _validate(validator, persisted, temporary)
        if canonical_json(persisted) != canonical_json(record) or (digest_kind and
                digest(digest_kind, persisted) != digest(digest_kind, record)):
            raise ValidationError("PACKAGE_RECORD_DIGEST_MISMATCH", temporary)
        try:
            os.link(temporary, target)
        except FileExistsError:
            raise ValidationError(exists_code, target) from None
    finally:
        _remove(temporary)
    result = {"valid": True, "path": target}
    if digest_kind:
        result["digest"] = digest(digest_kind, record)["digest"]
    return result


def _write(path, record, field, validator, subdirectory, exists_code, digest_kind=None):
    _validate(validator, record)
    directory = _metadata(path)
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        raise ValidationError("PACKAGE_RECORD_PACKAGE_MISSING", directory) from None
    if not stat.S_ISDIR(info.st_mode):
        raise ValidationError("PACKAGE_RECORD_PACKAGE_MISSING", directory)
    target = os.path.join(directory, subdirectory, record["id"][9:] + ".yaml")
    with _id_lock(directory, record["id"]):
        package = read_ledger_package(directory)
        if field == "migrations":
            change = next((row for row in package["changeSets"] if row["id"] == record["changeSetId"]), None)
            _migration_binding(record, change)
        for category in ("elements", "approvals", "changeSets", "migrations", "reports"):
            rows = [entry["report"] for entry in package[category]] if category == "reports" else package[category]
            if any(entry["id"] == record["id"] for entry in rows):
                raise ValidationError(exists_code if category == field else "ID_DUPLICATE", target)
        if field == "approvals":
            _approval_ledger([*package[field], record], [*["" for _ in package[field]], target])
        return _publish(os.path.join(directory, subdirectory), record, validator, exists_code, digest_kind)


@_diagnostics
def write_approval(path, approval):
    """Append an Approval after structural and withdrawal-link checks."""
    return _write(path, approval, "approvals", validate_approval, "approvals", "APPROVAL_ALREADY_EXISTS")


@_diagnostics
def write_change_set(path, change_set):
    """Append a ChangeSet without applying its operations to the Graph."""
    return _write(path, change_set, "changeSets", validate_change_set, "ledger", "CHANGESET_ALREADY_EXISTS", "changeset")


@_diagnostics
def write_migration(path, migration):
    """Append a Migration bound to an already stored ChangeSet."""
    return _write(path, migration, "migrations", validate_migration, "migrations", "MIGRATION_ALREADY_EXISTS", "migration")
