---
type: Tutorial Index
title: Morivyxを使い始める
description: 判断の保存、Schemaの移行、正本の出力と復元及びPython単独の利用へ進む入口。
---

# Morivyxを使い始める

## 実行環境を選ぶ

既存の正本を読む場合は、Pythonだけでも始められます。
同梱した手順で判断を新しく保存したり、移行先を作ったりする場合は、Node.jsの統合した入口を使います。

| 行いたい操作 | この公開版で使う環境 |
|---|---|
| YAMLを読む、既存の正本を検証する | [Pythonだけで実行可能](python-only.md)。Node.jsのCLIからも読取と検証を実行できる |
| 既存の正本から索引を作って調べる | [Node.jsとPythonの両方の入口](graph-index.md)がある。手順の最初のサンプル作成にはNode.jsを使う |
| 判断を作成して保存する、改訂する、関係を加える | [Node.jsで判断を保存](getting-started.md)し、[改訂](revise-decision.md)と[関係の追加](trace-relations.md)へ進む。Pythonでの再読取は任意 |
| Schemaを変えて別の保存先へ移行する | [準備と移行先の保存はNode.js](schema-migration.md)の手順を使う。Pythonでは移行結果を再読取して照合する |
| 正本を出力する、受け取ったJSONを新しい先へ復旧する | [出力と復旧にはPythonだけ](backup-restore.md)を使える。手順のサンプルを最初から作る場合はNode.jsも使う |
| 自分のNode.jsアプリへ組み込む | [Node.jsとnpm](installed-node.md)を使う。Pythonの導入は不要 |

Node.jsの最低要件は`26.13.0`です。
Pythonは`3.14`と`3.15`で確認しています。
Pythonによる安全なファイルの読取と復旧にはPOSIXの操作が必要で、同梱の手順はmacOSで確認しています。
Pythonは変更一覧と移行の適用計算も扱いますが、ここで案内する判断や移行の保存手順と同一の統合CLIを提供するものではありません。

例では、Node.jsのCLIには正本を含むプロジェクトのフォルダーを渡します。
Pythonのファイル読取には、その中の`.morivyx`を明示します。
下の`/path/to/project`は、実際の保存先へ置き換えます。

```sh
node packages/kernel/src/cli.js inspect /path/to/project
python3 packages/portable-core/package_records.py /path/to/project/.morivyx
```

![既存の正本の読取と出力及び復旧はPythonだけでも開始でき、判断の保存と移行の統合手順にはNode.jsを使い、サンプル作成と照合の環境を分ける流れ](../diagrams/runtime-choice.png)

[図の生成元](../diagrams/runtime-choice.mmd)

## 目的から手順を選ぶ

| 試したいこと | 手順 | 得られる結果 |
|---|---|---|
| 自分の正本を検査する | [正本を検査して失敗の原因を切り分ける](validate-package.md) | 読取と検証の違い、終了コードと失敗箇所を確認する |
| Schemaを変えて移行する | [Schemaを変えて新しい正本へ移行する](schema-migration.md) | 候補と差分を確認し、元を保持して新しい正本を両実装で検証する |
| 種類と入出関係を調べる | [正本から索引を作って種類と関係を調べる](graph-index.md) | 両実装で索引を再生成し、検索結果と照合範囲を確認する |
| 判断と理由を保存する | [最初の判断を保存して差分を確認する](getting-started.md) | 元を保持したまま判断を加え、差分を確認する |
| 判断の理由を改訂する | [判断を改訂して履歴を比較する](revise-decision.md) | 同じ識別子の新しい版を保存し、改訂前後と変更記録を確認する |
| 資料から判断と根拠をたどる | [資料から判断と根拠をたどる](trace-relations.md) | 関係のある経路と不足する関係を確認する |
| 正本を別の保存先へ戻す | [正本をJSONへ出力して復元する](backup-restore.md) | 全体の検査値を照合し、元と既存の保存先を保持して復元する |
| 自分のNode.jsアプリへ組み込む | [別のNode.jsアプリへSDKを導入する](installed-node.md) | 配布アーカイブを導入し、公開APIとCLIで正本を読む |
| Node.jsを導入せずに試す | [Pythonだけで中核の操作を試す](python-only.md) | YAMLの読取と固定例の検証を行う |

Morivyxは現時点では、アプリケーションへ組み込む中核SDKとCLIのソース配布です。
専用の操作画面、実モデル連携、本人認証を済ませた承認操作は含みません。
手順は現在の`main`向けで、初版のタグ`v0.1.0`には後から追加した文書と実装例を含めません。

[プロジェクトの入口](../../README.md)と[仕様の入口](../README.md)へ戻れます。
