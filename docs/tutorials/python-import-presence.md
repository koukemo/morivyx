---
type: Tutorial
title: Pythonだけで資料を保持して取得成功の観測を保存する
description: 取得できた事実を観測と関係に残し、資料本文と現在の版を保持した新しい正本を作る。
---

# Pythonだけで資料を保持して取得成功の観測を保存する

`write_import_presence_package`は、取得済みの成功結果から観測と関係を新しい正本へ保存します。
資料の識別子、本文と現在の版を保持し、外部結果の変化と資料のローカル状態を観測に記録します。
Pythonの標準機能だけで利用でき、Python `3.14`と`3.15`で確認しています。

| 入口 | 内容 |
|---|---|
| `validate_import_presence_request` | 要求、成功結果、宣言と日時の対応を検証する |
| `prepare_import_presence` | 以前の基準を照合し、観測、関係と変更一覧を準備する。保存はしない |
| `write_import_presence_package` | 呼出時に要求を複写し、再検証後に新しい正本へ保存する |

## ローカル変更のある資料を観測する

公開ソースのルートで次の例を実行します。
合成した取込履歴とローカル変更を持つ正本を用意し、自分で作ったファイルを読み取って、資料を保持したまま観測を追加します。
外部通信、認証と鍵操作は使いません。
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
from import_presence import (
    prepare_import_presence,
    validate_import_presence_request,
    write_import_presence_package,
)
from ledger_store import read_ledger_package
from repository_import import import_repository_file
from schema_validation import ValidationError

vectors = json.loads((core / "fixtures/import-presence-vectors.json").read_text())
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    base_path, source = root / "base", root / "source"
    for name, text in vectors["baseSets"]["repository-local"].items():
        path = base_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    source.mkdir()
    (source / "source.txt").write_bytes(b"owned locally observed file\n")
    before = {str(path.relative_to(base_path)): path.read_bytes()
              for path in base_path.rglob("*") if path.is_file()}
    request = copy.deepcopy(vectors["requests"]["repository-local"])
    request["runRequest"]["input"]["repositoryRoot"] = str(source)
    request["runResult"] = import_repository_file(
        request["runRequest"], now=lambda: "2026-09-10T01:00:00Z")
    assert request["runResult"]["status"] == "success"
    validate_import_presence_request(request)
    base = read_ledger_package(str(base_path))
    artifact = copy.deepcopy(base["elements"][0])
    prepared = prepare_import_presence(base, request)
    saved = asyncio.run(write_import_presence_package({
        "basePath": str(base_path), "outputPath": str(root / "observed"),
        "request": request,
    }))
    observed = read_ledger_package(saved["outputPath"])
    assert next(value for value in observed["elements"] if value["id"] == artifact["id"]) == artifact
    assert before == {str(path.relative_to(base_path)): path.read_bytes()
                      for path in base_path.rglob("*") if path.is_file()}
    record = prepared["candidateElements"][0]["extensions"]["morivyx.import/presence"]
    print(saved["valid"], len(observed["elements"]), saved["status"],
          saved["comparison"], record["localStatus"], "artifact unchanged")
    try:
        asyncio.run(write_import_presence_package({
            "basePath": str(base_path), "outputPath": saved["outputPath"],
            "request": request,
        }))
    except ValidationError as error:
        print(error.code)
PY
```

出力は`True 3 available stale changed artifact unchanged`と`PACKAGE_OUTPUT_EXISTS`です。
元の資料一件に観測と関係の二件を追加します。
外部の結果が変わったことを`stale`、資料にローカル変更があることを`changed`として残し、資料本文と版は維持します。
外部の結果が同じ場合も保存でき、その比較は`current`になります。
今回と以前の取込情報は観測と変更一覧に残り、実行と本人の結付けは未検証として保持されます。

## 自分の正本へ接続する

`basePath`へプロジェクトか、その中の`.morivyx`を指定します。
`outputPath`は元の正本の外にある、存在しないプロジェクトのルートにします。
`baseRevision`と`baseRootDigest`は、読込結果の`revision.id`と`revision.rootDigest`へ合わせます。
`artifactId`には既存の資料を指定し、`baselineArtifactRevision`には以前の取込履歴に記録された、その資料の版を指定します。
資料にローカル変更がある場合は、現在の版と基準の版を観測の中で区別します。
取込によって更新済みの古い基準は拒否するため、最後に取り込んだ版を使います。

観測、関係、変更一覧と実行者には、資料とも互いに異なる小文字のUUID版4の識別子を使います。
新しい`runId`と、元と異なる`graph:`形式の`resultingRevision`を指定します。
取得に使った宣言、要求と成功結果を、`manifest`、`runRequest`と`runResult`へ渡します。
GitHub、FigmaとOpenAPIの取得済み結果も同じ入口で扱えます。
FigmaとOpenAPIの古い文書や要求は復元せず、保存済み結果のメタデータを検証します。

`observedAt`は取得日時以降、`recordedAt`は観測日時以降にします。
新しい取得日時は、基準の取得日時と記録日時、以前の存在と取得可否の観測日時以降であることも必要です。
観測日時だけを新しくして、以前の観測より古い取得結果を渡すことはできません。

## 診断と検証範囲

| 診断 | 確認すること |
|---|---|
| `IMPORT_PRESENCE_REQUEST_INVALID` | 宣言、成功結果、識別子と日時の対応を確認する |
| `IMPORT_PRESENCE_BASE_MISMATCH` | 正本を読み直し、版と根の検査値を合わせる |
| `IMPORT_PRESENCE_BASELINE_UNRECORDED` | 基準の版を作成又は改訂した取込履歴が一件だけあるか確認する |
| `IMPORT_PRESENCE_BASELINE_INVALID` | 保存した以前の取込情報と宣言の対応を確認する |
| `IMPORT_PRESENCE_BASELINE_SUPERSEDED` | 古い取込基準を使っている。最後に取り込んだ版を使う |
| `IMPORT_PRESENCE_ID_EXISTS` | 観測、関係と変更一覧に新しい識別子を使う |
| `IMPORT_PRESENCE_RUN_ALREADY_RECORDED` | 同じ実行を再記録しない |
| `IMPORT_PRESENCE_TIME_REGRESSION` | 基準と以前の観測より古い取得又は記録を使っていないか確認する |
| `PACKAGE_OUTPUT_EXISTS` | 既存の出力を保持し、別の新しい保存先を使う |

保存は一時領域で書込と同期を行い、再読取した検査値とSchema及びGraphの検証後に確定します。
失敗時は操作が作った領域だけを除去します。
本人性、採用権限、電源断からの復旧と悪意ある同時差替えの全面的な排除は保証しません。
取得失敗の保存は別の処理です。
公開47本番モジュールだけでも、固定687例と保存前後の状態を再現します。
追加48結果では、不完全な資料の版、固定情報、Schemaと操作記録の診断も元の実装へ照合します。

```sh
python3.14 -B -m unittest discover -s packages/portable-core -p test_import_presence.py
python3.15 -B -m unittest discover -s packages/portable-core -p test_import_presence.py
node tools/run-node26.mjs node --test tools/python-import-presence-conformance.test.mjs
```

最後の相互照合にはNode.js `26.13.0`以上を使います。
利用例とPythonの単体検査にはNode.jsとGitを使いません。

![資料本文と版を保持し、観測と関係を新しい正本へ保存する流れ](../diagrams/python-import-presence.png)

[図の生成元](../diagrams/python-import-presence.mmd)

[取込結果を改訂する](python-import-snapshot-revision.md)、[初回取込](python-import-snapshot-creation.md)と[手順の入口](README.md)へ戻れます。
