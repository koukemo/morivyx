"""Read-only, independent preparation of a stored Graph and a proposed ChangeSet.

Call ownership is synchronous; the returned awaitable performs filesystem reads.
The result is a comparison, never approval, adoption authority or a write token.
Only the standard library and the published portable modules are used.
"""

import asyncio
from copy import deepcopy
import os
import re
import stat

from canonical import UNDEFINED, canonical_json, digest, _helper_string
from changeset_apply import apply_change_set
from graph_validation import validate_graph
import package_records as _records
from record_validation import OPERATION_RULES
from record_validation import validate_schema_lock, validate_graph_revision, validate_change_set
from approval_validation import validate_approval, validate_approval_ledger
from migration_validation import validate_migration, validate_migration_change_set
from schema_registry import registry_issue, schema_key
from schema_validation import (PackageError, ValidationError, SCHEMA_ID, VERSION,
                               validate_schema_definition)
from schema_validation import validate_graph_element
from semantic_diff import create_semantic_diff


__all__ = ["prepare_proposal_review"]
_FIELDS = {"basePath", "changeSet", "candidateElements", "resultingRevision", "evaluatedAt"}
_CHANGE_FIELDS = {"format", "id", "baseRevision", "resultingRevision", "resultingRootDigest",
                  "schemaLockDigest", "operations", "provenance", "recordedAt"}
_ELEMENT_FIELDS = {"format", "kind", "id", "type", "typeVersion", "revision", "lifecycle",
                   "reviewState", "attributes", "provenance", "extensions"}


def _fail(suffix, path, message):
    raise PackageError("PROPOSAL_REVIEW_" + suffix, path, message)


def _own(value):
    # Reject host objects before attribute access, iteration hooks or deepcopy.
    pending, active = [(value, False)], set()
    while pending:
        item, leaving = pending.pop()
        if leaving:
            active.remove(id(item))
            continue
        if type(item) in (dict, list):
            if id(item) in active:
                raise ValueError("cyclic JSON")
            active.add(id(item))
            pending.append((item, True))
            if type(item) is dict:
                if any(type(key) is not str for key in item):
                    raise ValueError("non-string JSON key")
                pending.extend((child, False) for child in item.values())
            else:
                pending.extend((child, False) for child in item)
        elif item is not None and type(item) not in (str, int, float, bool):
            raise ValueError("non-JSON value")
    canonical_json(value)
    return deepcopy(value)


def _change_message(value, path):
    """Explain structure diagnostics using the public record vocabulary."""
    if type(value) is not dict:
        return "ChangeSetは対応表でなければなりません。"
    parts = path.strip("/").split("/") if path else []
    field = parts[-1] if parts else ""
    if parts and parts[0] not in _CHANGE_FIELDS:
        return "定義されていない項目です: " + parts[0].replace("~1", "/").replace("~0", "~")
    if path == "/format":
        return "対応していないChangeSet形式です。"
    if path == "/operations":
        return "revokeを他の操作と混在させられません。" if type(value.get("operations")) is list and value["operations"] else "ChangeSetには一件以上の操作が必要です。"
    if parts and parts[0] == "operations" and len(parts) >= 2:
        operation = value["operations"][int(parts[1])]
        if len(parts) == 2:
            return "ChangeSetの操作は対応表でなければなりません。"
        if field not in {"op", "targetId", "beforeRevision", "afterRevision", "replacementId"}:
            return "定義されていない項目です: " + field.replace("~1", "/").replace("~0", "~")
        if field == "op":
            return "未知の操作です: " + _helper_string(operation.get("op", UNDEFINED))
        rules = OPERATION_RULES.get(operation.get("op"), ([], []))
        if field in rules[0] and field not in operation:
            return "操作に必須の項目がありません: " + field
        if field in rules[1] and field in operation:
            return "操作に置けない項目です: " + field
        if field == "replacementId" and operation.get(field) == operation.get("targetId"):
            return "replacementIdはtargetIdと異なるstable IDにします。"
    if path == "/provenance":
        return "ProvenanceRecordが必要です。"
    if field in {"id", "actor", "targetId", "replacementId"}:
        return "小文字のUUID版4 stable IDが必要です。"
    if field in {"baseRevision", "resultingRevision"}:
        return "graph:で始まるGraphRevision IDが必要です。"
    if field in {"resultingRootDigest", "schemaLockDigest", "beforeRevision", "afterRevision"}:
        return "小文字のSHA-256 digestが必要です。"
    if field == "recordedAt":
        source = value.get("provenance", {}).get(field) if len(parts) > 1 else value.get(field)
        from canonical import TIMESTAMP
        return "実在する日時と時間帯が必要です。" if type(source) is str and TIMESTAMP.fullmatch(source) else "RFC 3339形式の時刻が必要です。"
    return "空でない文字列が必要です。"


def _element_message(element, path):
    field = path.strip("/").split("/")[-1]
    first = path.strip("/").split("/")[0]
    if first and first not in _ELEMENT_FIELDS:
        return "定義されていない項目です: " + first.replace("~1", "/").replace("~0", "~")
    fixed = {"format": "対応していないGraphElement形式です。", "kind": "kindはentityまたはrelationにします。",
             "id": "小文字のUUID版4 stable IDが必要です。", "actor": "小文字のUUID版4 stable IDが必要です。",
             "type": "名前空間付き型IDが必要です。", "revision": "小文字のSHA-256 Revision IDが必要です。",
             "reviewState": "定義済みのreview stateが必要です。"}
    if field in fixed:
        return fixed[field]
    if path in ("/attributes", "/provenance", "/extensions"):
        return ("ProvenanceRecord" if field == "provenance" else field) + "は対応表でなければなりません。"
    if first == "extensions":
        return "Extensionには名前空間付きkeyが必要です。"
    if field == "recordedAt":
        from canonical import TIMESTAMP
        value = element.get("provenance", {}).get(field)
        return "実在する日時と時間帯が必要です。" if type(value) is str and TIMESTAMP.fullmatch(value) else "RFC 3339形式の時刻が必要です。"
    return "空でない文字列が必要です。"


def _apply_message(error, value):
    code, path = error.code, error.path
    change = value.get("changeSet")
    if code == "CHANGESET_INVALID":
        return _change_message(change, path)
    fixed = {
        "CHANGESET_BASE_REVISION_MISMATCH": "ChangeSetのbaseRevisionが現在のGraphRevisionと一致しません。",
        "CHANGESET_SCHEMA_LOCK_MISMATCH": "ChangeSetと現在のSchema lock digestが一致しません。",
        "CHANGESET_CANDIDATE_REVISION_MISMATCH": "候補のRevision IDが内容の再計算値と一致しません。",
    }
    if code in fixed:
        return fixed[code]
    if code == "CHANGESET_RESULT_MISMATCH":
        if path == "/resultingRootDigest":
            return "適用結果のroot digestがChangeSetと一致しません。"
        if path == "/resultingRevisionRecord":
            return "適用後のGraphRevision記録が必要です。"
        record = value.get("resultingRevision")
        field = path.rsplit("/", 1)[-1]
        expected = {"format": "morivyx.graph-revision/0.1", "id": change["resultingRevision"],
                    "parentRevision": change["baseRevision"], "rootDigest": change["resultingRootDigest"],
                    "schemaLockDigest": value["schemaLockDigest"]}
        if field in expected and (type(record) is not dict or record.get(field, UNDEFINED) != expected[field]):
            return "適用後のGraphRevisionがChangeSetと一致しません: " + field
        pointer = path.removeprefix("/resultingRevisionRecord")
        return _record_message(ValidationError("GRAPH_REVISION_INVALID", pointer), record)
    if code == "CHANGESET_REVOKE_INVALID":
        target = change["operations"][0]["targetId"]
        if target == change["id"]:
            return "ChangeSetは自分自身をrevokeできません。"
        return "適用済みのChangeSetはrevokeできません。" if target in value["appliedChangeSetIds"] else "撤回対象のChangeSetがありません。"
    if code == "CHANGESET_PRECONDITION_FAILED":
        if path.startswith("/candidateElements/"):
            return "操作から参照されない候補GraphElementがあります。"
        field = path.rsplit("/", 1)[-1]
        if field == "targetId":
            index = int(path.split("/")[2])
            return "createのstable IDが現在のGraphに存在します。" if change["operations"][index]["op"] == "create" else "操作対象が現在のGraphにありません。"
        return {"beforeRevision": "beforeRevisionが現在のRevision IDと一致しません。", "afterRevision": "afterRevisionに対応する候補GraphElementがありません。", "replacementId": "replacementIdが現在のGraphに存在します。"}[field]
    if code == "CHANGESET_APPLY_INVALID" and path.startswith("/candidateElements"):
        parts = path.strip("/").split("/")
        if len(parts) == 1:
            return "候補GraphElementの一覧が必要です。"
        element = value["candidateElements"][int(parts[1])]
        if len(parts) == 2:
            if type(element) is not dict:
                return "候補GraphElementは対応表にします。"
            if any(type(element.get(k)) is not str for k in ("id", "revision")):
                return "候補のidとrevisionが必要です。"
            return "同じ候補Revisionが重複しています。"
        return _element_message(element, "/" + "/".join(parts[2:]))
    return str(error)


def _file_message(error, record=None):
    messages = {
        "PACKAGE_FILE_MISSING": "Graph package の必須ファイルがありません。",
        "PACKAGE_AUTHORING_PROFILE_INVALID": "YAML の末尾改行は一件だけにします。",
        "PACKAGE_YAML_INVALID": "記録の根は対応表でなければなりません。",
        "PACKAGE_PATH_INVALID": "Graph package には symbolic link や特殊ファイルを置けません。",
        "PACKAGE_FILENAME_ID_MISMATCH": "ファイル名と記録内の stable ID が一致しません。",
        "REVISION_ID_MISMATCH": "記録した Revision ID が canonical form の再計算値と一致しません。",
        "SCHEMA_LOCK_DIGEST_MISMATCH": "記録した Schema 固定情報の digest が再計算値と一致しません。",
        "ROOT_DIGEST_MISMATCH": "記録した Graph の根の digest が再計算値と一致しません。",
        "REPORT_ID_REQUIRED": "保存済みReportにはstable IDが必要です。",
    }
    return messages.get(error.code, str(error))


def _record_message(error, record):
    code, path = error.code, error.path
    field = path.rsplit("/", 1)[-1]
    if code == "CHANGESET_INVALID":
        return _change_message(record, path)
    if code == "GRAPH_ELEMENT_INVALID":
        return _element_message(record, path)
    if code == "APPROVAL_INVALID":
        if not path:
            return "approvalは対応表でなければなりません。"
        allowed = {"format", "id", "actor", "targetId", "targetRevision", "operation", "scope", "approvedAt", "recordedAt", "expiresAt", "revokes"}
        if field not in allowed:
            return "定義されていない項目です: " + field.replace("~1", "/").replace("~0", "~")
        if field == "format":
            return "対応していないapproval形式です。"
        if field in {"id", "actor", "targetId"}:
            return "小文字のUUID版4 stable IDが必要です。"
        if field == "targetRevision":
            return "小文字のSHA-256 Revision IDが必要です。"
        if field in {"operation", "scope"}:
            return "空でない文字列が必要です。"
        if field == "revokes":
            if record.get("operation") != "revoke":
                return "revoke以外の操作にrevokesは置けません。"
            if field not in record:
                return "revoke操作には撤回対象のapproval stable IDが必要です。"
            if record[field] == record["id"]:
                return "approvalは自分自身を撤回できません。"
            return "小文字のUUID版4 stable IDが必要です。"
        from canonical import TIMESTAMP
        value = record.get(field)
        return "実在する日時と時間帯が必要です。" if type(value) is str and TIMESTAMP.fullmatch(value) else "RFC 3339形式の時刻が必要です。"
    if code.startswith("REPORT_"):
        return _report_message(error, record)
    if code.startswith("MIGRATION_"):
        if code == "MIGRATION_SCHEMA_UNCHANGED":
            return "Migrationの変換元と変換先のSchema lock digestは異なる値にします。"
        if code == "MIGRATION_CHANGESET_MISSING":
            return "Migrationが参照するChangeSetがありません。"
        if code == "MIGRATION_CHANGESET_MISMATCH":
            return "MigrationとChangeSetの境界が一致しません: " + field
        if not path:
            return "Migrationは対応表にします。"
        allowed = {"format", "id", "baseRevision", "sourceSchemaLockDigest", "targetSchemaLockDigest", "rulesDigest", "mappingDigest", "plannedSemanticDiffDigest", "changeSetId", "resultingRevision", "resultingRootDigest", "provenance", "recordedAt"}
        if path.count("/") == 1 and field not in allowed:
            return "定義されていない項目です: " + field.replace("~1", "/").replace("~0", "~")
        if field == "format":
            return "対応していないMigration形式です。"
        if field in {"id", "actor", "changeSetId"}:
            return "小文字のUUID版4 stable IDが必要です。"
        if field.endswith("Digest"):
            return "小文字のSHA-256 digestが必要です。"
        if field in {"baseRevision", "resultingRevision"}:
            return "graph:で始まるGraphRevision IDが必要です。"
        if field == "provenance":
            return "ProvenanceRecordが必要です。"
        if field == "recordedAt":
            from canonical import TIMESTAMP
            value = record.get("provenance", {}).get(field) if path.startswith("/provenance/") else record.get(field)
            return "実在する日時と時間帯が必要です。" if type(value) is str and TIMESTAMP.fullmatch(value) else "RFC 3339形式の時刻が必要です。"
        return "空でない文字列が必要です。"
    if code == "GRAPH_REVISION_INVALID":
        if not path:
            return "GraphRevisionは対応表でなければなりません。"
        if field not in {"format", "id", "parentRevision", "rootDigest", "schemaLockDigest"}:
            return "定義されていない項目です: " + field.replace("~1", "/").replace("~0", "~")
        if field == "format":
            return "対応していないGraphRevision形式です。"
        if field in {"rootDigest", "schemaLockDigest"}:
            return "小文字のSHA-256 digestが必要です。"
        if field == "parentRevision" and record.get("parentRevision") == record.get("id"):
            return "GraphRevisionは自分自身をparentにできません。"
        return "graph:で始まるGraphRevision IDが必要です。"
    fixed = {"STABLE_ID_SCHEME_UNSUPPORTED": "Stage 1 は urn-uuid-v4 だけを受け入れます。",
             "DIGEST_ALGORITHM_UNSUPPORTED": "Stage 1 は sha256 だけを受け入れます。",
             "SCHEMA_LOCK_ORDER_INVALID": "Schema固定情報の一覧が昇順でないか、重複しています。"}
    if code in fixed:
        return fixed[code]
    if code == "PACKAGE_FORMAT_UNSUPPORTED":
        return "対応していない保存形式です: " + _helper_string(record.get("format", UNDEFINED))
    if code == "SCHEMA_LOCK_INVALID":
        if not path:
            return "Schema lockは対応表でなければなりません。"
        if path == "/schemas":
            return "Schema固定情報のschemasは一覧でなければなりません。"
        if re.fullmatch(r"/schemas/[0-9]+", path):
            return "Schema固定情報の各要素は対応表でなければなりません。"
        if field == "digest":
            return "小文字のSHA-256 digestが必要です。"
        allowed = {"schemaId", "version", "digest"} if path.startswith("/schemas/") else {"format", "stableIdScheme", "digestAlgorithm", "schemas"}
        if field not in allowed:
            return "定義されていない項目です: " + field.replace("~1", "/").replace("~0", "~")
        return "空でない文字列が必要です。"
    return _file_message(error, record)


def _report_message(error, record):
    path, code = error.path, error.code
    parts = [p.replace("~1", "/").replace("~0", "~") for p in path.strip("/").split("/")] if path else []
    field = parts[-1] if parts else ""
    if code == "REPORT_FORMAT_UNSUPPORTED":
        return "対応していないReport形式です: " + _helper_string(record.get("format", UNDEFINED))
    parent = record
    for key in parts[:-1]:
        parent = parent[int(key)] if type(parent) is list else parent.get(key)
    if type(parent) is dict and field not in parent:
        return "Reportの必須項目がありません: " + field
    value = parent.get(field, UNDEFINED) if type(parent) is dict else parent[int(field)] if type(parent) is list and field.isdigit() else parent
    if field == "entries":
        return "semantic diffのentriesは一覧でなければなりません。"
    if type(value) is not str or not value:
        return "Reportの文字列項目が不正です: " + field
    if field in {"baseRevision", "targetRevision", "graphRevision"}:
        return "ReportのGraphRevision IDが不正です: " + field
    if field.endswith("Digest") or field.endswith("Revision"):
        return "Reportのdigestが不正です: " + field
    if field in {"id", "focusId", "fromId", "toId", "replacementId"}:
        return "Reportのstable IDが不正です: " + field
    if field in {"evaluatedAt", "comparedAt"}:
        return "Reportの評価時刻が不正です: " + field
    return "Reportに未知の項目があります: " + field


class _SystemError(OSError):
    def __str__(self):
        return self.message


class _Reader:
    """Per-call reader; diagnostic context never requires a second file read."""

    async def io(self, method, path):
        try:
            result = await _records._package_api_io(method, path)
            # Awaiting a resolved source promise still suspends its continuation.
            # A very fast executor future can already be done in Python.
            await asyncio.sleep(0)
            return result
        except ValueError:
            if "\0" not in path:
                raise
            error = TypeError("The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received " + repr(path))
            error.name, error.code = "TypeError", "ERR_INVALID_ARG_VALUE"
            raise error from None
        except OSError as error:
            # Deliberately injected diagnostics already own their public fields.
            if hasattr(error, "name"):
                raise
            code = getattr(error, "code", None)
            if code is None:
                import errno
                code = errno.errorcode.get(error.errno)
            syscall = "scandir" if method == "readdir" else "read" if method == "readFile" and code == "EISDIR" else "open" if method == "readFile" else method
            descriptions = {"EISDIR": "illegal operation on a directory", "ENOENT": "no such file or directory", "ENOTDIR": "not a directory", "EACCES": "permission denied", "EPERM": "operation not permitted", "EIO": "i/o error", "EMFILE": "too many open files", "ENFILE": "file table overflow", "ELOOP": "too many symbolic links encountered", "ENAMETOOLONG": "name too long"}
            normalized = FileNotFoundError() if isinstance(error, FileNotFoundError) else _SystemError()
            normalized.name, normalized.code, normalized.path, normalized.syscall = "Error", code, path, syscall
            normalized.errno = -abs(error.errno) if error.errno is not None else None
            normalized.message = f"{code}: {descriptions.get(code, (error.strerror or '').lower())}, {syscall} '{path}'"
            if isinstance(normalized, _SystemError):
                normalized.args = (normalized.message,)
            raise normalized from None

    async def tree(self, directory):
        try:
            information = await self.io("lstat", directory)
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(information.st_mode):
            raise PackageError("PACKAGE_PATH_INVALID", directory, "Graph package の .morivyx は通常のディレクトリでなければなりません。")
        pending = [directory]
        while pending:
            current = pending.pop()
            for entry in sorted(await self.io("readdir", current), key=lambda e: e.name):
                path = os.path.join(current, entry.name)
                if entry.is_symlink() or not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                    raise PackageError("PACKAGE_PATH_INVALID", path, "Graph package には symbolic link や特殊ファイルを置けません。")
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)

    async def yaml(self, path):
        from yaml_authoring import (_file_parse_yaml, _file_check_profile,
                                    _file_profile_diagnostic, _FileYamlSyntaxError)
        try:
            source = await self.io("readFile", path)
        except FileNotFoundError:
            raise PackageError("PACKAGE_FILE_MISSING", path, "Graph package の必須ファイルがありません。") from None
        def profile(message, location=""):
            raise PackageError("PACKAGE_AUTHORING_PROFILE_INVALID", path + ("#" + location if location else ""), message)
        if source.startswith(b"\xef\xbb\xbf"):
            profile("YAML に BOM を付けられません。")
        try:
            text = source.decode("utf-8", errors="strict")
        except UnicodeError:
            profile("YAML が正しい UTF-8 ではありません。")
        if "\r" in text:
            profile("YAML の改行は LF だけを使います。")
        if "\t" in text:
            profile("YAML にタブを使えません。")
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text):
            profile("YAML に生の制御文字を使えません。二重引用符内のエスケープで表します。")
        if not text.endswith("\n") or re.search(r"\n *\n$", text):
            profile("YAML の末尾改行は一件だけにします。")
        if re.search(r"^(?:%.*|---(?:[ \t]|$)|\.\.\.(?:[ \t]|$))", text, re.M):
            profile("YAML の指示行と文書境界表記を使えません。")
        try:
            return _file_check_profile(_file_parse_yaml(text))
        except ValidationError as error:
            message = "Schema が許可しない位置に null があります。" if error.code == "PACKAGE_NULL_INVALID" else str(error)
            raise PackageError(error.code, path + ("#" + error.path if error.path else ""), message) from None
        except (ValueError, TypeError) as error:
            location, syntax = _file_profile_diagnostic(text)
            location = getattr(error, "_yaml_profile_path", location)
            if not syntax and location is not None and not isinstance(error, _FileYamlSyntaxError):
                if re.search(r"^\s*#", text, re.M):
                    profile("YAML にコメントを保存できません。", location)
                if "flow" in str(error):
                    profile("YAML の flow style を使えません。", location)
                profile("YAML の文字列値は二重引用符で囲みます。", location)
            message = "記録の根は対応表でなければなりません。" if text.strip() in {"[]", "null", "true", "false"} else str(error)
            raise PackageError("PACKAGE_YAML_INVALID", path, message) from None

    def validate(self, validator, record, path, *arguments):
        try:
            return validator(record, *arguments)
        except ValidationError as error:
            raise PackageError(error.code, path + ("#" + error.path if error.path else ""), _record_message(error, record)) from None

    async def group(self, directory, validator=None, kind=None, report=False):
        try:
            entries = await self.io("readdir", directory)
        except FileNotFoundError:
            return []
        records = []
        paths = sorted(os.path.join(directory, e.name) for e in entries if e.is_file(follow_symlinks=False) and e.name.endswith(".yaml"))
        for path in paths:
            record = await self.yaml(path)
            if report:
                from report_records import _report_validate
                prepared = self.validate(_report_validate, record, path, "")
                if "id" not in record:
                    raise PackageError("REPORT_ID_REQUIRED", path + "#/id", "保存済みReportにはstable IDが必要です。")
                records.append((path, {"valid": True, "type": prepared["type"], "digest": digest(prepared["type"], record)["digest"], "report": record}))
                continue
            self.validate(validator, record, path)
            if os.path.basename(path) != record["id"][9:] + ".yaml":
                raise PackageError("PACKAGE_FILENAME_ID_MISMATCH", path, "ファイル名と記録内の stable ID が一致しません。")
            if kind is not None and record["kind"] != kind:
                raise PackageError("GRAPH_ELEMENT_KIND_MISMATCH", path, "配置先と GraphElement の kind が一致しません: " + _helper_string(record["kind"]))
            records.append((path, record))
        return records

    async def read(self, path):
        directory = os.path.abspath(path)
        if os.path.basename(directory) != ".morivyx":
            directory = os.path.join(directory, ".morivyx")
        await self.tree(directory)
        lock_path, revision_path = (os.path.join(directory, name) for name in ("schema.lock.yaml", "revision.yaml"))
        lock, revision = await self.yaml(lock_path), await self.yaml(revision_path)
        self.validate(validate_schema_lock, lock, lock_path)
        self.validate(validate_graph_revision, revision, revision_path)
        entities = await self.group(os.path.join(directory, "graph/entities"), validate_graph_element, "entity")
        relations = await self.group(os.path.join(directory, "graph/relations"), validate_graph_element, "relation")
        approvals = await self.group(os.path.join(directory, "approvals"), validate_approval)
        changes = await self.group(os.path.join(directory, "ledger"), validate_change_set)
        migrations = await self.group(os.path.join(directory, "migrations"), validate_migration)
        reports = await self.group(os.path.join(directory, "reports"), report=True)
        seen = {}
        for file_path, record in entities + relations + approvals + changes + migrations + [(p, r["report"]) for p, r in reports]:
            if record["id"] in seen:
                raise PackageError("ID_DUPLICATE", file_path, "同じ stable ID が複数のファイルにあります: " + seen[record["id"]])
            seen[record["id"]] = file_path
        try:
            validate_approval_ledger([record for _, record in approvals])
        except ValidationError as error:
            match = re.match(r"/approvals/(\d+)(.*)$", error.path)
            location = approvals[int(match[1])][0] + "#" + match[2] if match else error.path
            approval = approvals[int(match[1])][1] if match else None
            revoked = next((r for _, r in approvals if r["id"] == approval.get("revokes")), None) if approval else None
            message = "撤回対象のapprovalがledger内にありません。" if revoked is None else "revoke記録を別のrevoke記録で撤回できません。" if revoked["operation"] == "revoke" else "撤回記録の対象IDとRevisionは撤回対象approvalに一致させます。"
            raise PackageError(error.code, location, message) from None
        by_id = {record["id"]: record for _, record in changes}
        for file_path, migration in migrations:
            self.validate(validate_migration_change_set, migration, file_path, by_id.get(migration["changeSetId"]))
        for file_path, element in entities + relations:
            if digest("revision", element)["digest"] != element["revision"]:
                raise PackageError("REVISION_ID_MISMATCH", file_path, "記録した Revision ID が canonical form の再計算値と一致しません。")
        elements = sorted((r for _, r in entities + relations), key=lambda r: r["id"])
        schema_digest, root_digest = digest("schema-lock", lock)["digest"], digest("root", elements)["digest"]
        for code, field, calculated, message in [
            ("SCHEMA_LOCK_DIGEST_MISMATCH", "schemaLockDigest", schema_digest, "記録した Schema 固定情報の digest が再計算値と一致しません。"),
            ("ROOT_DIGEST_MISMATCH", "rootDigest", root_digest, "記録した Graph の根の digest が再計算値と一致しません。"),
        ]:
            if revision[field] != calculated:
                raise PackageError(code, revision_path, message)
        return {"directory": directory, "schemaLock": lock, "revision": revision, "elements": elements,
                "approvals": [r for _, r in approvals], "changeSets": [r for _, r in changes],
                "migrations": [r for _, r in migrations], "reports": [r for _, r in reports],
                "calculatedSchemaLockDigest": schema_digest, "calculatedRootDigest": root_digest}


async def _registry(directory, lock, reader):
    schemas, issues = {}, []
    try:
        entries = await reader.io("readdir", os.path.join(directory, "schemas"))
    except FileNotFoundError:
        entries = []
    filenames = {schema_key(e["schemaId"], e["version"]) + ".yaml" for e in lock["schemas"]}
    for name in sorted(e.name for e in entries if e.is_file(follow_symlinks=False) and e.name.endswith(".yaml") and e.name not in filenames):
        issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", "/schemas/" + name.replace("~", "~0")))
    for locked in lock["schemas"]:
        key = schema_key(locked["schemaId"], locked["version"])
        path = "/schemas/" + key
        if not SCHEMA_ID.fullmatch(locked["schemaId"]) or not VERSION.fullmatch(locked["version"]):
            issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", path))
            continue
        try:
            definition = await reader.yaml(os.path.join(directory, "schemas", key + ".yaml"))
        except Exception as error:
            issues.append(registry_issue("SCHEMA_LOCK_MISSING" if getattr(error, "code", None) == "PACKAGE_FILE_MISSING" else "SCHEMA_LOCK_CONFLICT", path))
            continue
        try:
            validate_schema_definition(definition)
        except ValidationError:
            issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", path))
            continue
        if definition["schemaId"] != locked["schemaId"] or definition["version"] != locked["version"] or digest("schema", definition)["digest"] != locked["digest"]:
            issues.append(registry_issue("SCHEMA_LOCK_CONFLICT", path))
            continue
        schemas[key] = definition
    return {"schemas": schemas, "issues": issues}


def _package_records(base):
    return [*(record for key in ("elements", "approvals", "changeSets", "migrations") for record in base[key]),
            *(entry.get("report", entry) for entry in base["reports"])]


async def _prepare(owned):
    reader = _Reader()
    base = await reader.read(owned["basePath"])
    registry = await _registry(base["directory"], base["schemaLock"], reader)
    validation = {"schema_lock_digest": base["calculatedSchemaLockDigest"], "schemas": list(registry["schemas"].values()),
                  "registry_issues": registry["issues"], "approvals": base["approvals"]}
    if not validate_graph(**validation, graph_revision=base["revision"]["id"], elements=base["elements"])["valid"]:
        _fail("BASE_INVALID", "/basePath", "比較元のGraphが固定Schemaの検査に失敗しました。")
    change = owned.get("changeSet", UNDEFINED)
    candidates = owned.get("candidateElements")
    candidates = [] if candidates is None else candidates
    change_id = change.get("id", UNDEFINED) if type(change) is dict else UNDEFINED
    records = _package_records(base)
    existing = next((record for record in records if record["id"] == change_id), None)
    if existing is not None and (not any(existing is record for record in base["changeSets"]) or digest("changeset", existing)["digest"] != digest("changeset", change)["digest"]):
        _fail("ID_CONFLICT", "/changeSet/id", "提案のIDが既存記録と競合しています。")
    non_elements = {record["id"] for record in records if not any(record is element for element in base["elements"])}
    candidate_ids = [element.get("id", UNDEFINED) if type(element) is dict else UNDEFINED for element in candidates] if type(candidates) is list else []
    if any((type(identity) is str and identity in non_elements) or identity is change_id or (type(identity) is str and type(change_id) is str and identity == change_id) for identity in candidate_ids):
        _fail("ID_CONFLICT", "/candidateElements", "候補要素のIDが保存記録と競合しています。")
    apply_input = {"changeSet": change, "candidateElements": candidates, "resultingRevision": owned.get("resultingRevision"),
                   "currentRevision": base["revision"], "schemaLockDigest": base["calculatedSchemaLockDigest"], "currentElements": base["elements"],
                   "knownChangeSetIds": [r["id"] for r in base["changeSets"]],
                   "appliedChangeSetIds": [r["id"] for r in base["changeSets"] if all(r[a] == base["revision"][b] for a, b in (("baseRevision", "parentRevision"), ("resultingRevision", "id"), ("resultingRootDigest", "rootDigest"), ("schemaLockDigest", "schemaLockDigest")))]}
    try:
        applied = apply_change_set(apply_input)
    except ValidationError as error:
        raise PackageError(error.code, error.path, _apply_message(error, apply_input)) from None
    if not validate_graph(**validation, graph_revision=applied["revision"]["id"], elements=applied["elements"], previous_elements=base["elements"])["valid"]:
        _fail("TARGET_INVALID", "/candidateElements", "提案のGraphが固定Schemaまたは承認条件の検査に失敗しました。")
    try:
        report = create_semantic_diff({"baseRevision": base["revision"]["id"], "targetRevision": applied["revision"]["id"],
                                       "schemaLockDigest": base["calculatedSchemaLockDigest"], "evaluatedAt": owned.get("evaluatedAt"),
                                       "baseElements": base["elements"], "targetElements": applied["elements"]})
    except ValidationError as error:
        message = "semantic diffの評価時刻が不正です。" if error.path == "/evaluatedAt" else str(error)
        raise PackageError(error.code, error.path, message) from None
    current = {e["id"]: e for e in base["elements"]}
    by_revision = {(e["id"], e["revision"]): e for e in candidates}
    comparison = []
    for index, operation in enumerate(change["operations"]):
        before = None if operation["op"] == "revoke" else current.get(operation["targetId"])
        after_id = operation["replacementId"] if operation["op"] == "replace" else operation["targetId"]
        after = by_revision.get((after_id, operation["afterRevision"])) if operation.get("afterRevision") else None
        if operation["op"] != "revoke":
            current.pop(operation["targetId"], None)
            if after is not None:
                current[after["id"]] = after
        comparison.append({"index": index, "operation": operation, "before": before, "after": after})
    return deepcopy({"valid": True, "baseRevision": base["revision"]["id"], "baseRootDigest": base["calculatedRootDigest"],
                     "schemaLockDigest": base["calculatedSchemaLockDigest"], "changeSetId": change["id"], "changeSetDigest": digest("changeset", change)["digest"],
                     "resultingRevision": applied["revision"], "changeSet": change, "comparison": comparison, "semanticDiff": report,
                     "semanticDiffDigest": digest("semantic-diff", report)["digest"], "authorization": "not-assessed", "persisted": False})


async def _reject(error):
    raise error


def _schedule(coroutine):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return coroutine
    # Start through the first suspended read, as the original async API does.
    # With no running loop, callers can pass the coroutine to asyncio.run().
    return asyncio.Task(coroutine, loop=loop, eager_start=True)


def prepare_proposal_review(value=UNDEFINED):
    """Own JSON input now and return an awaitable for a read-only comparison.

    Example: ``result = await prepare_proposal_review(request)``.
    Invalid input is reported when awaiting, without evaluating host getters.
    The input accepts basePath, changeSet, candidateElements, resultingRevision
    and evaluatedAt. Omitted/null candidates mean an empty list.
    """
    try:
        try:
            owned = _own(value)
        except (ValueError, TypeError, OverflowError, RecursionError):
            _fail("INPUT_INVALID", "/", "提案は複製できるJSONの値にします。")
        if type(owned) is not dict or not owned.keys() <= _FIELDS or type(owned.get("basePath")) is not str or not owned["basePath"]:
            _fail("INPUT_INVALID", "/", "比較元と提案の入力が必要です。")
    except PackageError as error:
        return _schedule(_reject(error))
    return _schedule(_prepare(owned))
