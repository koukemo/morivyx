---
type: Independent Implementation Guide
title: Pythonの中核実装
description: 標準機能だけを使う26モジュールと、検査及び保存の範囲を示す。
---

# Pythonの中核実装

最初に試す場合は、[Python単独の手順](../../docs/tutorials/python-only.md)を使えます。
Node.jsで保存した正本をPythonで確認する例は、[判断の保存と差分の手順](../../docs/tutorials/getting-started.md)にあります。

Coreの読取、記録と検査値、Graphの検証と索引、関係の追跡、差分と明示した変更の計算、出力と新規領域への復旧を行います。
既存の正本を暗黙に上書きせず、明示した新しい保存先への復旧を扱います。
プラグインのネットワーク取得、本人認証、署名付き採用と外部実行は、この一式の対象ではありません。

標準機能だけを使い、Node.jsとGitの起動、通信と外部部品の導入を必要としません。
Node.jsのすべての機能と入力範囲への完全な適合を認定する説明ではありません。

リポジトリ直下で次を実行します。

```sh
python3 -m unittest discover -s packages/portable-core -p 'test_*.py'
python3 tools/check-portable-vectors.py
```

固定例の検査は24例と16操作を対象とし、入力と期待結果は`fixtures/portable-cli-vectors.json`です。
履歴と移行、追跡及び新規領域への復旧も、個別の単体検査で確認します。
試作の提案確認、採用と証拠保存の4モジュールは同梱しません。

[仕様の入口](../../docs/README.md)と[外部依存の表示](../../THIRD_PARTY_NOTICES.md)を参照してください。
