"""Apply existing Migration boundaries to logical values, without persistence.

Supplied target validation is a caller assertion checked for consistency, not an
authenticated proof. Rules, mappings, authority and signatures are not verified.
"""

from canonical import digest
from changeset_apply import apply_change_set
from migration_validation import validate_migration_change_set
from report_validation import validate_migration_semantic_diff_report
from schema_validation import ValidationError


def fail(code, path):
    raise ValidationError(code, path)


def planned_diff(migration, report):
    code = "MIGRATION_SEMANTIC_DIFF_MISMATCH"
    if type(report) is not dict:
        fail(code, "/plannedSemanticDiff")
    if report.get("format") != "morivyx.migration-semantic-diff/0.1":
        fail(code, "/plannedSemanticDiff/format")
    try:
        validate_migration_semantic_diff_report(report)
    except ValidationError as error:
        fail(code, "/plannedSemanticDiff" + error.path)
    value = digest("migration-semantic-diff", report)["digest"]
    if value != migration["plannedSemanticDiffDigest"]:
        fail(code, "/plannedSemanticDiffDigest")
    for field, expected in [("baseRevision", migration["baseRevision"]), ("targetRevision", migration["resultingRevision"]),
                            ("sourceSchemaLockDigest", migration["sourceSchemaLockDigest"]), ("targetSchemaLockDigest", migration["targetSchemaLockDigest"])]:
        if report[field] != expected:
            fail(code, "/plannedSemanticDiff/" + field)
    return value


def target_result(migration, validation, root):
    if type(validation) is not dict:
        fail("MIGRATION_TARGET_VALIDATION_REQUIRED", "/targetValidation")
    if validation.get("valid") is not True:
        fail("MIGRATION_TARGET_VALIDATION_FAILED", "/targetValidation/valid")
    if type(validation.get("issues")) is not list or validation["issues"]:
        fail("MIGRATION_TARGET_VALIDATION_FAILED", "/targetValidation/issues")
    for field, expected in [("graphRevision", migration["resultingRevision"]), ("schemaLockDigest", migration["targetSchemaLockDigest"]), ("rootDigest", root)]:
        if validation.get(field) != expected:
            fail("MIGRATION_TARGET_VALIDATION_MISMATCH", "/targetValidation/" + field)


def apply_migration(value):
    """Return copied logical application and digests after checking boundaries."""
    value = value if type(value) is dict else {}
    migration, change_set = value.get("migration"), value.get("changeSet")
    validate_migration_change_set(migration, change_set)
    planned = planned_diff(migration, value.get("plannedSemanticDiff"))
    application = apply_change_set({
        "changeSet": change_set, "currentRevision": value.get("currentRevision"),
        "sourceSchemaLockDigest": migration["sourceSchemaLockDigest"], "targetSchemaLockDigest": migration["targetSchemaLockDigest"],
        "currentElements": value.get("currentElements"), "candidateElements": value.get("candidateElements", []),
        "resultingRevision": value.get("resultingRevision"),
    })
    target_result(migration, value.get("targetValidation"), application["rootDigest"])
    return {**application, "migrationDigest": digest("migration", migration)["digest"], "plannedSemanticDiffDigest": planned}
