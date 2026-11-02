---
type: Third Party Notices
title: 外部依存とライセンスの表示
description: 中核SDKの直接依存と、同梱した条件の範囲を示す。
---

# 外部依存とライセンスの表示

## Node.jsの直接依存

| 名前と版 | 用途 | ライセンス | 元の表示 |
|---|---|---|---|
| `yaml 2.9.1` | YAMLの読取と書出し | `ISC` | [全文](third_party/yaml/LICENSE) |

元の著作権表示と許諾文を保持します。
このライブラリのコードに、Morivyxの`Apache-2.0`を上書きしません。
ライブラリ本体は同梱せず、依存関係の固定情報に従って`npm ci`で取得します。

同梱した条件は、[公式配布物](https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz)を固定情報の`integrity`へ照合し、取り出した本文です。
[原作者の公開本文](https://github.com/eemeli/yaml/blob/v2.9.1/LICENSE)も参照できます。

## Unicodeの正規化データ

Unicode 16.0.0の文字データから、正規分解、結合クラスと合成に必要な表を抽出して同梱します。
公式の正規化試験から、区分と五つの入力列も検査用に保持します。
これらのデータはUnicode License V3に従い、Morivyxの独自実装へ適用する`Apache-2.0`と区別します。

著作権表示と利用条件の全文は、[Node.jsの実装](packages/kernel/src/unicode-nfc.js)と[Pythonの実装](packages/portable-core/unicode_nfc.py)へ含めています。
[公式の利用条件](https://www.unicode.org/license.txt)と、[元データの検査値及び再照合方法](docs/unicode-normalization.md)も参照できます。
実行時の通信と外部ライブラリの導入は不要です。

## Pythonと実行環境

Pythonの中核は標準機能だけを使います。
Node.js、Python、npmとGitの実行環境自体は同梱しません。
閲覧サイトの依存ライブラリと、試作の暗号部品及び外部の仕様一式は、この配布物には含めません。
