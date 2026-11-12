"""Bounded YAML block-record reader and deterministic writer, without dependencies.

This is a syntax reader, not a complete YAML processor or Graph/schema validator.
Supported records and limits are documented in README.md.
"""

import re

from canonical import canonical_json, quote, timestamp_text, unicode_text


MAX_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 128
INTEGER = re.compile(r"(?:0|[1-9][0-9]*|-[1-9][0-9]*)")
ORDERS = {
    "morivyx.git-graph/0.1": "format kind id type typeVersion revision lifecycle reviewState attributes provenance extensions",
    "morivyx.schema-lock/0.1": "format stableIdScheme digestAlgorithm schemas",
    "morivyx.graph-revision/0.1": "format id parentRevision rootDigest schemaLockDigest",
    "morivyx.approval/0.1": "format id actor targetId targetRevision operation scope approvedAt recordedAt expiresAt revokes",
    "morivyx.changeset/0.1": "format id baseRevision resultingRevision resultingRootDigest schemaLockDigest operations provenance recordedAt",
    "morivyx.migration/0.1": "format id baseRevision sourceSchemaLockDigest targetSchemaLockDigest rulesDigest mappingDigest plannedSemanticDiffDigest changeSetId resultingRevision resultingRootDigest provenance recordedAt",
    "morivyx.trace-report/0.1": "format id queryId graphRevision schemaLockDigest focusId evaluatedAt status paths missing waiverDecisionId",
    "morivyx.semantic-diff/0.1": "format id baseRevision targetRevision schemaLockDigest evaluatedAt entries",
    "morivyx.migration-semantic-diff/0.1": "format id baseRevision targetRevision sourceSchemaLockDigest targetSchemaLockDigest evaluatedAt entries",
    "morivyx.external-artifact-report/0.1": "format id graphRevision artifact externalSource relation retrieval comparedAt status issues",
}
ESCAPES = {
    "0": "\0", "a": "\a", "b": "\b", "t": "\t", "n": "\n", "v": "\v",
    "f": "\f", "r": "\r", "e": "\x1b", " ": " ", '"': '"', "/": "/",
    "\\": "\\", "N": "\x85", "_": "\xa0", "L": "\u2028", "P": "\u2029",
}


def double_string(token):
    if not token.startswith('"'):
        raise ValueError("expected a double-quoted string")
    result, i = [], 1
    while i < len(token):
        c = token[i]
        i += 1
        if c == '"':
            if token[i:].strip(" "):
                raise ValueError("trailing YAML content")
            # YAML escapes may spell a UTF-16 pair just as the product's
            # JavaScript strings do. Strict decoding still rejects lone units.
            decoded = "".join(result).encode("utf-16-le", errors="surrogatepass").decode("utf-16-le")
            return unicode_text(decoded)
        if c == "\\":
            if i >= len(token):
                raise ValueError("unfinished YAML escape")
            escape = token[i]
            i += 1
            if escape == "\n":
                while i < len(token) and token[i] == " ":
                    i += 1
            elif escape in ESCAPES:
                result.append(ESCAPES[escape])
            elif escape in ("x", "u", "U"):
                size = {"x": 2, "u": 4, "U": 8}[escape]
                digits = token[i:i + size]
                if len(digits) != size or not re.fullmatch(r"[0-9a-fA-F]+", digits):
                    raise ValueError("invalid YAML Unicode escape")
                result.append(chr(int(digits, 16)))
                i += size
            else:
                raise ValueError("unsupported YAML escape")
        elif c == "\n":
            breaks = 1
            while i < len(token):
                if token[i] == " ":
                    i += 1
                elif token[i] == "\n":
                    breaks += 1
                    i += 1
                else:
                    break
            result.append(" " if breaks == 1 else "\n" * (breaks - 1))
        elif c == " ":
            start = i - 1
            while i < len(token) and token[i] == " ":
                i += 1
            if i == len(token) or token[i] != "\n":
                result.append(token[start:i])
        elif ord(c) < 0x20:
            raise ValueError("raw non-printable character")
        else:
            result.append(c)
    raise ValueError("unterminated YAML string")


def mapping_pair(text, check_implicit_length=False):
    quoted, i = None, 0
    while i < len(text):
        c = text[i]
        if quoted == '"' and c == "\\":
            i += 2
            continue
        if quoted == "'" and text[i:i + 2] == "''":
            i += 2
            continue
        if c == quoted:
            quoted = None
        elif quoted is None:
            if i == 0 and c in "\"'":
                quoted = c
            elif c == ":" and (i + 1 == len(text) or text[i + 1] == " "):
                if check_implicit_length and len(text[:i]) > 1024:
                    raise ValueError("implicit YAML key spelling exceeds 1024 Unicode characters")
                return text[:i].rstrip(" "), text[i + 1:].lstrip(" ")
        i += 1
    return None


def single_string(token):
    """Read a quoted key, including YAML folding and doubled apostrophes."""
    result, i = [], 1
    while i < len(token):
        c = token[i]
        i += 1
        if c == "'":
            if i < len(token) and token[i] == "'":
                result.append("'")
                i += 1
            else:
                if token[i:].strip(" "):
                    raise ValueError("trailing YAML key content")
                return unicode_text("".join(result))
        elif c == "\n":
            breaks = 1
            while i < len(token) and token[i] in " \n":
                if token[i] == "\n":
                    breaks += 1
                i += 1
            result.append(" " if breaks == 1 else "\n" * (breaks - 1))
        elif c == " ":
            start = i - 1
            while i < len(token) and token[i] == " ":
                i += 1
            if i == len(token) or token[i] != "\n":
                result.append(token[start:i])
        elif ord(c) < 0x20:
            raise ValueError("raw non-printable key character")
        else:
            result.append(c)
    raise ValueError("unterminated quoted key")


def plain_key(token):
    if not token or token != token.strip(" ") or token[0] in ",[]{}#&*!|>'\"%@`":
        return False
    if token in ("-", "?", ":", "~") or re.search(r": |(?:^| )#", token):
        return False
    if token.startswith(("- ", "? ", ": ")):
        return False
    if token in ("true", "True", "TRUE", "false", "False", "FALSE", "null", "Null", "NULL"):
        return False
    # YAML 1.2 Core scalar resolution: a key spelling must remain a string.
    if re.fullmatch(r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?", token):
        return False
    if re.fullmatch(r"(?:0o[0-7]+|0x[0-9a-fA-F]+)", token) or token in (
        ".nan", ".NaN", ".NAN"
    ) or re.fullmatch(r"[-+]?\.(?:inf|Inf|INF)", token):
        return False
    return not any(ord(c) < 0x20 for c in token) and not re.search(r"[\x7f-\x84\x86-\x9f\ufffe\uffff]", token)


def key_value(token, *, allow_merge_keys=False):
    if token.startswith('"'):
        value = double_string(token)
    elif token.startswith("'"):
        value = single_string(token)
    elif plain_key(token):
        value = unicode_text(token)
    else:
        raise ValueError("unsupported mapping key spelling")
    if value == "<<" and not allow_merge_keys:
        raise ValueError("YAML merge key is forbidden")
    return value


def scalar(token):
    if token.startswith('"'):
        return double_string(token)
    if re.fullmatch(r"\[ *\]", token):
        return []
    if re.fullmatch(r"\{ *\}", token):
        return {}
    if token in ("true", "false", "null"):
        return {"true": True, "false": False, "null": None}[token]
    if INTEGER.fullmatch(token):
        number = int(token)
        if abs(number) <= 9007199254740991:
            return number
    raise ValueError("unsupported or forbidden YAML scalar")


def closes_double_quote(text, start=0):
    """Scan one physical fragment; a final backslash escapes its newline."""
    i = start
    while i < len(text):
        if text[i] == "\\":
            i += 2
        elif text[i] == '"':
            return True
        else:
            i += 1
    return False


def closes_single_quote(text, start=0):
    i = start
    while i < len(text):
        if text[i:i + 2] == "''":
            i += 2
        elif text[i] == "'":
            return True
        else:
            i += 1
    return False


def read_yaml(source, *, max_bytes=MAX_BYTES, max_depth=MAX_DEPTH, allow_merge_keys=False):
    """Read the supported bounded block syntax; normalize Unicode, not dates."""
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
                    raise ValueError("unterminated explicit key")
                raw = physical[line_number]
                line_number += 1
                if raw.strip(" ") and len(raw) - len(raw.lstrip(" ")) <= indent:
                    raise ValueError("invalid explicit key continuation")
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
        pair = mapping_pair(text, check_implicit_length=not explicit_key)
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
        if rest.startswith('"') and not closes_double_quote(rest, 1):
            fragments = [text]
            while True:
                if line_number >= len(physical):
                    raise ValueError("unterminated YAML string")
                continuation = physical[line_number]
                line_number += 1
                if continuation.strip(" ") and len(continuation) - len(continuation.lstrip(" ")) <= parent_indent:
                    raise ValueError("invalid quoted continuation indentation")
                fragments.append(continuation)
                if closes_double_quote(continuation):
                    break
            text = "\n".join(fragments)
            if standalone and mapping_pair(text) is not None:
                raise ValueError("multiline implicit keys are forbidden")
        lines.append((indent, text.rstrip(" ")))
    if not lines:
        raise ValueError("record must contain a mapping")
    root_indent = lines[0][0]
    position = 0

    def value(rest, indent, depth, allow_indentless=False):
        nonlocal position
        if rest:
            return scalar(rest)
        if position >= len(lines):
            raise ValueError("missing block value")
        next_indent, next_text = lines[position]
        indentless = allow_indentless and next_indent == indent and (next_text == "-" or next_text.startswith("- "))
        if next_indent <= indent and not indentless:
            raise ValueError("missing block value")
        if next_text != "-" and not next_text.startswith("- ") and mapping_pair(next_text) is None:
            position += 1
            return scalar(next_text)
        return block(next_indent, depth + 1, stop_on_mapping=indentless)

    def block(indent, depth, stop_on_mapping=False):
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
                    raise ValueError("mixed block sequence and mapping")
                result.append(value(text[1:].lstrip(" ") if text != "-" else "", indent, depth))
            else:
                pair = mapping_pair(text)
                if pair is None:
                    raise ValueError("expected a mapping pair")
                key, rest = pair
                key = key_value(key, allow_merge_keys=allow_merge_keys)
                if key in result:
                    raise ValueError("duplicate key after NFC normalization")
                result[key] = value(rest, indent, depth, allow_indentless=True)
        return result

    if len(lines) == 1 and re.fullmatch(r"\{ *\}", lines[0][1]):
        return {}
    result = block(root_indent, 0)
    if position != len(lines) or type(result) is not dict:
        raise ValueError("invalid record indentation or root")
    canonical_json(result)
    return result


def serialize_yaml_record(record):
    """Return the thirteen-format logical writer result without file access.

    This API is separate from the bounded legacy write_yaml reader/writer.
    It checks representability and layout, not domain schema validity.
    """
    from schema_validation import ValidationError

    def fail(path, code="YAML_SERIALIZATION_INVALID"):
        raise ValidationError(code, path)

    def child(path, key):
        return path + "/" + str(key).replace("~", "~0").replace("/", "~1")

    def entries(value):
        # JavaScript logical objects enumerate array-index keys first. The
        # contract's subsequent Unicode sort does not override that storage rule.
        keys = list(value)
        indexed = sorted(k for k in keys if type(k) is str and re.fullmatch(r"0|[1-9][0-9]*", k)
                         and int(k) < 4294967295)
        indexed.sort(key=int)
        selected = set(indexed)
        return [(k, value[k]) for k in indexed + [k for k in keys if k not in selected]]

    def string(value, path):
        try:
            return unicode_text(value)
        except ValueError:
            fail(path)

    orders = dict(ORDERS)
    request = "format decisionId attributes changeSetId resultingRevision actor recordedAt"
    for name in ("decision-creation-request", "decision-revision-request"):
        orders["morivyx." + name + "/0.1"] = request
    orders["morivyx.schema/0.1"] = "format schemaId version stableIdScheme digestAlgorithm reviewStates entityTypes relationTypes authoringOrders"

    try:
        # Structural errors precede unsupported formats and null-policy errors.
        active, pending = set(), [(record, "", False)]
        while pending:
            value, path, leaving = pending.pop()
            if leaving == "key":
                string(value, path)
                continue
            if leaving:
                active.remove(id(value))
                continue
            if type(value) is str:
                string(value, path)
            elif type(value) in (dict, list):
                if id(value) in active:
                    fail(path)
                active.add(id(value))
                pending.append((value, path, True))
                pairs = entries(value) if type(value) is dict else list(enumerate(value))
                for key, item in reversed(pairs):
                    if type(value) is dict and type(key) is not str:
                        fail(path)
                    pending.append((item, child(path, key), False))
                    if type(value) is dict:
                        # Validate each key immediately before its child rather
                        # than inspecting later keys before an earlier failure.
                        pending.append((key, path, "key"))
            elif value is not None and type(value) not in (bool, int, float):
                fail(path)

        raw_format = record.get("format") if type(record) is dict else None
        format_id = string(raw_format, "/format") if type(raw_format) is str else None
        if format_id not in orders:
            # Ordinary JSON objects may shadow String's toString operation.
            def cannot_stringify(value):
                return (type(value) is dict and "toString" in value) or (
                    type(value) is list and any(cannot_stringify(v) for v in value))
            if cannot_stringify(raw_format):
                fail("")
            fail("/format", "PACKAGE_FORMAT_UNSUPPORTED")

        status = record.get("status")
        pending = [(record, "")]
        while pending:
            value, path = pending.pop()
            if value is None:
                allowed = (format_id == "morivyx.graph-revision/0.1" and path == "/parentRevision") or (
                    format_id == "morivyx.schema/0.1" and re.fullmatch(r"/relationTypes/[0-9]+/maxCount", path)) or (
                    format_id == "morivyx.git-graph/0.1" and path.startswith("/extensions/"))
                if format_id == "morivyx.external-artifact-report/0.1" and status == "invalid":
                    allowed = path in ("/graphRevision", "/retrieval", "/comparedAt", "/artifact/lifecycle") or re.fullmatch(
                        r"/(artifact|externalSource|relation)/(id|revision)|/retrieval/(status|comparedAt|digest|digestRule|externalVersion|method|reason)", path)
                if not allowed:
                    fail(path)
            elif type(value) in (dict, list):
                pairs = entries(value) if type(value) is dict else list(enumerate(value))
                pending.extend((item, child(path, string(key, path) if type(key) is str else key))
                               for key, item in reversed(pairs))

        schema = "morivyx.schema/0.1"
        contexts = {(): ("record", orders[format_id])}
        if format_id in ("morivyx.git-graph/0.1", "morivyx.changeset/0.1", "morivyx.migration/0.1"):
            contexts[("provenance",)] = ("record", "method actor recordedAt")
        if format_id == schema:
            contexts.update({("entityTypes",): ("sequence", "typeId requiredAttributes optionalAttributes lifecycle"),
                             ("relationTypes",): ("sequence", "predicate sourceTypes targetTypes minCount maxCount cycle"),
                             ("authoringOrders",): ("record", "root attributes provenance")})
        for suffix, name, order in (
            ("schema-lock", "schemas", "schemaId version digest"),
            ("changeset", "operations", "op targetId beforeRevision afterRevision replacementId"),
            ("trace-report", "paths", "hops"),
            ("semantic-diff", "entries", "kind targetId beforeRevision afterRevision replacementId aspect queryId beforeStatus afterStatus"),
            ("migration-semantic-diff", "entries", "kind targetId beforeRevision afterRevision replacementId aspect queryId beforeStatus afterStatus"),
        ):
            if format_id == "morivyx." + suffix + "/0.1":
                contexts[(name,)] = ("sequence", order)
        if format_id == "morivyx.trace-report/0.1":
            contexts[("paths", "*", "hops")] = ("sequence", "fromId predicate toId fromRevision toRevision")
        if format_id == "morivyx.external-artifact-report/0.1":
            for key in ("artifact", "externalSource", "relation"):
                contexts[(key,)] = ("record", "id revision lifecycle")
            contexts[("retrieval",)] = ("nullable-record", "status comparedAt digest digestRule externalVersion method reason")
            contexts[("issues",)] = ("sequence", "code")

        def normalize(value, location=(), path="", forced_order=None):
            mode, order = contexts.get(location, (None, "")) if forced_order is None else ("record", forced_order)
            if mode == "nullable-record" and value is None:
                return None
            if mode == "sequence":
                if type(value) is not list:
                    fail(path)
                return [normalize(v, location + ("*",), child(path, i), order) for i, v in enumerate(value)]
            if mode in ("record", "nullable-record") and type(value) is not dict:
                fail(path)
            if type(value) is dict:
                normalized = {}
                for key, item in entries(value):
                    key = string(key, path)
                    if key in normalized:
                        fail(child(path, key))
                    normalized[key] = item
                positions = order.split()
                keys = sorted(normalized, key=lambda k: (positions.index(k), "") if k in positions else (len(positions), k))
                return {key: normalize(normalized[key], location + (key,), child(path, key)) for key in keys}
            if type(value) is list:
                return [normalize(v, location + ("*",), child(path, i)) for i, v in enumerate(value)]
            try:
                # The existing independent scalar contract includes Unicode 16,
                # timestamps, safe integers, and negative-zero rejection.
                import json
                return json.loads(canonical_json(value))
            except ValueError:
                fail(path)

        def quoted(text):
            escapes = {0: "0", 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 27: "e"}
            output = ['"']
            for character in text:
                code = ord(character)
                if code in escapes:
                    output.append("\\" + escapes[code])
                elif character in ('"', "\\"):
                    output.append("\\" + character)
                elif code < 32:
                    output.append(f"\\x{code:02x}")
                elif 127 <= code <= 159 or code in (65534, 65535):
                    output.append(f"\\u{code:04x}")
                else:
                    output.append(character)
            return "".join(output) + '"'

        def inline(value):
            return quoted(value) if type(value) is str else canonical_json(value)

        def render(value, indent):
            prefix = " " * indent
            if type(value) is dict and value:
                lines = []
                for key, item in entries(value):
                    spelling = key if plain_key(key) and not re.search(r"[\x7f-\x9f]", key) else quoted(key)
                    if len(spelling.encode("utf-16-le")) // 2 > 1024:
                        lines.append(prefix + "? " + spelling)
                        label = prefix + ":"
                    else:
                        label = prefix + spelling + ":"
                    if type(item) in (dict, list) and item:
                        lines.append(label)
                        lines.extend(render(item, indent + 2))
                    else:
                        lines.append(label + " " + inline(item))
                return lines
            if type(value) is list and value:
                lines = []
                for item in value:
                    nested = render(item, indent + 2)
                    lines.append(prefix + "- " + nested[0][indent + 2:])
                    lines.extend(nested[1:])
                return lines
            return [prefix + inline(value)]

        return "\n".join(render(normalize(record), 0)) + "\n"
    except ValidationError:
        raise
    except (ValueError, TypeError, RecursionError, OverflowError):
        fail("")


def field_order(format_id, path):
    if not path:
        return ORDERS[format_id].split()
    if path == ("provenance",):
        return "method actor recordedAt".split()
    if format_id == "morivyx.schema-lock/0.1" and path == ("schemas", "*"):
        return "schemaId version digest".split()
    if format_id == "morivyx.changeset/0.1" and path == ("operations", "*"):
        return "op targetId beforeRevision afterRevision replacementId".split()
    if format_id == "morivyx.trace-report/0.1":
        if path == ("paths", "*"):
            return ["hops"]
        if path == ("paths", "*", "hops", "*"):
            return "fromId predicate toId fromRevision toRevision".split()
    if format_id in ("morivyx.semantic-diff/0.1", "morivyx.migration-semantic-diff/0.1") and path == ("entries", "*"):
        return "kind targetId beforeRevision afterRevision replacementId aspect queryId beforeStatus afterStatus".split()
    if format_id == "morivyx.external-artifact-report/0.1":
        if path in (("artifact",), ("externalSource",), ("relation",)):
            return "id revision lifecycle".split()
        if path == ("retrieval",):
            return "status comparedAt digest digestRule externalVersion method reason".split()
        if path == ("issues", "*"):
            return ["code"]
    return []


def yaml_quote(text):
    # JSON escapes are YAML double-quoted escapes. Escape additional YAML line
    # and control characters so physical line folding cannot change the value.
    return re.sub(r"[\x7f-\x9f\u2028\u2029\ufffe\uffff]", lambda m: f"\\u{ord(m[0]):04x}", quote(text))


def write_yaml(record, *, max_bytes=MAX_BYTES, max_depth=MAX_DEPTH, allow_merge_keys=False):
    """Normalize and write one of ten existing record layouts; do not persist."""
    canonical_json(record)
    if type(record) is not dict or record.get("format") not in ORDERS:
        raise ValueError("unsupported record format")
    format_id = record["format"]

    def normalize(value, path, depth):
        if max_depth is not None and depth > max_depth:
            raise ValueError("YAML nesting too deep")
        if type(value) is dict:
            entries = {unicode_text(k): v for k, v in value.items()}
            if "<<" in entries and not allow_merge_keys:
                raise ValueError("YAML merge key is forbidden")
            order = field_order(format_id, path)
            keys = sorted(entries, key=lambda k: (order.index(k), "") if k in order else (len(order), k))
            return {k: normalize(entries[k], path + (k,), depth + 1) for k in keys}
        if type(value) is list:
            return [normalize(v, path + ("*",), depth + 1) for v in value]
        if type(value) is str:
            return timestamp_text(unicode_text(value))
        if value is None:
            allowed = (format_id == "morivyx.graph-revision/0.1" and path == ("parentRevision",)) or (
                format_id == "morivyx.git-graph/0.1" and len(path) >= 2 and path[0] == "extensions")
            if format_id == "morivyx.external-artifact-report/0.1" and record.get("status") == "invalid":
                allowed = path in (("graphRevision",), ("retrieval",), ("comparedAt",), ("artifact", "lifecycle")) or (
                    len(path) == 2 and path[0] in ("artifact", "externalSource", "relation") and path[1] in ("id", "revision")
                ) or (len(path) == 2 and path[0] == "retrieval" and path[1] in (
                    "status", "comparedAt", "digest", "digestRule", "externalVersion", "method", "reason"))
            if not allowed:
                raise ValueError("null is forbidden at this record location")
        return value

    def inline(value):
        if type(value) is str:
            return yaml_quote(value)
        return canonical_json(value)

    def render(value, indent):
        prefix = " " * indent
        if type(value) is dict and value:
            lines = []
            for key, child in value.items():
                key = key if plain_key(key) and not re.search(r"[\x7f-\x9f]", key) else yaml_quote(key)
                if len(key.encode("utf-16-le")) // 2 > 1024:
                    # Explicit keys avoid the implicit-key limit, including
                    # readers that count UTF-16 units instead of code points.
                    lines.append(prefix + "? " + key)
                    entry = prefix + ":"
                else:
                    entry = prefix + key + ":"
                if type(child) in (dict, list) and child:
                    lines.append(entry)
                    lines.extend(render(child, indent + 2))
                else:
                    lines.append(entry + " " + inline(child))
            return lines
        if type(value) is list and value:
            lines = []
            for child in value:
                nested = render(child, indent + 2)
                lines.append(prefix + "- " + nested[0][indent + 2:])
                lines.extend(nested[1:])
            return lines
        return [prefix + inline(value)]

    result = "\n".join(render(normalize(record, (), 0), 0)) + "\n"
    if max_bytes is not None and len(result.encode("utf-8")) > max_bytes:
        raise ValueError("YAML output too large")
    return result
