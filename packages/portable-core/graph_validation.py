"""Independent Graph constraints, separate from package and trust validation."""

from collections import defaultdict

from canonical import digest, unicode_text
from schema_validation import ELEMENT_FIELDS, pointer, validate_graph_element, validate_schema_definition


REQUIRED = "format kind id type typeVersion revision lifecycle reviewState attributes".split()
RELATION_FIELDS = {"source", "predicate", "target", "qualifiers"}
RELATION_STATES = {"active", "deprecated", "draft", "retracted", "superseded"}
APPROVAL_FIELDS = "actor targetId targetRevision operation scope approvedAt recordedAt".split()
TRANSITIONS = {
    "core.criterion": {"draft:active", "draft:retracted", "active:deprecated", "active:superseded", "active:retracted"},
    "core.learning": {"draft:active", "draft:retracted", "active:superseded", "active:retracted"},
}


def text(value):
    return unicode_text(value) if type(value) is str else ""


def issue(code, phase, element_id="", path="", related_id=""):
    return {"code": code, "phase": phase, "elementId": element_id, "path": path, "relatedId": related_id}


def groups_by(elements, field):
    groups = defaultdict(list)
    for element in elements:
        if type(element.get(field)) is str:
            groups[text(element[field])].append(element)
    return groups


def components(nodes, adjacency):
    """Iterative Kosaraju traversal; no recursion limit on long Graph paths."""
    visited, order = set(), []
    for root in sorted(nodes):
        pending = [(root, False)]
        while pending:
            node, finished = pending.pop()
            if finished:
                order.append(node)
            elif node not in visited:
                visited.add(node)
                pending.append((node, True))
                pending.extend((child, False) for child in reversed(sorted(adjacency.get(node, ()))))
    reverse = defaultdict(set)
    for source, targets in adjacency.items():
        for target in targets:
            reverse[target].add(source)
    assigned = set()
    result = []
    for root in reversed(order):
        if root in assigned:
            continue
        component, pending = [], [root]
        assigned.add(root)
        while pending:
            node = pending.pop()
            component.append(node)
            for child in reverse.get(node, ()):
                if child not in assigned:
                    assigned.add(child)
                    pending.append(child)
        result.append(sorted(component))
    return result


def graph_constraints(elements, definitions):
    result = []
    groups = groups_by(elements, "id")
    relations = sorted((e for e in elements if e["kind"] == "relation"), key=lambda e: text(e["id"]))
    outgoing, by_predicate = defaultdict(list), defaultdict(list)
    source_counts, target_counts = defaultdict(int), defaultdict(int)
    for relation in relations:
        attributes = relation["attributes"]
        source, predicate, target = (attributes.get(k) for k in ("source", "predicate", "target"))
        outgoing[text(source)].append(relation)
        if type(predicate) is not str:
            continue
        by_predicate[predicate].append(relation)
        source_counts[predicate, text(source)] += 1
        target_counts[predicate, text(target)] += 1
        definition = definitions.get(predicate)
        if definition is None:
            continue
        for field, reference in (("source", source), ("target", target)):
            if reference is None:
                continue
            candidates = groups.get(text(reference), []) if type(reference) is str else []
            code = "RELATION_TARGET_MISSING" if not candidates else (
                "RELATION_TYPE_DISALLOWED" if len(candidates) == 1 and candidates[0]["type"] not in definition[field + "Types"] else None
            )
            if code:
                result.append(issue(code, 5, text(relation["id"]), "/" + field, text(reference)))
    entities_by_type = defaultdict(list)
    for index, element in enumerate(elements):
        if element["kind"] == "entity":
            entities_by_type[element["type"]].append((index, element))
    for predicate, definition in definitions.items():
        if predicate in ("produces", "supported_by", "challenged_by"):
            continue
        if definition["minCount"] == 0 and definition["maxCount"] is None:
            continue
        sources = sorted((entry for source_type in dict.fromkeys(definition["sourceTypes"])
                          for entry in entities_by_type[source_type]), key=lambda entry: entry[0])
        for _index, source in sources:
            count = source_counts[predicate, text(source["id"])]
            if count < definition["minCount"] or (definition["maxCount"] is not None and count > definition["maxCount"]):
                result.append(issue("RELATION_CARDINALITY", 5, text(source["id"]), pointer("/relations", predicate)))
    for element in elements:
        if element["kind"] != "entity":
            continue
        identity = text(element["id"])
        if element["type"] == "core.decision" and element["lifecycle"] == "accepted":
            predicates = [r["attributes"].get("predicate") for r in outgoing[identity]]
            if "supported_by" in definitions and "supported_by" not in predicates:
                result.append(issue("RELATION_CARDINALITY", 5, identity, "/relations/supported_by"))
            if "challenged_by" in definitions and "challengeReview" not in element["attributes"] and "challenged_by" not in predicates:
                result.append(issue("RELATION_CARDINALITY", 5, identity, "/relations/challenged_by"))
        producer = definitions.get("produces")
        if element["type"] == "core.artifact" and producer and "core.artifact" in producer["targetTypes"]:
            if target_counts["produces", identity] > 1:
                result.append(issue("RELATION_CARDINALITY", 5, identity, "/relations/produces"))
    duplicate_relations = defaultdict(list)
    for relation in relations:
        values = [relation["attributes"].get(k) for k in ("source", "predicate", "target")]
        if all(type(v) is str for v in values) and values[1] in definitions:
            duplicate_relations[tuple(map(text, values))].append(relation)
    for group in duplicate_relations.values():
        if len(group) > 1:
            result.append(issue("RELATION_DUPLICATE", 6, text(group[0]["id"]),
                                pointer("/relations", group[0]["attributes"]["predicate"]), text(group[1]["id"])))
    for predicate, definition in definitions.items():
        if definition["cycle"] != "forbidden":
            continue
        nodes, adjacency = set(), defaultdict(set)
        for relation in by_predicate[predicate]:
            source, target = (text(relation["attributes"].get(k)) for k in ("source", "target"))
            source_candidates, target_candidates = groups.get(source, []), groups.get(target, [])
            if len(source_candidates) != 1 or len(target_candidates) != 1:
                continue
            if source_candidates[0]["type"] not in definition["sourceTypes"] or target_candidates[0]["type"] not in definition["targetTypes"]:
                continue
            nodes.update((source, target))
            adjacency[source].add(target)
        for component in components(nodes, adjacency):
            if len(component) > 1 or component[0] in adjacency[component[0]]:
                result.append(issue("CYCLE_FORBIDDEN", 6, component[0], pointer("/relations", predicate),
                                    component[1] if len(component) > 1 else component[0]))
    return result


def phase_seven(elements, previous, approvals):
    result = []
    previous_by_id = {key: values[0] for key, values in groups_by(previous, "id").items() if len(values) == 1}
    for element in elements:
        allowed = TRANSITIONS.get(element["type"])
        before = previous_by_id.get(text(element["id"]))
        if allowed is not None and before and before.get("type") == element["type"] and before.get("lifecycle") != element["lifecycle"]:
            if type(before.get("lifecycle")) is str and before["lifecycle"] + ":" + element["lifecycle"] not in allowed:
                result.append(issue("LIFECYCLE_TRANSITION", 7, text(element["id"]), "/lifecycle"))
        provenance = element.get("provenance")
        if type(provenance) is not dict:
            result.append(issue("PROVENANCE_REQUIRED", 7, text(element["id"]), "/provenance"))
        else:
            for field in ("method", "actor", "recordedAt"):
                if type(provenance.get(field)) is not str or not provenance[field]:
                    result.append(issue("PROVENANCE_REQUIRED", 7, text(element["id"]), "/provenance/" + field))
    eligible = []
    for approval in approvals:
        if type(approval) is not dict:
            raise ValueError("approval must be a logical mapping")
        missing = [field for field in APPROVAL_FIELDS if type(approval.get(field)) is not str or not approval[field]]
        for field in missing:
            result.append(issue("PROVENANCE_REQUIRED", 7, text(approval.get("targetId")),
                                "/approvals/" + text(approval.get("id")) + "/" + field, text(approval.get("id"))))
        if not missing:
            eligible.append(approval)
    by_id = {text(a.get("id")): a for a in eligible}
    revoked = set()
    for revocation in eligible:
        if revocation.get("operation") != "revoke" or type(revocation.get("revokes")) is not str:
            continue
        granted = by_id.get(text(revocation["revokes"]))
        if granted and all(text(granted.get(k)) == text(revocation.get(k)) for k in ("targetId", "targetRevision")):
            revoked.add(text(granted.get("id")))
    targets = {(text(a["targetId"]), text(a["targetRevision"])) for a in eligible if
               text(a.get("id")) not in revoked and a["operation"] == "approve" and a["scope"] == "single-revision"}
    for element in elements:
        if element["reviewState"] == "approved" and (text(element["id"]), text(element["revision"])) not in targets:
            result.append(issue("APPROVAL_REQUIRED", 7, text(element["id"]), "/reviewState"))
    return result


def validate_graph(*, graph_revision, schema_lock_digest, schemas, elements,
                   registry_issues=None, previous_elements=None, approvals=None):
    """Validate structural records and Graph constraints with explicit schemas.

    Supplied schema bindings, revision digests and approval authority are not
    authenticated by this function. Package-level checks remain separate.
    """
    if any(type(value) is not list for value in (schemas, elements)):
        raise ValueError("schemas and elements must be logical arrays")
    for schema in schemas:
        validate_schema_definition(schema)
    for element in elements:
        validate_graph_element(element)
    previous_elements = [] if previous_elements is None else previous_elements
    approvals = [] if approvals is None else approvals
    if type(previous_elements) is not list or type(approvals) is not list or any(type(e) is not dict for e in previous_elements):
        raise ValueError("history and approvals must be record arrays")
    issues = list(registry_issues or [])
    if not issues:
        entity_types, relation_types = {}, {}
        for schema in schemas:
            for entry in schema["entityTypes"]:
                entity_types.setdefault(entry["typeId"], (schema, entry))
            for entry in schema["relationTypes"]:
                relation_types.setdefault(entry["predicate"], (schema, entry))
        for element in elements:
            identity, attributes = text(element["id"]), element["attributes"]
            for field in REQUIRED:
                if field not in element or element[field] is None:
                    issues.append(issue("SCHEMA_REQUIRED_FIELD", 3, identity, pointer("", field)))
            for field in element:
                if field not in ELEMENT_FIELDS and field.startswith("core."):
                    issues.append(issue("CORE_UNKNOWN", 3, identity, pointer("", field)))
            if element["kind"] == "entity":
                resolved = entity_types.get(element["type"])
                if resolved is None:
                    issues.append(issue("CORE_UNKNOWN", 3, identity, "/type"))
                    continue
                schema, definition = resolved
                states = set(definition["lifecycle"])
                required = definition["requiredAttributes"]
                allowed = set(required + definition.get("optionalAttributes", []))
            else:
                required, allowed = ("source", "predicate", "target"), RELATION_FIELDS
                predicate = attributes.get("predicate")
                resolved = relation_types.get(predicate) if type(predicate) is str else None
                if resolved is None:
                    for field in required:
                        if field not in attributes or attributes[field] is None:
                            issues.append(issue("SCHEMA_REQUIRED_FIELD", 3, identity, pointer("/attributes", field)))
                    for field in attributes:
                        if field not in allowed:
                            issues.append(issue("CORE_UNKNOWN", 3, identity, pointer("/attributes", field)))
                    if predicate is not None:
                        issues.append(issue("CORE_UNKNOWN", 3, identity, "/attributes/predicate"))
                    continue
                schema, definition = resolved
                states = RELATION_STATES
                if schema["schemaId"] == "morivyx.core" and element["type"] != "core." + predicate:
                    issues.append(issue("CORE_UNKNOWN", 3, identity, "/type"))
            if element["typeVersion"] != schema["version"]:
                issues.append(issue("SCHEMA_VERSION_MISMATCH", 3, identity, "/typeVersion"))
            if element["reviewState"] not in schema["reviewStates"]:
                issues.append(issue("CORE_UNKNOWN", 3, identity, "/reviewState"))
            if element["lifecycle"] not in states:
                issues.append(issue("CORE_UNKNOWN", 3, identity, "/lifecycle"))
            for field in required:
                if field not in attributes or attributes[field] is None:
                    issues.append(issue("SCHEMA_REQUIRED_FIELD", 3, identity, pointer("/attributes", field)))
            for field in attributes:
                if field not in allowed:
                    issues.append(issue("CORE_UNKNOWN", 3, identity, pointer("/attributes", field)))
        for field in ("id", "revision"):
            for value, group in groups_by(elements, field).items():
                if len(group) > 1:
                    ids = sorted(text(e["id"]) for e in group)
                    issues.append(issue("ID_DUPLICATE", 4, value if field == "id" else ids[0], "/" + field,
                                        value if field == "id" else ids[1]))
        issues.extend(graph_constraints(elements, {predicate: pair[1] for predicate, pair in relation_types.items()}))
        issues.extend(phase_seven(elements, previous_elements, approvals))
    issues.sort(key=lambda e: (e["phase"], *(text(e.get(k)) for k in ("elementId", "code", "path", "relatedId"))))
    return {
        "valid": not issues, "schemaLockDigest": schema_lock_digest, "graphRevision": graph_revision,
        "rootDigest": digest("root", elements)["digest"], "issues": issues,
        "validation": {"scope": "graph-structure-and-constraints", "recordDigestsValidated": False,
                       "schemaLockBindingValidated": False, "approvalAuthorityValidated": False,
                       "signaturesValidated": False, "packageValidated": False},
    }
