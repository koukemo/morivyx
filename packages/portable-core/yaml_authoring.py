"""Authoring policies and separate file reads; no structural/Graph verdict."""

import asyncio
import errno
import json
import os
import re

from canonical import unicode_text

from schema_validation import ValidationError
from yaml_records import (MAX_BYTES, MAX_DEPTH, ORDERS, field_order, read_yaml,
                          closes_double_quote, closes_single_quote, double_string,
                          key_value, mapping_pair, plain_key, scalar, yaml_quote)


ROOT_ORDERS = {key: value.split() for key, value in ORDERS.items()}
ROOT_ORDERS.update({
    "morivyx.schema/0.1": "format schemaId version stableIdScheme digestAlgorithm reviewStates entityTypes relationTypes authoringOrders".split(),
    "morivyx.decision-creation-request/0.1": "format decisionId attributes changeSetId resultingRevision actor recordedAt".split(),
    "morivyx.decision-revision-request/0.1": "format decisionId attributes changeSetId resultingRevision actor recordedAt".split(),
})


def child(path, key):
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def known_order(value, order, path, prefixed=False):
    if type(value) is not dict:
        return
    positions = {key: index for index, key in enumerate(order)}
    previous, unknown, extra = -1, None, False
    for key in value:
        if key in positions:
            position = positions[key]
            if position <= previous or (prefixed and extra):
                raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
            previous = position
        elif prefixed:
            if unknown is not None and unknown >= key:
                raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
            unknown, extra = key, True


def sorted_map(value, path, recursive=False):
    if type(value) is list and recursive:
        for index, entry in enumerate(value):
            sorted_map(entry, child(path, index), True)
    if type(value) is not dict:
        return
    previous = None
    for key, entry in value.items():
        if previous is not None and previous >= key:
            raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(path, key))
        previous = key
    if recursive:
        for key, entry in value.items():
            sorted_map(entry, child(path, key), True)


def sequence_order(root, key, order, path=""):
    if type(root) is not dict or type(root.get(key)) is not list:
        return
    for index, entry in enumerate(root[key]):
        known_order(entry, order, child(child(path, key), index))


def authoring_order(record, format_id):
    known_order(record, ROOT_ORDERS[format_id], "")
    if format_id in ("morivyx.git-graph/0.1", "morivyx.decision-creation-request/0.1", "morivyx.decision-revision-request/0.1"):
        sorted_map(record.get("attributes"), "/attributes")
    if format_id in ("morivyx.git-graph/0.1", "morivyx.changeset/0.1", "morivyx.migration/0.1"):
        known_order(record.get("provenance"), "method actor recordedAt".split(), "/provenance", True)
    if format_id == "morivyx.git-graph/0.1":
        sorted_map(record.get("extensions"), "/extensions", True)
    if format_id == "morivyx.schema-lock/0.1":
        sequence_order(record, "schemas", field_order(format_id, ("schemas", "*")))
    if format_id == "morivyx.changeset/0.1":
        sequence_order(record, "operations", field_order(format_id, ("operations", "*")))
    if format_id == "morivyx.trace-report/0.1":
        sequence_order(record, "paths", ["hops"])
        if type(record.get("paths")) is list:
            for index, entry in enumerate(record["paths"]):
                sequence_order(entry, "hops", field_order(format_id, ("paths", "*", "hops", "*")), child("/paths", index))
    if format_id in ("morivyx.semantic-diff/0.1", "morivyx.migration-semantic-diff/0.1"):
        sequence_order(record, "entries", field_order(format_id, ("entries", "*")))
    if format_id == "morivyx.external-artifact-report/0.1":
        for key in ("artifact", "externalSource", "relation", "retrieval"):
            known_order(record.get(key), field_order(format_id, (key,)), child("", key))
        sequence_order(record, "issues", ["code"])
    if format_id == "morivyx.schema/0.1":
        sequence_order(record, "entityTypes", "typeId requiredAttributes optionalAttributes lifecycle".split())
        sequence_order(record, "relationTypes", "predicate sourceTypes targetTypes minCount maxCount cycle".split())
        known_order(record.get("authoringOrders"), "root attributes provenance".split(), "/authoringOrders")


def null_allowed(format_id, path, status):
    if format_id == "morivyx.graph-revision/0.1":
        return path == "/parentRevision"
    if format_id == "morivyx.schema/0.1":
        return re.fullmatch(r"/relationTypes/[0-9]+/maxCount", path) is not None
    if format_id == "morivyx.git-graph/0.1":
        return path.startswith("/extensions/")
    if format_id == "morivyx.external-artifact-report/0.1" and status == "invalid":
        return path in ("/graphRevision", "/retrieval", "/comparedAt", "/artifact/lifecycle") or re.fullmatch(
            r"/(?:artifact|externalSource|relation)/(?:id|revision)|/retrieval/(?:status|comparedAt|digest|digestRule|externalVersion|method|reason)", path) is not None
    return False


def null_policy(value, format_id, status, path=""):
    if value is None and not null_allowed(format_id, path, status):
        raise ValidationError("PACKAGE_NULL_INVALID", path)
    if type(value) is dict:
        for key, entry in value.items():
            null_policy(entry, format_id, status, child(path, key))
    elif type(value) is list:
        for index, entry in enumerate(value):
            null_policy(entry, format_id, status, child(path, index))


def string_set(value, path):
    if type(value) is not list:
        return
    previous = None
    for index, entry in enumerate(value):
        if type(entry) is not str:
            continue
        if previous is not None and previous >= entry:
            raise ValidationError("PACKAGE_SET_ORDER_INVALID", child(path, index))
        previous = entry


def map_set(value, identity, nested, path):
    if type(value) is not list:
        return
    previous = None
    for index, entry in enumerate(value):
        if type(entry) is not dict:
            continue
        location = child(path, index)
        current = entry.get(identity)
        if type(current) is str:
            if previous is not None and previous >= current:
                raise ValidationError("PACKAGE_SET_ORDER_INVALID", child(location, identity))
            previous = current
        for key in nested:
            string_set(entry.get(key), child(location, key))


def read_authoring_yaml(source, *, max_bytes=MAX_BYTES, max_depth=MAX_DEPTH):
    """Read supported block syntax and check authoring policies for known formats.

    Missing fields, unknown keys and incorrect semantic types belong to record
    validators. Unknown formats receive only the bounded syntax checks.
    """
    record = read_yaml(source, max_bytes=max_bytes, max_depth=max_depth)
    format_id = record.get("format")
    if type(format_id) is not str or format_id not in ROOT_ORDERS:
        return record
    authoring_order(record, format_id)
    null_policy(record, format_id, record.get("status"))
    if format_id == "morivyx.trace-report/0.1":
        string_set(record.get("missing"), "/missing")
    elif format_id == "morivyx.schema/0.1":
        string_set(record.get("reviewStates"), "/reviewStates")
        map_set(record.get("entityTypes"), "typeId", ("requiredAttributes", "optionalAttributes", "lifecycle"), "/entityTypes")
        map_set(record.get("relationTypes"), "predicate", ("sourceTypes", "targetTypes"), "/relationTypes")
    return record


class _FileYamlSyntaxError(ValueError):
    pass


def _file_scalar(token, path):
    try:
        return scalar(token)
    except ValueError as error:
        error._yaml_profile_path = path
        raise


def _file_missing_value(path):
    error = ValueError("missing block value")
    error._yaml_profile_path = path
    raise error


def _file_parse_yaml(source):
    """Parse the supported syntax with explicit suspended frames, without date semantics."""
    max_bytes, max_depth, allow_merge_keys = None, None, False
    if type(source) is bytes:
        if max_bytes is not None and len(source) > max_bytes:
            raise ValueError("YAML input too large")
        source = source.decode("utf-8", errors="strict")
    if type(source) is not str or (max_bytes is not None and len(source.encode("utf-8")) > max_bytes):
        raise ValueError("invalid YAML source")
    if source.startswith("\ufeff") or "\r" in source or "\t" in source:
        raise ValueError("BOM, carriage return and tab are forbidden")
    if any(ord(c) < 0x20 and c != "\n" for c in source):
        raise ValueError("raw non-printable YAML character")
    if not source.endswith("\n") or re.search(r"\n *\n$", source):
        raise ValueError("expected exactly one final newline")
    lines = []
    physical = source.split("\n")[:-1]
    line_number = 0

    def next_content_line():
        nonlocal line_number
        while line_number < len(physical):
            raw = physical[line_number]
            line_number += 1
            if raw.strip(" "):
                return raw
        raise ValueError("missing explicit YAML key or value")

    def explicit_pair(text, indent):
        """Lower an explicit scalar key to the existing block-pair grammar."""
        nonlocal line_number
        token = text[1:].lstrip(" ")
        if not token:
            raw = next_content_line()
            if len(raw) - len(raw.lstrip(" ")) <= indent:
                raise ValueError("invalid explicit key indentation")
            token = raw.lstrip(" ")
        if token[0] in "\"'":
            closes = closes_double_quote if token[0] == '"' else closes_single_quote
            fragments = [token]
            closed = closes(token, 1)
            while not closed:
                if line_number >= len(physical):
                    raise _FileYamlSyntaxError("unterminated explicit key")
                raw = physical[line_number]
                line_number += 1
                if raw.strip(" ") and len(raw) - len(raw.lstrip(" ")) <= indent:
                    raise _FileYamlSyntaxError("invalid explicit key continuation")
                fragments.append(raw)
                closed = closes(raw)
            key = key_value("\n".join(fragments).rstrip(" "))
        else:
            fragments = [token.rstrip(" ")]
            while line_number < len(physical):
                raw = physical[line_number]
                if raw.strip(" ") and len(raw) - len(raw.lstrip(" ")) <= indent:
                    break
                line_number += 1
                fragments.append(raw.strip(" "))
            # Fold internal empty lines, but not separation before the ':' line.
            folded, blanks = [], 0
            for fragment in fragments:
                if not fragment:
                    blanks += 1
                    continue
                if folded:
                    folded.append("\n" * blanks if blanks else " ")
                folded.append(fragment)
                blanks = 0
            folded = "".join(folded)
            if not plain_key(folded.replace("\n", " ")):
                raise ValueError("unsupported explicit plain key")
            key = unicode_text(folded)
            if key == "<<" and not allow_merge_keys:
                raise ValueError("YAML merge key is forbidden")
        raw = next_content_line()
        value_text = raw.lstrip(" ")
        if len(raw) - len(value_text) < indent:
            raise _FileYamlSyntaxError("explicit value is outside its key indentation")
        if len(raw) - len(value_text) != indent or not (value_text == ":" or value_text.startswith(": ")):
            raise ValueError("expected explicit value at the key indentation")
        payload = value_text[1:]
        payload_indent = indent + 1 + len(payload) - len(payload.lstrip(" "))
        return yaml_quote(key), payload.lstrip(" "), payload_indent

    while line_number < len(physical):
        raw = physical[line_number]
        line_number += 1
        text = raw.lstrip(" ")
        indent = len(raw) - len(raw.lstrip(" "))
        if not text:
            continue
        if text.startswith(("%", "#")) or re.match(r"(?:---|\.\.\.)(?: |$)", text):
            raise ValueError("YAML directives, document markers and comments are forbidden")
        # Expand compact block list mappings into the same indentation grammar.
        compact_depth = 0
        explicit_key = False
        while True:
            while text.startswith("- "):
                payload = text[1:].lstrip(" ")
                if not (payload.startswith(("- ", "? ")) or payload in ("-", "?") or mapping_pair(payload) is not None):
                    break
                compact_depth += 1
                if max_depth is not None and compact_depth > max_depth:
                    raise ValueError("compact YAML nesting too deep")
                lines.append((indent, "-"))
                indent += len(text) - len(payload)
                text = payload
            if text == "?" or text.startswith("? "):
                key, payload, payload_indent = explicit_pair(text, indent)
                if payload in ("-", "?") or payload.startswith(("- ", "? ")) or mapping_pair(payload) is not None:
                    compact_depth += 1
                    if max_depth is not None and compact_depth > max_depth:
                        raise ValueError("compact explicit YAML nesting too deep")
                    lines.append((indent, key + ":"))
                    indent, text = payload_indent, payload
                    continue
                text = key + ": " + payload
                explicit_key = True
            break
        try:
            pair = mapping_pair(text, check_implicit_length=not explicit_key)
        except ValueError as error:
            raise _FileYamlSyntaxError(str(error)) from None
        standalone = pair is None and text != "-" and not text.startswith("- ")
        if text.startswith("- "):
            rest = text[1:].lstrip(" ")
        elif pair is not None:
            rest = pair[1]
        else:
            rest = text if standalone else ""
        parent_indent = indent
        if standalone and lines:
            previous_indent, previous_text = lines[-1]
            previous_pair = mapping_pair(previous_text)
            if previous_text == "-" or (previous_pair is not None and not previous_pair[1]):
                parent_indent = previous_indent
        closes = closes_single_quote if rest.startswith("'") else closes_double_quote
        if rest.startswith(('"', "'")) and not closes(rest, 1):
            fragments = [text]
            while True:
                if line_number >= len(physical):
                    raise _FileYamlSyntaxError("unterminated YAML string")
                continuation = physical[line_number]
                line_number += 1
                if continuation.strip(" ") and len(continuation) - len(continuation.lstrip(" ")) <= parent_indent:
                    raise _FileYamlSyntaxError("invalid quoted continuation indentation")
                fragments.append(continuation)
                if closes(continuation):
                    break
            text = "\n".join(fragments)
            if standalone and mapping_pair(text) is not None:
                raise _FileYamlSyntaxError("multiline implicit keys are forbidden")
        lines.append((indent, text.rstrip(" ")))
    if not lines:
        _file_missing_value("")
    root_indent = lines[0][0]
    position = 0

    def value(rest, indent, depth, path="", allow_indentless=False):
        nonlocal position
        if rest:
            return _file_scalar(rest, path)
        if position >= len(lines):
            _file_missing_value(path)
        next_indent, next_text = lines[position]
        indentless = allow_indentless and next_indent == indent and (next_text == "-" or next_text.startswith("- "))
        if next_indent <= indent and not indentless:
            if next_text != "-" and not next_text.startswith("- ") and mapping_pair(next_text) is None:
                raise _FileYamlSyntaxError("value is outside its parent indentation")
            _file_missing_value(path)
        if next_text != "-" and not next_text.startswith("- ") and mapping_pair(next_text) is None:
            position += 1
            return _file_scalar(next_text, path)
        return (yield block(next_indent, depth + 1, path=path, stop_on_mapping=indentless))

    def block(indent, depth, path="", stop_on_mapping=False):
        nonlocal position
        if max_depth is not None and depth > max_depth:
            raise ValueError("YAML nesting too deep")
        sequence = lines[position][1] == "-" or lines[position][1].startswith("- ")
        result = [] if sequence else {}
        while position < len(lines) and lines[position][0] == indent:
            text = lines[position][1]
            if sequence and stop_on_mapping and text != "-" and not text.startswith("- "):
                break
            position += 1
            if sequence:
                if text != "-" and not text.startswith("- "):
                    raise _FileYamlSyntaxError("mixed block sequence and mapping")
                result.append((yield value(text[1:].lstrip(" ") if text != "-" else "", indent, depth,
                                           path=child(path, len(result)))))
            else:
                pair = mapping_pair(text)
                if pair is None:
                    if result or any(mapping_pair(row) is not None for _, row in lines[position:]):
                        raise _FileYamlSyntaxError("unexpected scalar in a mapping")
                    raise ValueError("expected a mapping pair")
                key, rest = pair
                try:
                    key = key_value(key, allow_merge_keys=allow_merge_keys)
                except ValueError as error:
                    error._yaml_profile_path = path
                    raise
                if key in result:
                    raise ValueError("duplicate key after NFC normalization")
                result[key] = (yield value(rest, indent, depth, path=child(path, key), allow_indentless=True))
        return result

    if len(lines) == 1 and re.fullmatch(r"\{ *\}", lines[0][1]):
        return {}
    pending, sent = [block(root_indent, 0)], None
    while pending:
        try:
            nested = pending[-1].send(sent)
        except StopIteration as completed:
            pending.pop()
            sent = completed.value
        else:
            pending.append(nested)
            sent = None
    result = sent
    if position != len(lines) or type(result) is not dict:
        raise _FileYamlSyntaxError("invalid record indentation or root")
    return result


def _file_path(path):
    if type(path) is not str:
        error = TypeError("report path must be text")
        error.code = "ERR_INVALID_ARG_TYPE"
        raise error
    if "\0" in path:
        error = TypeError("report path contains NUL")
        error.code = "ERR_INVALID_ARG_VALUE"
        raise error
    return path


def _file_os_error(error):
    if isinstance(error, OSError):
        if not hasattr(error, "code"):
            error.code = errno.errorcode.get(error.errno)
        if not hasattr(error, "path"):
            error.path = error.filename
    return error


def _file_profile_diagnostic(text):
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
            spelling = text_line[2:].lstrip()
            if spelling.startswith(("[", "{", "|", ">")):
                profile(parent)
            else:
                try:
                    key = key_value(spelling, allow_merge_keys=True)
                except ValueError:
                    profile(parent)
                else:
                    following = next((row for row in lines[line_number + 1:] if row.strip()), None)
                    omitted = following is None or (
                        len(following) - len(following.lstrip(" ")) <= indent and
                        not following.lstrip(" ").startswith(":") and
                        mapping_pair(following.lstrip(" ")) is not None)
                    if omitted:
                        profile(parent if key == "<<" else child(parent, key))
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

def _file_sorted_extensions(value, path):
    pending = [("value", value, path)]
    while pending:
        operation, current, location = pending.pop()
        if operation == "mapping":
            iterator, previous = current
            try:
                key, entry = next(iterator)
            except StopIteration:
                continue
            if previous is not None and previous >= key:
                raise ValidationError("PACKAGE_AUTHORING_ORDER_INVALID", child(location, key))
            pending.append(("mapping", (iterator, key), location))
            pending.append(("value", entry, child(location, key)))
        elif type(current) is dict:
            pending.append(("mapping", (iter(current.items()), None), location))
        elif type(current) is list:
            pending.extend(("value", current[index], child(location, index)) for index in range(len(current) - 1, -1, -1))


def _file_check_profile(record):
    format_id = record.get("format")
    if type(format_id) is not str or format_id not in ROOT_ORDERS:
        return record
    order_view = record
    if format_id == "morivyx.git-graph/0.1" and "extensions" in record:
        order_view = dict(record)
        order_view["extensions"] = None
    authoring_order(order_view, format_id)
    if format_id == "morivyx.git-graph/0.1":
        _file_sorted_extensions(record.get("extensions"), "/extensions")
    pending, status = [(record, "")], record.get("status")
    while pending:
        value, path = pending.pop()
        if value is None and not null_allowed(format_id, path, status):
            raise ValidationError("PACKAGE_NULL_INVALID", path)
        if type(value) is dict:
            pending.extend((entry, child(path, key)) for key, entry in reversed(list(value.items())))
        elif type(value) is list:
            pending.extend((value[index], child(path, index)) for index in range(len(value) - 1, -1, -1))
    if format_id == "morivyx.trace-report/0.1":
        string_set(record.get("missing"), "/missing")
    elif format_id == "morivyx.schema/0.1":
        string_set(record.get("reviewStates"), "/reviewStates")
        map_set(record.get("entityTypes"), "typeId", ("requiredAttributes", "optionalAttributes", "lifecycle"), "/entityTypes")
        map_set(record.get("relationTypes"), "predicate", ("sourceTypes", "targetTypes"), "/relationTypes")
    return record

def _file_failure(code, path):
    raise ValidationError(code, path)


def _read_record_file(path, required=True):
    _file_path(path)
    try:
        try:
            with open(path, "rb") as stream:
                source = stream.read()
        except FileNotFoundError:
            if not required:
                return None
            _file_failure("PACKAGE_FILE_MISSING", path)
        try:
            text = source.decode("utf-8", errors="strict")
        except UnicodeError:
            _file_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path)
        if (text.startswith("\ufeff") or "\r" in text or "\t" in text or
                re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text) or not text.endswith("\n") or
                re.search(r"\n *\n$", text) or re.search(r"^(?:%.*|---(?:[ \t]|$)|\.\.\.(?:[ \t]|$))", text, re.M)):
            _file_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path)
        try:
            return _file_check_profile(_file_parse_yaml(text))
        except ValidationError as error:
            _file_failure(error.code, path + ("#" + error.path if error.path else ""))
        except (ValueError, TypeError) as error:
            # These fixed messages come from the shared lexical helper, whose
            # Unicode errors are authoring restrictions rather than YAML syntax.
            if isinstance(error, _FileYamlSyntaxError) or str(error) in (
                    "unsupported YAML escape", "unfinished YAML escape", "invalid YAML Unicode escape"):
                _file_failure("PACKAGE_YAML_INVALID", path)
            location, syntax = _file_profile_diagnostic(text)
            location = getattr(error, "_yaml_profile_path", location)
            if not syntax and location is not None:
                _file_failure("PACKAGE_AUTHORING_PROFILE_INVALID", path + ("#" + location if location else ""))
            _file_failure("PACKAGE_YAML_INVALID", path)
    except OSError as error:
        raise _file_os_error(error)


async def read_yaml_record(path, required=True):
    """Read one selected logical mapping; optional absence returns None.

    This file API preserves strings after NFC normalization, without applying
    canonical timestamp semantics or the legacy source API's resource limits.
    It does not validate a report schema, a Graph or adoption authority.
    """
    return await asyncio.to_thread(_read_record_file, path, required)
