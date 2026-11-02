"""Bind explicitly supplied Schema sources to a lock; never use a fallback."""

from canonical import digest
from schema_validation import SCHEMA_ID, VERSION, validate_schema_definition
from yaml_authoring import read_authoring_yaml


def registry_issue(code, path):
    return {"code": code, "phase": 2, "elementId": "", "path": path, "relatedId": ""}


def resolve_schema_registry(schema_lock, sources):
    """Return bound definitions and phase-two diagnostics, without filesystem I/O.

    Sources are keyed by basename, including '.yaml'. Signature verification,
    publisher identity and approval authority are outside this function.
    """
    if type(schema_lock) is not dict or type(schema_lock.get("schemas")) is not list or type(sources) is not dict:
        raise ValueError("schema lock and explicit source mapping required")
    for name, source in sources.items():
        if type(name) is not str or not name.endswith(".yaml") or any(c in name for c in "/\\\x00\r\n"):
            raise ValueError("schema source name must be a YAML basename")
        if type(source) not in (str, bytes):
            raise ValueError("schema source must be text or bytes")
    locked = schema_lock["schemas"]
    for entry in locked:
        if type(entry) is not dict or any(type(entry.get(k)) is not str for k in ("schemaId", "version", "digest")):
            raise ValueError("invalid schema reference")
    filenames = {e["schemaId"] + "@" + e["version"] + ".yaml" for e in locked}
    issues = [registry_issue("SCHEMA_LOCK_CONFLICT", "/schemas/" + name.replace("~", "~0"))
              for name in sorted(sources) if name not in filenames]
    schemas = {}
    for entry in locked:
        key = entry["schemaId"] + "@" + entry["version"]
        path = "/schemas/" + key
        if not SCHEMA_ID.fullmatch(entry["schemaId"]) or not VERSION.fullmatch(entry["version"]):
            issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", path))
            continue
        filename = key + ".yaml"
        if filename not in sources:
            issues.append(registry_issue("SCHEMA_LOCK_MISSING", path))
            continue
        try:
            definition = read_authoring_yaml(sources[filename])
            validate_schema_definition(definition)
            matches = definition["schemaId"] == entry["schemaId"] and definition["version"] == entry["version"] and (
                digest("schema", definition)["digest"] == entry["digest"])
        except (ValueError, TypeError, UnicodeError, RecursionError):
            matches = False
        if not matches:
            issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", path))
            continue
        schemas[key] = definition
    return {"schemas": schemas, "issues": issues}
