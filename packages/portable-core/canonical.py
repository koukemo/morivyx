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
import unicodedata


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
    return unicodedata.normalize("NFC", value)


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
