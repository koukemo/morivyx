---
type: Independent Implementation Guide
title: Pythonの中核実装
description: 標準機能だけを使う27モジュールと、検査及び保存の範囲を示す。
---

# Pythonの中核実装

最初に試す場合は、[Python単独の手順](../../docs/tutorials/python-only.md)を使えます。
Node.jsで保存した正本をPythonで確認する例は、[判断の保存と差分の手順](../../docs/tutorials/getting-started.md)にあります。

Coreの読取、記録と検査値、Graphの検証と索引、関係の追跡、差分と明示した変更の計算、出力と新規領域への復旧を行います。
既存の正本を暗黙に上書きせず、明示した新しい保存先への復旧を扱います。
プラグインのネットワーク取得、本人認証、署名付き採用と外部実行は、この一式の対象ではありません。

標準機能だけを使い、Node.jsとGitの起動、通信と外部部品の導入を必要としません。
文字の正規化には、同じフォルダーの`unicode_nfc.py`に同梱したUnicode 16.0.0の表を使います。
別の場所へ持ち運ぶ場合も、必要な共通モジュールを含めてフォルダーごとコピーします。
詳しくは[文字の正規化とUnicodeの版](../../docs/unicode-normalization.md)を参照してください。
YAMLは[明示した文字列項目名と長い項目名](../../docs/yaml-explicit-keys.md)も読み書きします。
`?`と`:`の位置を確認し、長い項目名は必要な場合だけ明示表記で書き出します。
[一行の項目名の長さ](../../docs/yaml-key-length.md)は、引用符、エスケープと区切り空白を含めた1024 Unicode符号位置以内に制限します。
Node.jsのすべての機能と入力範囲への完全な適合を認定する説明ではありません。
[配列の区切り空白と入れ子](../../docs/yaml-sequence-spacing.md)は実際の幅で扱い、引用符内の空白と検査値を保持します。

リポジトリ直下で次を実行します。

```sh
python3 -m unittest discover -s packages/portable-core -p 'test_*.py'
python3 tools/check-portable-vectors.py
```

固定例の検査は24例と16操作を対象とし、入力と期待結果は`fixtures/portable-cli-vectors.json`です。
履歴と移行、追跡及び新規領域への復旧も、個別の単体検査で確認します。
試作の提案確認、採用と証拠保存の4モジュールは同梱しません。

[仕様の入口](../../docs/README.md)と[外部依存の表示](../../THIRD_PARTY_NOTICES.md)を参照してください。
