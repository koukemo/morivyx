---
type: Independent Implementation Guide
title: Pythonの中核実装
description: 標準機能だけを使う43モジュールと、検査と保存、配布物の照合、ローカル取込と外部文書の選択及び明示的な取得と子の起動及び応答の範囲を示す。
---

# Pythonの中核実装

[再取込結果を改訂して保存する手順](../../docs/tutorials/python-import-snapshot-revision.md)では、以前の取込履歴と資料を照合します。
ローカル変更、同じ実行の重複と時刻の逆転を拒否し、元の正本を保持して新しい保存先へ確定します。

[取込結果を新しい正本へ保存する手順](../../docs/tutorials/python-import-snapshot-creation.md)では、要求検証、候補の準備、取込保存と汎用の変更適用をPythonだけで実行します。
一時出力の再検証後に新しい保存先へ確定し、元の正本を保持します。

[GitHub取込と再取込評価の手順](../../docs/tutorials/python-github-import.md)では、取得済み応答の変換、許可を照合した順次取得とローカル変更の評価をPythonだけで実行します。
実認証とGraphへの採用は別に確認します。

[Figma取込と再取込比較の手順](../../docs/tutorials/python-figma-import.md)では、取得済み本文の変換、許可を照合した取得と標準入出力応答をPythonだけで実行します。
時間制限と後片付けを扱い、実認証と外部操作の許可は別に確認します。

[既存の台帳へ追記する手順](../../docs/tutorials/python-ledger-store.md)では、承認、変更一覧と移行記録をPythonだけで保存します。
同じ識別子の排他的な処理、上書きしない確定と保存後の照合を行い、本人性と採用権限は別に確認します。

[拡張機能の宣言を検査する手順](../../docs/tutorials/python-plugin-manifest.md)では、宣言構造と機能の取得をPythonだけで行います。
宣言の検査は、実際の権限の付与と拡張機能の起動から分けます。

[実行側の許可情報へ照合する手順](../../docs/tutorials/python-plugin-host-policy.md)では、要求する権限の包含と資源上限を静的に照合します。
実際の権限の付与と制限の強制は行いません。

[要求と結果を検査する手順](../../docs/tutorials/python-plugin-messages.md)では、メッセージの形式、宣言への一致と要求への対応を確認します。
形式が正しい失敗応答の受理を、処理の成功と取り違えません。

[実行情報を生成して子を起動する手順](../../docs/tutorials/python-plugin-runtime.md)では、信頼する実行物を明示し、時間と標準出力及び標準エラーの合計を制限します。
OSの権限の隔離と子孫の全面的な制御は行いません。

[配布物のバイト列を照合する手順](../../docs/tutorials/python-plugin-supply-chain.md)では、本体と付属物の取得済みの内容を独立した固定値へ照合します。
欠落と不一致を区別しますが、署名の有効性と配布元の真正性は検証しません。

[応答側を作る手順](../../docs/tutorials/python-plugin-stdio.md)では、要求を複写して検証と処理へ渡し、上限付きの結果又は固定した診断を返します。
PythonとNode.jsの両方の起動側から、同じ合成した応答側へ接続できます。

[ローカル取込と再取込判定の手順](../../docs/tutorials/python-repository-import.md)では、ファイルのバイト列を取得し、外部の変更とローカル変更の衝突を区別します。
実際の取込応答側を両方の起動側から呼べますが、ファイル差替えの競合とOSの隔離は実証しません。

[OpenAPI取込と再取込比較の手順](../../docs/tutorials/python-openapi-import.md)では、与えたJSON文書から操作を選び、全文の検査値と情報損失を返します。
欠落の主張も再計算しますが、参照先の取得と操作の実行は行いません。

[Graphの版を示す記録の検査](../../docs/tutorials/python-graph-revision.md)では、元ファイル位置を診断へ結び付け、固定2644例で結果を照合します。
記録の構造の検査であり、Graph全体の整合と認可は別に確認します。

最初に試す場合は、[Python単独の手順](../../docs/tutorials/python-only.md)を使えます。
[Node.jsとPythonの選び方](../../docs/tutorials/README.md#実行環境を選ぶ)で、既存データの読取、サンプルの準備と新しい保存先への書込に必要な環境を比較できます。
Node.jsで保存した正本をPythonで確認する例は、[判断の保存と差分の手順](../../docs/tutorials/getting-started.md)にあります。
[Pythonだけで判断を作成して更新する手順](../../docs/tutorials/python-decision.md)では、候補の準備、適用と検証を分け、新しい保存先へ復旧します。
[Pythonだけで判断をMarkdownへ出力する手順](../../docs/tutorials/python-decision-markdown.md)では、元を保持して人が読む本文と検査値を生成します。
[Pythonだけで正本を移行する手順](../../docs/tutorials/python-migration.md)では、元の実ファイルと明示した要求を照合し、新しい保存先へ復旧します。

`package_records.read_package_file_sources(directory)`は、検査済みの相対パスとUTF-8本文の対応表を返します。
`read_package`と同じ安全な読取と記録構造の検証を使い、YAMLの表記と報告の別名を保持します。
従来の`write_package_files(read_package(directory))`は論理値を再出力するため、本文の表記と報告名を正規化する別の操作です。
実SchemaとGraph制約の検査には`validate_package_files(files)`、移行には`plan_package_migration`も明示して使います。
本人性の確認と同時変更の全面的な排除を、この読取関数の成功から判断しません。

Coreの読取、記録と検査値、Graphの検証と索引、関係の追跡、差分と明示した変更の計算、出力と新規領域への復旧を行います。
正本一式は明示した新しい保存先へ復旧し、既存の台帳への記録の追加には`ledger_store.py`の三つの関数を明示して使います。
明示した変更一覧の適用と新しい正本への保存には、`package_apply.write_applied_package`も使えます。
拡張機能の配布物の取得、本人認証と署名付き採用は、この一式の対象ではありません。
信頼する実行物を明示した子の起動は扱いますが、OSの権限の隔離と実通信の実証は行いません。

標準機能だけを使い、Node.jsとGitの起動及び外部部品の導入を必要としません。
Figmaの実取得を明示した場合は通信を行い、契約、認証と対象の許可を別に確認します。
起動する実行物の必要条件は別に確認します。
文字の正規化には、同じフォルダーの`unicode_nfc.py`に同梱したUnicode 16.0.0の表を使います。
別の場所へ持ち運ぶ場合も、必要な共通モジュールを含めてフォルダーごとコピーします。
詳しくは[文字の正規化とUnicodeの版](../../docs/unicode-normalization.md)を参照してください。
YAMLは[明示した文字列項目名と長い項目名](../../docs/yaml-explicit-keys.md)も読み書きします。
`?`と`:`の位置を確認し、長い項目名は必要な場合だけ明示表記で書き出します。
[一行の項目名の長さ](../../docs/yaml-key-length.md)は、引用符、エスケープと区切り空白を含めた1024 Unicode符号位置以内に制限します。
Node.jsのすべての機能と入力範囲への完全な適合を認定する説明ではありません。
[配列の区切り空白と入れ子](../../docs/yaml-sequence-spacing.md)は実際の幅で扱い、引用符内の空白と検査値を保持します。
[次の行へ分けた値](../../docs/yaml-separated-values.md)は単独の値と集合を区別し、引用文字列の継続行も親を基準に読みます。

リポジトリ直下で次を実行します。

```sh
python3 -m unittest discover -s packages/portable-core -p 'test_*.py'
python3 tools/check-portable-vectors.py
```

固定例の検査は24例と16操作を対象とし、入力と期待結果は`fixtures/portable-cli-vectors.json`です。
履歴と移行、追跡及び新規領域への復旧も、個別の単体検査で確認します。
試作の提案確認、採用と証拠保存の4モジュールは同梱しません。

[仕様の入口](../../docs/README.md)と[外部依存の表示](../../THIRD_PARTY_NOTICES.md)を参照してください。
