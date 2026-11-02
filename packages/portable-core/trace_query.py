"""Execute five finite Trace queries over declared projections, without I/O.

This does not recompute revisions or validate Schema, authority or waivers.
"""

from canonical import canonical_json, unicode_text
from record_validation import GRAPH_ID, text, timestamp
from schema_validation import DIGEST, STABLE_ID, ValidationError


INPUT = "TRACE_QUERY_INPUT_INVALID"
TYPES = {"why-artifact-exists": "core.artifact", "governing-decision": "core.artifact",
         "decision-evidence": "core.decision", "goal-achievement-evidence": "core.goal",
         "observation-triggered-change": "core.observation"}
# predicate, lookup endpoint, next endpoint, expected next type, missing label
CHAINS = {
    "why-artifact-exists": [("produces", "target", "source", "core.execution", "produces"),
                            ("executes", "source", "target", "core.plan", "executes"),
                            ("pursues", "source", "target", "core.goal", "pursues")],
    "governing-decision": [("governs", "target", "source", "core.decision", "governs")],
    "goal-achievement-evidence": [("has_criterion", "source", "target", "core.criterion", "has_criterion"),
                                  ("against", "target", "source", "core.verification", "against"),
                                  ("produces", "source", "target", "core.observation", "produces-observation")],
    "observation-triggered-change": [("derived_from", "target", "source", "core.learning", "derived_from"),
                                     ("triggers", "source", "target", None, "triggers")],
}


def fail(code, path):
    raise ValidationError(code, path)


def validate_input(value):
    for field, pattern in (("graphRevision", GRAPH_ID), ("schemaLockDigest", DIGEST), ("focusId", STABLE_ID)):
        text(value.get(field), INPUT, "/" + field, pattern)
    timestamp(value.get("evaluatedAt"), INPUT, "/evaluatedAt")
    if "id" in value:
        text(value["id"], INPUT, "/id", STABLE_ID)
    elements = value.get("elements")
    if type(elements) is not list:
        fail(INPUT, "/elements")
    seen = set()
    for index, element in enumerate(elements):
        path = "/elements/" + str(index)
        if type(element) is not dict:
            fail(INPUT, path)
        text(element.get("id"), INPUT, path + "/id", STABLE_ID)
        if element["id"] in seen:
            fail(INPUT, path + "/id")
        seen.add(element["id"])
        if element.get("kind") not in ("entity", "relation"):
            fail(INPUT, path + "/kind")
        if element["kind"] == "entity":
            text(element.get("type"), INPUT, path + "/type")
            text(element.get("revision"), INPUT, path + "/revision", DIGEST)
            continue
        attributes = element.get("attributes")
        if type(attributes) is not dict:
            fail(INPUT, path + "/attributes")
        for field in ("source", "target"):
            text(attributes.get(field), INPUT, path + "/attributes/" + field, STABLE_ID)
        text(attributes.get("predicate"), INPUT, path + "/attributes/predicate")
        if "revision" in element:
            text(element["revision"], INPUT, path + "/revision", DIGEST)


def js_truthy(value):
    # Empty lists and mappings are true in the product's challengeReview check.
    return True if type(value) in (dict, list) else bool(value)


def execute_trace_query(value):
    """Return complete, partial or broken; no package validity/trust verdict."""
    value = value if type(value) is dict else {}
    query = value.get("queryId")
    if type(query) is not str or query not in TYPES:
        fail("TRACE_QUERY_UNKNOWN", "/queryId")
    validate_input(value)
    elements = value["elements"]
    index = {unicode_text(element["id"]): element for element in elements}
    lookup = {}
    for element in elements:
        if element["kind"] == "relation":
            attributes = element["attributes"]
            for endpoint in ("source", "target"):
                key = (attributes["predicate"], endpoint, unicode_text(attributes[endpoint]))
                lookup.setdefault(key, []).append(element)
    focus_id = unicode_text(value["focusId"])
    focus = index.get(focus_id)
    broken = False

    def relations(predicate, endpoint, identity):
        return lookup.get((predicate, endpoint, identity), [])

    def hop(relation):
        nonlocal broken
        attributes = relation["attributes"]
        source, target = unicode_text(attributes["source"]), unicode_text(attributes["target"])
        before, after = index.get(source), index.get(target)
        if before is None or after is None or before["kind"] != "entity" or after["kind"] != "entity":
            broken = True
            return None
        return {"fromId": source, "predicate": attributes["predicate"], "toId": target,
                "fromRevision": before["revision"], "toRevision": after["revision"]}

    paths = []
    if focus is None or focus["kind"] != "entity" or focus.get("type") != TYPES[query]:
        broken = True
        missing = ["focus" if focus is None else "focus-type"]
    elif query == "decision-evidence":
        counts = {}
        for predicate in ("supported_by", "challenged_by"):
            counts[predicate] = 0
            for relation in relations(predicate, "source", focus_id):
                current = hop(relation)
                if current is not None:
                    paths.append({"hops": [current]})
                    counts[predicate] += 1
        attributes = focus.get("attributes")
        challenge = attributes.get("challengeReview") if type(attributes) is dict else None
        missing = ([] if counts["supported_by"] else ["supported_by"])
        if not counts["challenged_by"] and not js_truthy(challenge):
            missing.append("challenged_by-or-challengeReview")
    else:
        stages = CHAINS[query]
        found = [False] * len(stages)

        def walk(position, identity, prefix):
            nonlocal broken
            predicate, endpoint, next_endpoint, expected, _missing = stages[position]
            for relation in relations(predicate, endpoint, identity):
                current = hop(relation)
                if current is None:
                    continue
                next_id = current["fromId" if next_endpoint == "source" else "toId"]
                if expected is not None and index[next_id].get("type") != expected:
                    broken = True
                    continue
                found[position] = True
                path = [*prefix, current]
                if position + 1 == len(stages):
                    paths.append({"hops": path})
                else:
                    walk(position + 1, next_id, path)

        walk(0, focus_id, [])
        missing = [] if paths else [stages[next(i for i, exists in enumerate(found) if not exists)][4]]
    return {"format": "morivyx.trace-report/0.1", **({"id": value["id"]} if "id" in value else {}),
            "queryId": query, **{field: value[field] for field in ("graphRevision", "schemaLockDigest", "evaluatedAt")},
            "focusId": focus_id, "status": "broken" if broken else "partial" if missing else "complete",
            "paths": sorted(paths, key=canonical_json), "missing": sorted(set(map(unicode_text, missing)))}
