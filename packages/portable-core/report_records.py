"""Report records and separate awaitable file APIs; no adoption authority."""

import asyncio
import errno
import json
import os
import re
import stat
from uuid import uuid4

from canonical import canonical_json, digest, timestamp_text
from report_validation import validate_report
from yaml_authoring import read_authoring_yaml
from schema_validation import ValidationError
from yaml_records import write_yaml, serialize_yaml_record, mapping_pair, key_value, scalar, double_string, closes_double_quote


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


def _report_path(path):
    if type(path) is not str:
        error = TypeError("report path must be text")
        error.code = "ERR_INVALID_ARG_TYPE"
        raise error
    if "\0" in path:
        error = TypeError("report path contains NUL")
        error.code = "ERR_INVALID_ARG_VALUE"
        raise error
    return path


def _report_os_error(error):
    if isinstance(error, OSError):
        if not hasattr(error, "code"):
            error.code = errno.errorcode.get(error.errno)
        if not hasattr(error, "path"):
            error.path = error.filename
    return error


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


def _report_profile_diagnostic(text):
    """Locate rejected scalar spellings without making them executable data.

    The independent block parser handles accepted syntax. This pass separates
    syntax failures from the authoring restrictions that apply after YAML parse.
    """
    frames, sequence_counts = [(-1, "", "root")], {}
    raw_seen, normalized_seen = {}, {}
    first_profile, syntax = None, False
    quoted = False

    def child(path, key):
        return path + "/" + str(key).replace("~", "~0").replace("/", "~1")

    def profile(path):
        nonlocal first_profile
        if first_profile is None:
            first_profile = path

    def flow_complete(token):
        stack, quote, escape = [], None, False
        for character in token:
            if escape:
                escape = False
            elif quote:
                if quote == '"' and character == "\\":
                    escape = True
                elif character == quote:
                    quote = None
            elif character in "\"'":
                quote = character
            elif character in "[{":
                stack.append(character)
            elif character in "]}":
                if not stack or (stack.pop(), character) not in (("[", "]"), ("{", "}")):
                    return False
        return not stack and quote is None

    lines = text.split("\n")
    for line_number, raw in enumerate(lines):
        text_line = raw.lstrip(" ")
        if quoted:
            if closes_double_quote(text_line):
                quoted = False
            continue
        if not text_line:
            continue
        indent = len(raw) - len(text_line)
        sequence = text_line == "-" or text_line.startswith("- ")
        while len(frames) > 1 and indent <= frames[-1][0]:
            if sequence and indent == frames[-1][0] and frames[-1][2] == "container":
                break
            frames.pop()
        parent = frames[-1][1]
        if text_line.startswith("#"):
            profile(parent)
            continue
        while text_line.startswith("- ") or text_line == "-":
            counter = (parent, indent)
            index = sequence_counts.get(counter, 0)
            sequence_counts[counter] = index + 1
            parent = child(parent, index)
            frames.append((indent, parent, "item"))
            payload = text_line[1:].lstrip(" ")
            indent += len(text_line) - len(payload)
            text_line = payload
        if text_line.startswith("? "):
            if text_line[2:].lstrip().startswith(("[", "{", "|", ">")):
                profile(parent)
            continue
        pair = mapping_pair(text_line)
        if pair is None:
            token, location = text_line, parent
        else:
            spelling, token = pair
            try:
                key = key_value(spelling, allow_merge_keys=True)
            except ValueError:
                profile(parent)
                continue
            try:
                raw_key = json.loads(spelling) if spelling.startswith('"') else spelling[1:-1].replace("''", "'") if spelling.startswith("'") else spelling
            except (ValueError, TypeError):
                raw_key = key
            if raw_key in raw_seen.setdefault(parent, set()):
                syntax = True
            raw_seen[parent].add(raw_key)
            if key in normalized_seen.setdefault(parent, set()) or key == "<<":
                profile(parent)
            normalized_seen[parent].add(key)
            location = child(parent, key)
        if not token:
            following = next((row for row in lines[line_number + 1:] if row.strip()), None)
            if following is None or (len(following) - len(following.lstrip(" ")) <= indent and not following.lstrip().startswith("-")):
                profile(location)
            else:
                frames.append((indent, location, "container"))
            continue
        if token.startswith(("&", "*", "!", "|", ">", "'")):
            profile(location)
        elif token.startswith(("[", "{")) and not re.fullmatch(r"\[ *\]|\{ *\}", token):
            if flow_complete(token):
                profile(location)
            else:
                syntax = True
        elif token.startswith('"'):
            if not closes_double_quote(token, 1):
                quoted = True
                continue
            try:
                double_string(token)
            except UnicodeError:
                profile(location)
            except ValueError:
                if re.search(r"\s#", token):
                    profile(location)
                else:
                    syntax = True
        else:
            try:
                scalar(token)
            except ValueError:
                profile(location)
    return (None if syntax else first_profile), syntax


def _report_read_yaml(path):
    _report_path(path)
    try:
        with open(path, "rb") as stream:
            source = stream.read()
    except FileNotFoundError:
        _report_failure("PACKAGE_FILE_MISSING", path)
    try:
        text = source.decode("utf-8", errors="strict")
    except UnicodeError:
        _report_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path)
    if (text.startswith("\ufeff") or "\r" in text or "\t" in text or
            re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text) or not text.endswith("\n") or
            re.search(r"\n *\n$", text) or re.search(r"^(?:%.*|---(?:[ \t]|$)|\.\.\.(?:[ \t]|$))", text, re.M)):
        _report_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path)
    try:
        return read_authoring_yaml(text, max_bytes=None, max_depth=None)
    except ValidationError as error:
        _report_failure(error.code, path + ("#" + error.path if error.path else ""))
    except (ValueError, TypeError) as error:
        location, syntax = _report_profile_diagnostic(text)
        if not syntax:
            if location is not None:
                _report_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path + ("#" + location if location else ""))
            traceback = error.__traceback__
            while traceback:
                if traceback.tb_frame.f_code in (canonical_json.__code__, timestamp_text.__code__):
                    _report_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path)
                traceback = traceback.tb_next
        _report_failure("PACKAGE_YAML_INVALID", path)


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
