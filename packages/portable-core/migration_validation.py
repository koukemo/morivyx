"""Validate migration records and change-set boundaries, without applying them."""

from record_validation import GRAPH_ID, mapping, text, timestamp, validate_change_set
from schema_validation import DIGEST, STABLE_ID, pointer, require


FIELDS = set("format id baseRevision sourceSchemaLockDigest targetSchemaLockDigest rulesDigest mappingDigest plannedSemanticDiffDigest changeSetId resultingRevision resultingRootDigest provenance recordedAt".split())
DIGEST_FIELDS = "sourceSchemaLockDigest targetSchemaLockDigest rulesDigest mappingDigest plannedSemanticDiffDigest resultingRootDigest".split()


def validate_migration(migration):
    code = "MIGRATION_INVALID"
    mapping(migration, FIELDS, code)
    require(migration.get("format") == "morivyx.migration/0.1", code, "/format")
    text(migration.get("id"), code, "/id", STABLE_ID)
    for field in ("baseRevision", "resultingRevision"):
        text(migration.get(field), code, pointer("", field), GRAPH_ID)
    for field in DIGEST_FIELDS:
        text(migration.get(field), code, pointer("", field), DIGEST)
    require(migration["sourceSchemaLockDigest"] != migration["targetSchemaLockDigest"],
            "MIGRATION_SCHEMA_UNCHANGED", "/targetSchemaLockDigest")
    text(migration.get("changeSetId"), code, "/changeSetId", STABLE_ID)
    provenance = migration.get("provenance")
    mapping(provenance, None, code, "/provenance")
    text(provenance.get("method"), code, "/provenance/method")
    text(provenance.get("actor"), code, "/provenance/actor", STABLE_ID)
    timestamp(provenance.get("recordedAt"), code, "/provenance/recordedAt")
    timestamp(migration.get("recordedAt"), code, "/recordedAt")
    return migration


def validate_migration_change_set(migration, change_set):
    """Check the referenced record and five boundaries, returning only True.

    Does not authenticate rules or mappings, validate a plan, or apply a change.
    Diagnostic paths are within logical records, without filenames.
    """
    validate_migration(migration)
    missing = change_set is None or change_set is False or (
        type(change_set) in (int, float) and change_set == 0
    ) or (type(change_set) is str and not change_set)
    require(not missing, "MIGRATION_CHANGESET_MISSING", "/changeSetId")
    validate_change_set(change_set)
    for migration_field, change_field in [
        ("changeSetId", "id"), ("baseRevision", "baseRevision"),
        ("resultingRevision", "resultingRevision"), ("resultingRootDigest", "resultingRootDigest"),
        ("targetSchemaLockDigest", "schemaLockDigest"),
    ]:
        require(migration[migration_field] == change_set[change_field],
                "MIGRATION_CHANGESET_MISMATCH", pointer("", migration_field))
    return True
