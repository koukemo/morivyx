"""Validate approval record structure and ledger links, not actor authority."""

from canonical import TIMESTAMP, canonical_json
from schema_validation import DIGEST, STABLE_ID, ValidationError, pointer, require


FIELDS = set("format id actor targetId targetRevision operation scope approvedAt recordedAt expiresAt revokes".split())
CODE = "APPROVAL_INVALID"


def validate_approval(approval):
    require(type(approval) is dict, CODE, "")
    for key in approval:
        require(key in FIELDS, CODE, pointer("", key))
    require(approval.get("format") == "morivyx.approval/0.1", CODE, "/format")
    for field in ("id", "actor", "targetId", "targetRevision", "operation", "scope"):
        value = approval.get(field)
        require(type(value) is str and bool(value), CODE, pointer("", field))
        pattern = STABLE_ID if field in ("id", "actor", "targetId") else DIGEST if field == "targetRevision" else None
        if pattern is not None:
            require(pattern.fullmatch(value) is not None, CODE, pointer("", field))
    for field in ("approvedAt", "recordedAt", "expiresAt"):
        if field == "expiresAt" and field not in approval:
            continue
        value = approval.get(field)
        require(type(value) is str and TIMESTAMP.fullmatch(value) is not None, CODE, pointer("", field))
        try:
            canonical_json(value)
        except ValueError:
            raise ValidationError(CODE, pointer("", field)) from None
    if approval["operation"] == "revoke":
        value = approval.get("revokes")
        require(type(value) is str and STABLE_ID.fullmatch(value) is not None and value != approval["id"], CODE, "/revokes")
    else:
        require("revokes" not in approval, CODE, "/revokes")
    return approval


def validate_approval_ledger(approvals):
    """Validate the default logical ledger API, returning the unchanged input.

    Does not evaluate allowed actors, effective times, signatures or permissions.
    Diagnostic paths are JSON pointers within the logical input, not file paths.
    """
    require(type(approvals) is list, CODE, "/approvals")
    by_id = {}
    for index, approval in enumerate(approvals):
        try:
            validate_approval(approval)
        except ValidationError as error:
            raise ValidationError(error.code, "/approvals/" + str(index) + error.path) from None
        path = "/approvals/" + str(index)
        require(approval["id"] not in by_id, CODE, path + "/id")
        by_id[approval["id"]] = approval
    for index, approval in enumerate(approvals):
        if approval["operation"] != "revoke":
            continue
        revoked = by_id.get(approval["revokes"])
        require(revoked is not None and revoked["operation"] != "revoke" and all(
            revoked[field] == approval[field] for field in ("targetId", "targetRevision")
        ), CODE, "/approvals/" + str(index) + "/revokes")
    return approvals
