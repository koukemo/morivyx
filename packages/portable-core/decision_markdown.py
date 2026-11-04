"""Independent Decision Markdown projection; no Graph writes or adoption authority.

The CLI accepts one bounded JSON request and emits one bounded JSON projection.
Existing portable canonical and structural validators are shared Python code.
"""

import hashlib
import json
import re
import sys

from canonical import canonical_json, load_json, unicode_text
from schema_validation import DIGEST, SPACE, STABLE_ID, ValidationError, validate_graph_element
from stdin_transport import read_bounded_stdin

LIMIT = 8 * 1024 * 1024
CODE = "DECISION_PROJECTION_INPUT_INVALID"
GRAPH = re.compile(rf"graph:[^{SPACE}]+")
PREDICATES = ("addresses", "considers", "selects", "supported_by", "challenged_by", "governs")
LABELS = ("対象", "検討した選択肢", "採用した選択肢", "根拠", "反証と懸念", "統制する対象")
RULES = {
    "format": "morivyx.decision-markdown-rules/0.1",
    "projectorId": "morivyx.decision-markdown", "projectorVersion": "0.1",
    "relationPredicates": list(PREDICATES),
    "sections": ["state", "question", "rationale", "consequences", "revisitTriggers", "challengeReview", "relations"],
}
CONFIGURATION = {"escaping": "markdown-backslash-v1", "headings": "ja-v1", "lineEnding": "lf"}


def digest_value(domain, value):
    return "sha256:" + hashlib.sha256(domain.encode("ascii") + b"\0" + canonical_json(value).encode("utf-8")).hexdigest()


RULES_DIGEST = digest_value("morivyx:decision-markdown-rules:v1", RULES)
CONFIGURATION_DIGEST = digest_value("morivyx:decision-markdown-configuration:v1", CONFIGURATION)


def require(condition, path):
    if not condition:
        raise ValidationError(CODE, path)


def text(value, path, pattern=None):
    require(type(value) is str and len(value) > 0 and (pattern is None or pattern.fullmatch(value) is not None), path)


def text_list(value, path, allow_empty=True):
    require(type(value) is list and (allow_empty or len(value) > 0), path)
    for index, entry in enumerate(value):
        text(entry, path + "/" + str(index))


def markdown_text(value):
    value = unicode_text(value).replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", lambda match: "\\u" + format(ord(match[0]), "04x"), value)
    lines = []
    for line in value.split("\n"):
        spaces = len(line) - len(line.lstrip(" "))
        lines.append("&#32;" * spaces + re.sub(r"[\\`*_{}\[\]<>#+\-.!|()>=~]", lambda match: "\\" + match[0], line[spaces:]))
    return "\n".join(lines)


def render_list(values):
    return ["- " + markdown_text(value).replace("\n", "\n  ") for value in values] if values else ["- なし"]


def project_decision_markdown(value):
    # Preserve the Node API's validation order and raw ID lookup semantics.
    canonical_json(value)
    require(type(value) is dict, "")
    for field in value:
        require(field in ("graphRevision", "decisionId", "elements", "projectorPackageDigest"), "/" + field)
    text(value.get("graphRevision"), "/graphRevision", GRAPH)
    text(value.get("decisionId"), "/decisionId", STABLE_ID)
    text(value.get("projectorPackageDigest"), "/projectorPackageDigest", DIGEST)
    elements = value.get("elements")
    require(type(elements) is list, "/elements")
    index = {}
    for position, element in enumerate(elements):
        path = "/elements/" + str(position)
        try:
            validate_graph_element(element)
        except ValidationError as error:
            raise ValidationError(error.code, path + ("#" + error.path if error.path else "")) from None
        require(element["id"] not in index, path + "/id")
        index[element["id"]] = element
    for position, element in enumerate(elements):
        if element["kind"] != "relation":
            continue
        attributes = element["attributes"]
        path = "/elements/" + str(position)
        for field in ("source", "target"):
            text(attributes.get(field), path + "/attributes/" + field, STABLE_ID)
        text(attributes.get("predicate"), path + "/attributes/predicate")
        require(element["type"] == "core." + attributes["predicate"], path + "/type")
        for field in ("source", "target"):
            target = index.get(attributes[field])
            require(target is not None and target["kind"] == "entity", path + "/attributes/" + field)
    decision = index.get(value["decisionId"])
    require(decision is not None and decision["kind"] == "entity" and decision["type"] == "core.decision", "/decisionId")
    attributes = decision["attributes"]
    for field in ("question", "rationale"):
        text(attributes.get(field), "/decision/attributes/" + field)
    text_list(attributes.get("consequences"), "/decision/attributes/consequences", False)
    if "revisitTriggers" in attributes:
        text_list(attributes["revisitTriggers"], "/decision/attributes/revisitTriggers")
    graph_revision = unicode_text(value["graphRevision"])
    metadata = {
        "graphRevision": graph_revision, "sourceId": decision["id"], "sourceRevision": decision["revision"],
        "rulesDigest": RULES_DIGEST, "projectorId": RULES["projectorId"], "projectorVersion": RULES["projectorVersion"],
        "projectorPackageDigest": value["projectorPackageDigest"], "configurationDigest": CONFIGURATION_DIGEST,
    }
    lines = ["---", "type: Decision Projection", 'title: "Decisionの派生表現"',
             'description: "Decisionを人が確認するためにGraphから生成したMarkdown。"']
    lines += [key + ": " + json.dumps(entry, ensure_ascii=False, separators=(",", ":")) for key, entry in metadata.items()]
    lines += ["---", "", "# Decision", "", "## 状態", "",
              "- stable ID: `" + decision["id"] + "`", "- Revision ID: `" + decision["revision"] + "`",
              "- lifecycle: " + markdown_text(decision["lifecycle"]), "- review state: " + markdown_text(decision["reviewState"]),
              "", "## 問い", "", markdown_text(attributes["question"]), "", "## 選択理由", "", markdown_text(attributes["rationale"]),
              "", "## 結果", "", *render_list(attributes["consequences"]), "", "## 再検討条件", "",
              *render_list(attributes.get("revisitTriggers", [])), "", "## 反証確認", "",
              "    " + canonical_json(attributes["challengeReview"]) if "challengeReview" in attributes else "- なし",
              "", "## 関係", ""]
    relations = [entry for entry in elements if entry["kind"] == "relation" and entry["attributes"]["source"] == decision["id"]
                 and entry["attributes"]["predicate"] in PREDICATES]
    relations.sort(key=lambda entry: (PREDICATES.index(entry["attributes"]["predicate"]), entry["attributes"]["target"], entry["id"]))
    for predicate, label in zip(PREDICATES, LABELS):
        lines += ["### " + label + "（`" + predicate + "`）", ""]
        selected = [entry for entry in relations if entry["attributes"]["predicate"] == predicate]
        for relation in selected:
            target = index[relation["attributes"]["target"]]
            lines.append("- type: " + markdown_text(target["type"]) + "、stable ID: `" + target["id"] + "` @ `" + target["revision"]
                         + "`（Relation `" + relation["id"] + "` @ `" + relation["revision"] + "`）")
        if not selected:
            lines.append("- なし")
        lines.append("")
    markdown = "\n".join(lines) + "\n"
    return {"format": "morivyx.decision-markdown-projection/0.1", **metadata, "mediaType": "text/markdown; charset=utf-8",
            "digest": "sha256:" + hashlib.sha256(markdown.encode("utf-8")).hexdigest(), "markdown": markdown}


def main():
    try:
        require(len(sys.argv) == 1, "")
        value = load_json(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"))
        output = json.dumps(project_decision_markdown(value), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        require(len(output.encode("utf-8")) + 1 <= LIMIT, "")
    except (ValueError, TypeError, KeyError, OSError, RecursionError, OverflowError):
        # No user-controlled strings or tracebacks in command diagnostics.
        print('{"error":{"code":"DECISION_PROJECTION_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
