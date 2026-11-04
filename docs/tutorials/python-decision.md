---
type: Tutorial
title: Pythonだけで判断を作成して更新する
description: 候補を準備し、変更の適用と検証を経て、元を保持した新しい保存先へ復旧する。
---

# Pythonだけで判断を作成して更新する

Python `3.14`または`3.15`と標準機能だけで試せます。
Node.js、Gitの起動、通信と追加部品の導入は不要です。
ファイルの読取と復旧にはPOSIXの操作が必要で、この手順はmacOSで確認しています。
以下はリポジトリ直下で実行します。

## 候補の準備と保存を分ける

`decision_preparation.py`は、確認済みの正本の論理値と要求から、候補要素、変更記録と結果の版を返します。
作成は`prepare_decision_creation`、更新は`prepare_decision_revision`を呼び出します。
入力は変更せず、関数の呼出しだけではファイルを保存しません。

作成した判断は`draft`で、確認状態は`unreviewed`です。
更新できる状態は`draft`と`active`で、確認状態を`unreviewed`へ戻します。
本人認証、署名と採用権限の確認は行いません。
準備の成功だけで属性や関係の制約を満たすとは判断せず、適用後の正本を別途検証します。

![確認済みの正本から作成と更新を準備し、変更を適用して検証し、新しい保存先へ復旧する流れ](../diagrams/python-decision-preparation.png)

[図の生成元](../diagrams/python-decision-preparation.mmd)

## 同梱した例から作成と更新を試す

次の例は、同梱した検査用の正本を使います。
新しい一時フォルダーに、作成後の`create`と更新後の`revise`を別々に保存します。
元の正本と既存の保存先は上書きしません。

```sh
work=$(mktemp -d)
python3 -B - "$work" <<'PY'
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path("packages/portable-core").resolve()))
from changeset_apply import apply_change_set
from decision_preparation import prepare_decision_creation, prepare_decision_revision
from package_records import read_package, read_package_files, write_package_files
from package_restore import restore_package_files
from package_validation import validate_package_files

destination = Path(sys.argv[1]).resolve()
fixtures = Path("packages/portable-core/fixtures")
base = json.loads((fixtures / "portable-cli-vectors.json").read_text())
files = next(case["input"] for case in base["cases"] if case["name"] == "package-read")
requests = json.loads((fixtures / "decision-preparation-vectors.json").read_text())["cases"]
for case in requests:
    operation, request = case["operation"], case["request"]
    envelope = {"operation": operation, "packageFiles": files, "request": request}
    (destination / (operation + "-request.json")).write_text(json.dumps(envelope, ensure_ascii=False))
    contents = read_package_files(files)
    prepare = prepare_decision_creation if operation == "create" else prepare_decision_revision
    plan = prepare(contents, request)
    applied = apply_change_set({
        "changeSet": plan["changeSet"], "currentRevision": contents["revision"],
        "schemaLockDigest": contents["calculatedSchemaLockDigest"],
        "currentElements": contents["elements"], "candidateElements": [plan["candidateElement"]],
        "resultingRevision": plan["resultingRevision"],
    })
    contents.update(elements=applied["elements"], revision=applied["revision"])
    contents["changeSets"].append(plan["changeSet"])
    previous = files
    files = write_package_files(contents)
    report = validate_package_files(files, previous_files=previous)
    if report["issues"]:
        raise SystemExit(json.dumps(report, ensure_ascii=False))
    target = destination / operation
    target.mkdir()
    receipt = restore_package_files(files, target / ".morivyx")
    reread = read_package(target / ".morivyx")
    decision = next(element for element in reread["elements"] if element["id"] == request["decisionId"])
    print(json.dumps({"operation": operation, "savedTo": str(target), "restored": receipt["restored"],
                      "revision": reread["revision"]["id"], "question": decision["attributes"]["question"]}, ensure_ascii=False))
PY
```

2行のJSONが出力され、どちらも`restored: true`になります。
`create`の版は`graph:decision-create`、`revise`の版は`graph:decision-revise`です。
更新後の質問は「判断の保存方法を再検討するか？」になります。
判断の識別子は同じで、更新前後の検査値と変更記録は別になります。

復旧済みの保存先へもう一度復旧すると、既存データを置き換えずに失敗します。
試し直すときは`mktemp -d`からやり直します。

## 自分の要求へ置き換える

同梱した例の識別子を実データで繰り返し使わず、作成時は新しいUUIDを用意します。
更新時は既存の判断の識別子を指定し、変更記録と結果の版には新しい値を使います。

| 項目 | 指定する値 |
|---|---|
| `format` | 作成は`morivyx.decision-creation-request/0.1`、更新は`morivyx.decision-revision-request/0.1` |
| `decisionId` | 判断の識別子。`urn:uuid:`にUUIDを続ける |
| `attributes` | `question`、`rationale`、`consequences`など、適用するSchemaに従う属性 |
| `changeSetId` | 他の記録と重複しない、新しい変更記録の識別子 |
| `resultingRevision` | 現在と異なる結果の版。例は`graph:decision-create` |
| `actor` | 要求に記録する主体の識別子。指定だけで本人認証を済ませたとは扱わない |
| `recordedAt` | 日付、時刻と時差を含む文字列。例は`2026-11-04T09:00:00+09:00` |

既存の正本を使う場合は、`read_package("/path/to/project/.morivyx")`で読みます。
標準入力用の対応表が必要な場合は、その読取結果を`write_package_files`へ渡します。
出力時には既存規則に従って文字と時刻を正規化します。

## 標準入力から候補だけを得る

上の例が保存した要求を使い、ファイルを更新せずに候補だけを計算できます。

```sh
python3 -B packages/portable-core/decision_preparation.py < "$work/create-request.json" > "$work/create-plan.json"
python3 -B packages/portable-core/decision_preparation.py < "$work/revise-request.json" > "$work/revise-plan.json"
```

入力は`operation`、`packageFiles`、`request`の三項目、出力は`candidateElement`、`changeSet`、`resultingRevision`の三項目です。
標準入力と標準出力はそれぞれ8,388,608バイトが上限で、出力の末尾改行も含みます。
失敗時は終了コード`1`、空の標準出力と、標準エラーの固定コード`DECISION_PREPARATION_INPUT_INVALID`を返します。
既存の16操作の入口とは別で、単独の関数にはこの入出力の上限を適用しません。

## 確認した範囲

固定した作成と更新の期待結果は、既存の公開Node.js APIから採取したものです。
追加の照合では受理8例、拒否63例の結果と診断を比較します。
両段階の適用、出力、実ファイルの復旧と両実装による再読取も確認します。
Node.jsとGitを利用できない別領域では、中核のPythonファイルだけで候補を計算します。
これらは全機能の独立適合、本人認証や長期経過の実証を示すものではありません。

[Pythonだけの読取手順](python-only.md)、[正本の出力と復旧](backup-restore.md)と[利用手順の入口](README.md)も参照できます。
