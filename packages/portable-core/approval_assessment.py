"""Evaluate declared approval evidence; authenticity and authority stay unverified."""

import copy
import json

from approval_validation import validate_approval, validate_approval_ledger
from canonical import TIMESTAMP, canonical_json
from schema_validation import STABLE_ID, ValidationError


UNSET = object()
FIELDS = {"targetId", "targetRevision", "operation", "scope", "evaluatedAt", "allowedActors"}


def invalid(path):
    raise ValidationError("APPROVAL_ASSESSMENT_INVALID", path)


def time(value):
    if type(value) is not str or TIMESTAMP.fullmatch(value) is None:
        invalid("/time")
    try:
        normalized = json.loads(canonical_json(value))
    except ValueError:
        invalid("/time")
    return normalized[:19], normalized[19:-1].removeprefix(".")


def compare(left, right):
    if left[0] != right[0]:
        return -1 if left[0] < right[0] else 1
    length = max(len(left[1]), len(right[1]))
    a, b = left[1].ljust(length, "0"), right[1].ljust(length, "0")
    return 0 if a == b else -1 if a < b else 1


def assess_approvals(approvals=UNSET, context=UNSET):
    """Return eligibility at a declared instant; does not authorize a write."""
    try:
        canonical_json(approvals)
        canonical_json(context)
        records, request = copy.deepcopy(approvals), copy.deepcopy(context)
    except (ValueError, TypeError, RecursionError):
        invalid("/")
    if (type(request) is not dict or set(request) != FIELDS or type(request.get("allowedActors")) is not list
            or any(type(actor) is not str or STABLE_ID.fullmatch(actor) is None for actor in request["allowedActors"])
            or len(set(request["allowedActors"])) != len(request["allowedActors"]) or request.get("operation") == "revoke"):
        invalid("/context")
    validate_approval({"format": "morivyx.approval/0.1", "id": "urn:uuid:00000000-0000-4000-8000-000000000001",
                       "actor": "urn:uuid:00000000-0000-4000-8000-000000000001",
                       **{field: request[field] for field in ("targetId", "targetRevision", "operation", "scope")},
                       "approvedAt": request["evaluatedAt"], "recordedAt": request["evaluatedAt"]})
    validate_approval_ledger(records)
    now = time(request["evaluatedAt"])
    times = {}
    for record in records:
        approved, recorded = time(record["approvedAt"]), time(record["recordedAt"])
        expires = time(record["expiresAt"]) if "expiresAt" in record else None
        if compare(approved, recorded) > 0 or (expires is not None and compare(expires, approved) <= 0):
            invalid("/approvals/time")
        times[record["id"]] = {"approved": approved, "recorded": recorded, "expires": expires}
    by_id = {record["id"]: record for record in records}
    trusted = set(request["allowedActors"])
    revoked = set()
    for record in records:
        if record["operation"] != "revoke":
            continue
        granted, at = by_id[record["revokes"]], times[record["id"]]
        if record["scope"] != granted["scope"] or compare(at["approved"], times[granted["id"]]["approved"]) < 0:
            invalid("/approvals/revokes")
        if compare(at["approved"], now) <= 0 and compare(at["recorded"], now) <= 0:
            revoked.add(record["revokes"])
    evaluations = []
    for record in records:
        if record["operation"] == "revoke":
            continue
        at = times[record["id"]]
        if record["targetId"] != request["targetId"] or record["targetRevision"] != request["targetRevision"]:
            reason = "target-mismatch"
        elif record["operation"] != request["operation"]:
            reason = "operation-mismatch"
        elif record["scope"] != request["scope"]:
            reason = "scope-mismatch"
        elif record["actor"] not in trusted:
            reason = "actor-not-allowed"
        elif compare(at["approved"], now) > 0 or compare(at["recorded"], now) > 0:
            reason = "not-yet-effective"
        elif at["expires"] is not None and compare(at["expires"], now) <= 0:
            reason = "expired"
        elif record["id"] in revoked:
            reason = "revoked"
        else:
            reason = "applicable"
        evaluations.append({"approvalId": record["id"], "actor": record["actor"], "reason": reason})
    applicable = [record for record in evaluations if record["reason"] == "applicable"]
    return {"applicable": bool(applicable), **{field: request[field] for field in ("targetId", "targetRevision", "operation", "scope", "evaluatedAt")},
            "approvals": [{field: record[field] for field in ("approvalId", "actor")} for record in applicable],
            "evaluations": evaluations, "authenticity": "not-verified", "persisted": False}
