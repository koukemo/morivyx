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

## Pythonと実行環境

Pythonの中核は標準機能だけを使います。
Node.js、Python、npmとGitの実行環境自体は同梱しません。
閲覧サイトの依存ライブラリと、試作の暗号部品及び外部の仕様一式は、この配布物には含めません。
