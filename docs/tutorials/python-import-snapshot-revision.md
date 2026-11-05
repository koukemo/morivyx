---
type: Tutorial
title: Pythonだけで再取込結果を改訂して保存する
description: 以前の取込履歴を持つ資料へ新しい取得結果を反映し、元の正本を保持して新しい保存先へ確定する。
---

# Pythonだけで再取込結果を改訂して保存する

既に取り込んだ資料を新しい結果へ更新する場合は、`write_reimported_snapshot_package`を使います。
以前の取込履歴と資料が一致することを検証し、元の正本を保持したまま、新しい正本を別の保存先へ作ります。
Pythonの標準機能だけで利用でき、Python `3.14`と`3.15`で確認しています。

| 入口 | 内容 |
|---|---|
| `validate_import_snapshot_revision_request` | 改訂要求と取得済み結果を検証する |
| `prepare_import_snapshot_revision` | 比較結果、資料の候補、変更一覧と適用後の版を準備する。保存はしない |
| `write_reimported_snapshot_package` | 呼出時に要求を複写し、新しい正本へ保存する |

## ローカルファイルの再取込を試す

公開ソースのルートで次の例を実行します。
合成した以前の取込履歴を持つ正本を用意し、自分で作ったファイルの取得結果で資料を改訂します。
実際の外部通信、認証と鍵操作は使いません。
例の時刻は試験用で、一時フォルダーは終了時に削除します。

```sh
python3.14 -B - <<'PY'
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile

core = Path.cwd() / "packages/portable-core"
sys.path.insert(0, str(core))
from import_snapshot_revision import (
    prepare_import_snapshot_revision,
    validate_import_snapshot_revision_request,
    write_reimported_snapshot_package,
)
from ledger_store import read_ledger_package
from repository_import import import_repository_file
from schema_validation import ValidationError

vectors = json.loads((core / "fixtures/import-snapshot-revision-vectors.json").read_text())
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    base_path, source = root / "base", root / "source"
    for name, text in vectors["baseSets"]["repository"].items():
        path = base_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    source.mkdir()
    (source / "source.txt").write_bytes(b"owned updated local content\n")
    before = {str(path.relative_to(base_path)): path.read_bytes()
              for path in base_path.rglob("*") if path.is_file()}
    request = copy.deepcopy(vectors["requests"]["repository"])
    request["runRequest"]["input"]["repositoryRoot"] = str(source)
    request["runResult"] = import_repository_file(
        request["runRequest"], now=lambda: "2026-09-10T01:00:00Z")
    assert request["runResult"]["status"] == "success"
    validate_import_snapshot_revision_request(request)
    base = read_ledger_package(str(base_path))
    prepared = prepare_import_snapshot_revision(base, request)
    saved = asyncio.run(write_reimported_snapshot_package({
        "basePath": str(base_path), "outputPath": str(root / "reimported"),
        "request": request,
    }))
    updated = read_ledger_package(saved["outputPath"])
    assert before == {str(path.relative_to(base_path)): path.read_bytes()
                      for path in base_path.rglob("*") if path.is_file()}
    assert updated["elements"][0]["revision"] != base["elements"][0]["revision"]
    assert updated["changeSets"][-1]["provenance"]["previousImportSnapshot"]
    print(saved["valid"], len(updated["elements"]), prepared["comparison"]["status"], "base unchanged")
    conflicting = copy.deepcopy(request)
    conflicting["baselineArtifactRevision"] = "sha256:" + "0" * 64
    try:
        prepare_import_snapshot_revision(base, conflicting)
    except ValidationError as error:
        print(error.code)
PY
```

出力は`True 1 stale base unchanged`と`IMPORT_REVISION_LOCAL_CONFLICT`です。
資料の識別子は同じままで、本文の検査値、取得日時、由来と版が更新されます。
ファイル本文は保存せず、資料は下書きと未確認の状態になります。
今回と以前の取込記録が変更一覧に残り、実行と本人の結付けは未検証として保持されます。

## 自分の正本へ接続する

`basePath`へ既存のプロジェクトか、その中の`.morivyx`を指定します。
`outputPath`は元の正本の外にある、存在しないプロジェクトのルートにします。
`baseRevision`と`baseRootDigest`には、読込結果の`revision.id`と`revision.rootDigest`を指定します。
`artifactId`は既存の資料の識別子、`baselineArtifactRevision`はその資料の現在の`revision`です。
資料と同じ対象を取得した宣言、要求と成功結果を、`manifest`、`runRequest`と`runResult`へ渡します。

変更一覧と実行者の識別子には、資料と互いに異なる小文字のUUID版4を使います。
`resultingRevision`には元と異なる`graph:`形式の版を指定します。
新しい`runId`を使い、`recordedAt`を取得日時と以前の記録日時以降にします。
以前の存在と取得可否の観測がある場合は、その観測日時より古い取得も拒否します。
GitHub、FigmaとOpenAPIの取得済み結果も、同じ入口へ接続できます。
FigmaとOpenAPIの古い文書や要求は復元せず、保存済み結果のメタデータを検証します。

## 診断と検証範囲

| 診断 | 確認すること |
|---|---|
| `IMPORT_REVISION_BASE_MISMATCH` | 元の正本を読み直し、版と根の検査値を合わせる |
| `IMPORT_REVISION_LOCAL_CONFLICT` | 資料の版が基準と異なる。ローカル変更を確認する |
| `IMPORT_REVISION_BASELINE_UNRECORDED` | 対象と版を作成又は改訂した取込履歴が一件だけ存在するか確認する |
| `IMPORT_REVISION_BASELINE_INVALID` | 以前の履歴と資料に残る取込記録及び由来を確認する |
| `IMPORT_REVISION_TIME_REGRESSION` | 記録済みの観測より古い取得又は記録を使っていないか確認する |
| `IMPORT_REVISION_UNCHANGED` | 新旧が同じため、改訂は不要 |
| `IMPORT_REVISION_RUN_ALREADY_RECORDED` | 同じ実行を再記録しない |
| `PACKAGE_OUTPUT_EXISTS` | 既存の保存先を保持し、別の新しい保存先を使う |

独自の属性と拡張を保持し、候補と変更一覧には独立した取込記録の複写を作ります。
保存時は一時領域で書込と同期を行い、再読取した検査値とSchema及びGraphの制約を確認してから確定します。
失敗時は操作が作った領域だけを片付けます。
停電からの復旧、悪意ある同時差替え、本人性と採用権限の保証は含みません。
公開44本番モジュールだけでも、成功と拒否及び保存前後の状態を含む固定575例を再現します。
追加48結果では、空の履歴記録、空の取込情報、欠落した操作名と空の操作を区別し、元の実装と拒否条件を照合します。

```sh
python3.14 -B -m unittest discover -s packages/portable-core -p test_import_snapshot_revision.py
python3.15 -B -m unittest discover -s packages/portable-core -p test_import_snapshot_revision.py
node tools/run-node26.mjs node --test tools/python-import-snapshot-revision-conformance.test.mjs
```

最後の相互照合にはNode.js `26.13.0`以上を使います。
利用例とPythonの単体検査にはNode.jsとGitを使いません。

![以前の取込履歴と資料を照合し、再検証後に新しい正本へ保存する流れ](../diagrams/python-import-snapshot-revision.png)

[図の生成元](../diagrams/python-import-snapshot-revision.mmd)

[初回取込](python-import-snapshot-creation.md)、[ローカル取込](python-repository-import.md)と[手順の入口](README.md)へ戻れます。
