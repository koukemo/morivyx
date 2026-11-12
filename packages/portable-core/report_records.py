"""Report records and separate awaitable file APIs; no adoption authority."""

import asyncio
import errno
import os
import stat
from uuid import uuid4

from canonical import digest
from report_validation import validate_report
from yaml_authoring import (read_authoring_yaml, _file_path as _report_path,
                            _file_os_error as _report_os_error, _read_record_file as _report_read_yaml)
from schema_validation import ValidationError
from yaml_records import write_yaml, serialize_yaml_record


REPORT_TYPES = {
    "morivyx.trace-report/0.1": "trace-report",
    "morivyx.semantic-diff/0.1": "semantic-diff",
    "morivyx.migration-semantic-diff/0.1": "migration-semantic-diff",
    "morivyx.external-artifact-report/0.1": "external-artifact-report",
}


def prepare_report(report):
    """Validate structure and calculate a digest, without authenticating content."""
    result = validate_report(report)
    return {"valid": True, **result, "digest": digest(result["type"], report)["digest"]}


def read_report_source(source):
    """Check bounded YAML authoring policies and the logical report record."""
    return prepare_report(read_authoring_yaml(source))


def serialize_report_yaml(report):
    """Return checked YAML; optional report ID remains optional outside a package."""
    prepare_report(report)
    return write_yaml(report)


def _report_failure(code, path):
    raise ValidationError(code, path)


def _report_order(value):
    # Reorder only the maps the validators actually visit. An unknown field may
    # contain an arbitrarily deep value that must not precede its field error.
    from record_validation import _revision_keys

    def mapping(item):
        return {key: item[key] for key in _revision_keys(item)} if type(item) is dict else item

    result = mapping(value)
    if type(result) is not dict:
        return result
    format_id = result.get("format")
    if format_id == "morivyx.trace-report/0.1" and type(result.get("paths")) is list:
        result["paths"] = [mapping(item) for item in result["paths"]]
        for item in result["paths"]:
            if type(item) is dict and type(item.get("hops")) is list:
                item["hops"] = [mapping(hop) for hop in item["hops"]]
    elif format_id in ("morivyx.semantic-diff/0.1", "morivyx.migration-semantic-diff/0.1") and type(result.get("entries")) is list:
        result["entries"] = [mapping(item) for item in result["entries"]]
    elif format_id == "morivyx.external-artifact-report/0.1":
        for field in ("artifact", "externalSource", "relation", "retrieval"):
            if field in result:
                result[field] = mapping(result[field])
        if type(result.get("issues")) is list:
            result["issues"] = [mapping(item) for item in result["issues"]]
    return result


def _report_string_failure(value):
    return (type(value) is dict and "toString" in value) or (
        type(value) is list and any(_report_string_failure(item) for item in value))


def _report_validate(report, path=""):
    raw_format = report.get("format") if type(report) is dict else None
    if type(raw_format) is not str and _report_string_failure(raw_format):
        raise TypeError("format cannot be represented as text")
    try:
        return validate_report(_report_order(report))
    except ValidationError as error:
        if path:
            raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
        raise


def _report_read(path):
    try:
        record = _report_read_yaml(path)
        result = _report_validate(record, path)
        return {"valid": True, "type": result["type"], "digest": digest(result["type"], record)["digest"], "report": record}
    except OSError as error:
        raise _report_os_error(error)


async def read_report(path):
    """Read one explicitly selected report, without a Graph or trust verdict."""
    return await asyncio.to_thread(_report_read, path)


def _report_id_tail(identity):
    if type(identity) is str:
        return identity[9:]
    if type(identity) is list:
        def text(value):
            if value is None:
                return ""
            if type(value) is list:
                return ",".join(text(v) for v in value)
            if type(value) is dict:
                if "toString" in value:
                    raise TypeError("ID cannot be represented as text")
                return "[object Object]"
            return str(value).lower() if type(value) is bool else str(value)
        return ",".join(text(v) for v in identity[9:])
    raise TypeError("report ID has no slice operation")


def _report_remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _report_save(path, report, prepared):
    from ledger_store import _id_lock, _yaml_files
    try:
        absolute = os.path.abspath(_report_path(path))
        directory = absolute if os.path.basename(absolute) == ".morivyx" else os.path.join(absolute, ".morivyx")
        try:
            information = os.lstat(directory)
        except FileNotFoundError:
            _report_failure("REPORT_PACKAGE_MISSING", directory)
        if not stat.S_ISDIR(information.st_mode):
            _report_failure("REPORT_PACKAGE_MISSING", directory)
        output = os.path.join(directory, "reports")
        target = os.path.join(output, _report_id_tail(report.get("id")) + ".yaml")
        with _id_lock(directory, "urn:uuid:" + _report_id_tail(report.get("id"))):
            identity = report.get("id")
            locations = [("graph-element", "graph/entities"), ("graph-element", "graph/relations"),
                         ("approval", "approvals"), ("change-set", "ledger"), ("migration", "migrations"), ("report", "reports")]
            # Load all locations before deciding a duplicate, matching the
            # original precedence when a later record cannot be read.
            stored = [(kind, [_report_read_yaml(file) for file in _yaml_files(os.path.join(directory, folder))])
                      for kind, folder in locations]
            for kind, records in stored:
                if any(type(identity) is str and type(row.get("id")) is str and row["id"] == identity for row in records):
                    _report_failure("REPORT_ALREADY_EXISTS" if kind == "report" else "ID_DUPLICATE", target)
            try:
                os.mkdir(output)
            except FileExistsError:
                if not stat.S_ISDIR(os.lstat(output).st_mode):
                    _report_failure("PACKAGE_RECORD_OUTPUT_INVALID", output)
            temporary = os.path.join(output, ".report-" + str(os.getpid()) + "-" + str(uuid4()) + ".tmp")
            handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            try:
                content = prepared["source"].encode("utf-8")
                offset = 0
                while offset < len(content):
                    written = os.write(handle, content[offset:])
                    if not written:
                        raise OSError(errno.EIO, "report write made no progress", temporary)
                    offset += written
                os.fsync(handle)
            except BaseException:
                os.close(handle)
                _report_remove(temporary)
                raise
            os.close(handle)
            try:
                os.link(temporary, target)
            except FileExistsError:
                _report_failure("REPORT_ALREADY_EXISTS", target)
            finally:
                _report_remove(temporary)
            return {"valid": True, "type": prepared["type"], "digest": prepared["digest"], "path": target}
    except OSError as error:
        raise _report_os_error(error)


def write_report(path, report):
    """Capture validation and source now; return an awaitable exclusive save.

    The input record remains referenced across the filesystem wait, including
    its ID. Do not mutate an input while using its pending operation.
    """
    try:
        validated = _report_validate(report)
        if "id" not in report:
            _report_failure("REPORT_ID_REQUIRED", "/id")
        prepared = {"type": validated["type"], "digest": digest(validated["type"], report)["digest"],
                    "source": serialize_yaml_record(report)}
    except Exception as error:
        async def rejected(failure=error):
            raise failure
        return rejected()

    async def save():
        await asyncio.sleep(0)
        return await asyncio.to_thread(_report_save, path, report, prepared)
    return save()
