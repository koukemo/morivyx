"""Independent, standard-library implementation of the frozen Core digest contracts.

This module handles logical JSON values, not Graph validation or YAML packages.
No JavaScript implementation is loaded or executed by this module or its CLI.
"""

import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from unicode_nfc import normalize_nfc


TIMESTAMP = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(?:\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))"
)
KINDS = (
    "entity_added", "entity_revised", "entity_retired", "entity_replaced",
    "relation_added", "relation_revised", "relation_retired", "decision_changed",
    "goal_changed", "trace_quality_changed", "provenance_changed",
    "external_digest_changed", "schema_changed", "unknown_extension_changed",
)
ENTRY_FIELDS = (
    "targetId", "aspect", "queryId", "beforeRevision", "afterRevision", "replacementId",
)
CONTRACTS = {
    "revision": "revision",
    "schema-lock": None,
    "schema": None,
    "changeset": "id",
    "migration": "id",
    "root": None,
    "semantic-diff": "id",
    "migration-semantic-diff": "id",
    "trace-report": "id",
    "external-artifact-report": "id",
}


def unicode_text(value):
    if type(value) is not str or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("expected a Unicode scalar string")
    return normalize_nfc(value)


def timestamp_text(value):
    match = TIMESTAMP.fullmatch(value)
    if not match:
        return value
    year, month, day, hour, minute, second = map(int, match.groups()[:6])
    fraction, zone, sign, offset_hour, offset_minute = match.groups()[6:]
    oh, om = int(offset_hour or 0), int(offset_minute or 0)
    if om > 59 or oh > 14 or (oh == 14 and om):
        raise ValueError("invalid time zone")
    # Gregorian leap years repeat every 400 years. Translate into datetime's
    # supported range to preserve the contract's year 0000 and boundary checks.
    translated_year = 400 + year % 400
    local = datetime.datetime(translated_year, month, day, hour, minute, second)
    offset = (oh * 60 + om) * (-1 if sign == "-" else 1)
    utc = local - datetime.timedelta(minutes=offset if zone != "Z" else 0)
    utc_year = utc.year + year - translated_year
    if not 0 <= utc_year <= 9999:
        raise ValueError("UTC year is outside the four-digit range")
    base = f"{utc_year:04d}-{utc.month:02d}-{utc.day:02d}T{utc.hour:02d}:{utc.minute:02d}:{utc.second:02d}"
    fraction = (fraction or "").rstrip("0")
    return base + ("." + fraction if fraction else "") + "Z"


def quote(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_json(value):
    """Serialize supported logical values without depending on host map order."""
    output, active = [], set()
    operations = [("value", value)]
    while operations:
        operation, current = operations.pop()
        if operation == "text":
            output.append(current)
            continue
        if operation == "leave":
            active.remove(current)
            continue
        if current is None:
            output.append("null")
        elif type(current) is bool:
            output.append("true" if current else "false")
        elif type(current) is str:
            output.append(quote(timestamp_text(unicode_text(current))))
        elif type(current) in (int, float):
            if (type(current) is float and (
                not math.isfinite(current) or not current.is_integer()
                or (current == 0 and math.copysign(1, current) < 0)
            )) or abs(current) > 9007199254740991:
                raise ValueError("expected a safe integer other than negative zero")
            output.append(str(int(current)))
        elif type(current) in (list, dict):
            identity = id(current)
            if identity in active:
                raise ValueError("cyclic logical value")
            active.add(identity)
            operations.append(("leave", identity))
            if type(current) is list:
                output.append("[")
                operations.append(("text", "]"))
                for index in range(len(current) - 1, -1, -1):
                    operations.append(("value", current[index]))
                    operations.append(("text", "," if index else ""))
            else:
                normalized = {}
                for key, child in current.items():
                    key = unicode_text(key)
                    if key in normalized:
                        raise ValueError("duplicate key after NFC normalization")
                    normalized[key] = child
                output.append("{")
                operations.append(("text", "}"))
                for index, key in reversed(list(enumerate(sorted(normalized)))):
                    operations.append(("value", normalized[key]))
                    operations.append(("text", ("," if index else "") + quote(key) + ":"))
        else:
            raise ValueError("unsupported logical value")
    return "".join(output)


def record(value):
    if type(value) is not dict:
        raise ValueError("expected a logical mapping")
    return value


def array(value):
    if type(value) is not list:
        raise ValueError("expected a logical array")
    return value


def entry_key(entry):
    record(entry)
    if entry.get("kind") not in KINDS:
        raise ValueError("unknown semantic diff kind")
    return (KINDS.index(entry["kind"]), *(unicode_text(entry[field])
            if type(entry.get(field)) is str else "" for field in ENTRY_FIELDS))


def digest(kind, value):
    """Return canonical bytes and a domain-separated digest, without mutation.

    Digest calculation is not validation of a whole Graph, report, or signature.
    """
    if kind not in CONTRACTS:
        raise ValueError("unknown digest contract")
    if kind == "root":
        pairs = [[unicode_text(record(e)["id"]), unicode_text(e["revision"])]
                 for e in array(value)]
        content = sorted(pairs, key=lambda pair: pair[0])
    elif kind in ("schema", "schema-lock"):
        content = value
    else:
        record(value)
        if kind in ("semantic-diff", "migration-semantic-diff", "trace-report", "external-artifact-report"):
            canonical_json(value)
        content = {k: v for k, v in value.items() if k != CONTRACTS[kind]}
        if kind in ("semantic-diff", "migration-semantic-diff"):
            entries = sorted(array(content["entries"]), key=entry_key)
            keys = [entry_key(e) for e in entries]
            if len(set(keys)) != len(keys):
                raise ValueError("duplicate semantic diff entry")
            content["entries"] = entries
        elif kind == "trace-report":
            paths = [{"hops": [dict(record(h)) for h in array(record(p)["hops"])]}
                     for p in array(content["paths"])]
            content["paths"] = sorted(paths, key=canonical_json)
            content["missing"] = sorted({unicode_text(v) for v in array(content["missing"])})
    canonical = canonical_json(content)
    encoded = canonical.encode("utf-8")
    hashed = hashlib.sha256(f"morivyx:{kind}:v1".encode("ascii") + b"\0" + encoded)
    return {"canonicalByteLength": len(encoded), "canonicalJson": canonical,
            "digest": "sha256:" + hashed.hexdigest()}


def load_json(source):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def integer(token):
        return -0.0 if token == "-0" else int(token)

    def constant(_token):
        raise ValueError("non-finite JSON number")

    return json.loads(source, object_pairs_hook=pairs, parse_int=integer, parse_constant=constant)


class _Undefined:
    """An omitted JavaScript logical value, distinct from JSON null."""

    def __repr__(self):
        return "<logical:undefined>"

    def __bool__(self):
        return False


UNDEFINED = _Undefined()


def _helper_scalar_text(value):
    # Python callers can supply either a scalar or explicit UTF-16 surrogate
    # pairs. Combine pairs while retaining lone surrogates, as ECMAScript does.
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def _helper_string(value, active=None):
    """String conversion for the supported logical values, without JSON encoding."""
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if type(value) is str:
        return value
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) in (int, float):
        from record_validation import _revision_number_text
        return _revision_number_text(value)
    if type(value) is list:
        active = set() if active is None else active
        identity = id(value)
        if identity in active:
            return ""
        active.add(identity)
        try:
            return ",".join("" if child is None or child is UNDEFINED else _helper_string(child, active)
                            for child in value)
        finally:
            active.remove(identity)
    if type(value) is dict:
        if "toString" in value:
            raise TypeError("Cannot convert object to primitive value")
        return "[object Object]"
    if type(value) in (bytes, bytearray):
        return bytes(value).decode("utf-8", "replace")
    raise TypeError("unsupported logical value")


def _helper_property(value, key):
    if value is None or value is UNDEFINED:
        source = "null" if value is None else "undefined"
        raise TypeError(f"Cannot read properties of {source} (reading '{key}')")
    if type(value) is dict:
        return value.get(key, UNDEFINED)
    return UNDEFINED


def _helper_strict_equal(left, right):
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if type(left) is str:
        return _helper_scalar_text(left) == _helper_scalar_text(right)
    if left is None or left is UNDEFINED or type(left) is bool:
        return left == right
    return left is right


def _helper_number(value):
    if value is UNDEFINED:
        return math.nan
    if value is None:
        return 0.0
    if type(value) is bool:
        return float(value)
    if type(value) in (int, float):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value > 0 else -math.inf
    source = _helper_string(value)
    # This is the ECMAScript whitespace set, not Python's broader str.strip.
    source = source.strip("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
    if not source:
        return 0.0
    if source in ("Infinity", "+Infinity", "-Infinity"):
        return -math.inf if source[0] == "-" else math.inf
    for pattern, radix in [(r"0[xX][0-9a-fA-F]+", 16), (r"0[oO][0-7]+", 8), (r"0[bB][01]+", 2)]:
        if re.fullmatch(pattern, source):
            try:
                return float(int(source[2:], radix))
            except OverflowError:
                return math.inf
    if re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", source):
        return float(source)
    return math.nan


def _helper_text(value):
    return normalize_nfc(_helper_scalar_text(value)) if type(value) is str else ""


def _helper_points(value):
    if value is None or value is UNDEFINED:
        source = "object null" if value is None else "undefined"
        raise TypeError(f"{source} is not iterable (cannot read property Symbol(Symbol.iterator))")
    if type(value) is str:
        items = _helper_scalar_text(value)
    elif type(value) in (list, bytes, bytearray):
        items = value
    elif type(value) is dict:
        length = _helper_number(value.get("length", UNDEFINED))
        length = 0 if math.isnan(length) or length <= 0 else min(math.floor(length), 9007199254740991)
        if length > 1000000:
            raise ValueError("logical array-like value exceeds supported bound")
        items = [value.get(str(index), UNDEFINED) for index in range(length)]
    elif type(value) in (int, float, bool):
        items = []
    else:
        raise TypeError("unsupported logical iterable")
    result = []
    for item in items:
        if item is None or item is UNDEFINED:
            source = "null" if item is None else "undefined"
            raise TypeError(f"Cannot read properties of {source} (reading 'codePointAt')")
        if type(item) is not str:
            raise TypeError("value.codePointAt is not a function")
        scalar = _helper_scalar_text(item)
        result.append(ord(scalar[0]) if scalar else UNDEFINED)
    return result


def compare_unicode(left=UNDEFINED, right=UNDEFINED, *_ignored):
    """Compare raw Unicode code points; return the exact difference, without NFC.

    The supported logical array-like inputs follow the original comparison's
    eager point extraction. This is not scalar-string or schema validation.
    """
    left_points, right_points = _helper_points(left), _helper_points(right)
    for a, b in zip(left_points, right_points):
        if not _helper_strict_equal(a, b):
            return _helper_number(a) - _helper_number(b)
    return len(left_points) - len(right_points)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", choices=CONTRACTS)
    parser.add_argument("input", type=Path, help="JSON logical value, read only")
    args = parser.parse_args()
    try:
        result = digest(args.contract, load_json(args.input.read_text(encoding="utf-8")))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except (ValueError, TypeError, KeyError, OSError, RecursionError):
        print("invalid logical input; no digest produced", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
