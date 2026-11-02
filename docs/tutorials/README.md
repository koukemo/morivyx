---
type: Tutorial Index
title: Morivyxを使い始める
description: 判断の保存、差分の確認とPython単独の利用へ進む入口。
---

# Morivyxを使い始める

| 試したいこと | 手順 | 得られる結果 |
|---|---|---|
| 判断と理由を保存する | [最初の判断を保存して差分を確認する](getting-started.md) | 元を保持したまま判断を加え、差分を確認する |
| 判断の理由を改訂する | [判断を改訂して履歴を比較する](revise-decision.md) | 同じ識別子の新しい版を保存し、改訂前後と変更記録を確認する |
| Node.jsのAPIを使う | [実装例](../../examples/getting-started/read.mjs)と[実行手順](getting-started.md#5-差分と理由を確認する) | 保存した要素と理由をJavaScriptの値として読む |
| Node.jsを導入せずに試す | [Pythonだけで中核の操作を試す](python-only.md) | YAMLの読取と固定例の検証を行う |

Morivyxは現時点では、アプリケーションへ組み込む中核SDKとCLIのソース配布です。
専用の操作画面、実モデル連携、本人認証を済ませた承認操作は含みません。
手順は現在の`main`向けで、初版のタグ`v0.1.0`には後から追加した文書と実装例を含めません。

[プロジェクトの入口](../../README.md)と[仕様の入口](../README.md)へ戻れます。
