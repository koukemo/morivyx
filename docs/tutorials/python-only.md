---
type: Tutorial
title: Pythonだけで中核の操作を試す
description: 標準入力のJSONからYAMLを読み、標準機能だけで固定例を検証する。
---

# Pythonだけで中核の操作を試す

Pythonの中核実装は標準機能だけを使います。
別の場所へ移す場合は、`unicode_nfc.py`などの共通モジュールも含め、`packages/portable-core`をフォルダーごとコピーします。
Node.jsや`npm`を導入せずに試す場合は、ソース取得後にこの手順を使います。
検査済みのPythonは`3.14`と`3.15`です。
以下のコマンドは、リポジトリ直下のシェルで実行します。

## YAMLの文字列を読む

CLIは操作名を引数に取り、JSONを標準入力で受け取ります。
次はYAML文字列の読取であり、ファイル名を渡す操作ではありません。

```sh
printf '%s\n' '"question: \"保存形式を何にするか？\"\nanswer: \"YAML\"\n"' | python3 packages/portable-core/portable_cli.py read-yaml
```

結果は次のJSONです。

```json
{"question":"保存形式を何にするか？","answer":"YAML"}
```

この操作は構文を読み取ります。
Graph packageの検証や判断の保存は行いません。
Pythonの対応範囲では、文字列の値を二重引用符で囲み、末尾に改行を置きます。
一般的なYAML処理系のすべての構文を受け入れるものではありません。

## 固定例と単体検査を実行する

```sh
python3 tools/check-portable-vectors.py
python3 -m unittest discover -s packages/portable-core -p 'test_*.py'
```

固定例は`valid: true`、`cases: 24`、`operations: 16`、`matched: 24`を確認します。
単体検査は、最後の集計で試験数が0件でなく、`OK`と終了コード`0`になることを確認します。
件数は版によって変わります。
前者は固定した入力と期待結果、後者は個別の実装動作を調べます。
これだけで、任意のYAMLへの対応やNode.js版との完全な適合を認定するものではありません。

## 保存済みのデータを読む

Graph packageを受け取った場合は、その中の`.morivyx`を明示します。
下の`/path/to/package`は実際に受け取ったパッケージの親フォルダーへ置き換えます。

```sh
python3 packages/portable-core/package_records.py /path/to/package/.morivyx
python3 packages/portable-core/package_validation.py /path/to/package/.morivyx
```

最初の操作は記録と検査値を読み、2つ目はSchemaとGraphの制約も検証します。
出力の`validation`で、成功した範囲と検証しない範囲を確認してください。
ファイルの安全な読取にはPOSIXの操作が必要で、この手順はmacOSで確認しています。
入力や既存ファイルを上書きする操作ではありません。

実データを作るところから試す場合は、Node.jsを使う[判断の保存と差分の手順](getting-started.md)へ進めます。
Pythonだけで試す場合は、[判断を作成して更新する手順](python-decision.md)で同梱例から候補を準備し、新しい保存先へ復旧できます。
[判断をMarkdownへ出力する手順](python-decision-markdown.md)では、人が読む本文と検査値もPythonだけで生成できます。
[正本を新しいSchemaへ移行する手順](python-migration.md)では、自分の正本と要求を検証して新しい先へ保存できます。
正本を持ち運ぶ場合は、[JSONへの出力と新しい保存先への復元](backup-restore.md)へ進めます。
[実行環境の比較](README.md#実行環境を選ぶ)で、Pythonだけの操作とNode.jsを使う準備や保存の手順を確認できます。
[Pythonの対象範囲](../../packages/portable-core/README.md)と[利用手順の入口](README.md)も参照できます。
