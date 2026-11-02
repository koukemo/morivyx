---
type: Project Overview
title: Morivyx 中核SDK
description: Node.jsとPythonの中核実装、Core仕様と適合検査を含むソース配布。
---

# Morivyx 中核SDK

人間の目標、意図、判断、知識、成果と観測の関係を、意味と由来を保って記録するための中核SDKです。
Node.jsのKernel、Pythonの独立した中核、Coreの仕様と適合検査を含みます。
版は`0.1.0`です。

## 使い始める

[判断を保存して差分を確認するチュートリアル](docs/tutorials/getting-started.md)で、サンプルの準備から、別の保存先への判断の追加、差分とNode.js及びPythonでの読取まで試せます。
[自分のNode.jsアプリへ導入する手順](docs/tutorials/installed-node.md)で、配布アーカイブからの導入、公開APIとCLIの利用、固定した依存の再導入まで試せます。
Node.jsを導入せずに試す場合は、[Python単独の手順](docs/tutorials/python-only.md)を使えます。
使い方を探す場合は、[利用手順の入口](docs/tutorials/README.md)から選べます。

## 含める機能

- ファイルで保存した正本の読取、検証、検査値と由来の照合。
- 関係の追跡、差分の比較、明示した変更と移行の計算。
- Node.jsの保存APIと、Pythonによる出力及び明示した新規領域への復旧。
- 読取専用の取込とプラグイン境界、既存の補助関数。

PythonはCoreを対象とする選択済みの27モジュールであり、Node.jsのすべての機能を同じ方法で実装したものではありません。
本人認証済みの採用操作、鍵運用、実モデル、外部実行、連合と実機の試作、専用閲覧サイトは含めません。
既存SDKの読取専用の提案比較と承認照合を、実験用の採用経路の製品化と読み替えません。

## 導入と検査

Node.jsは`26.13.0`以上を使用します。
[最低版のセキュリティ上の根拠](docs/node-runtime.md)を保存しています。
開発用の選択版は`.nvmrc`と`.node-version`で`26.13.0`へ揃えています。
`nvm`を使う場合は、リポジトリ直下で`nvm install`と`nvm use`を実行します。
依存ライブラリの導入では、`.npmrc`の`engine-strict=true`により26.13.0未満を拒否します。
Pythonは`3.14`と`3.15`で検査します。
依存ライブラリの導入と一部の検査には`npm`と`Git`を使用します。

```sh
npm ci --prefix packages/kernel --ignore-scripts --no-audit --no-fund
npm test --prefix packages/kernel
node packages/kernel/src/cli.js --help
python3 -m unittest discover -s packages/portable-core -p 'test_*.py'
python3 tools/check-portable-vectors.py
```

Pythonの中核自体は標準機能だけを使い、Node.js、Gitと通信を呼び出しません。
Node.jsの配布物を作る場合は、次を使います。

```sh
npm pack ./packages/kernel --ignore-scripts
```

配布定義の`private`は、npmへの意図しない登録を防ぐため維持しています。
GitHubからのソース配布、ローカルでの導入と梱包は可能です。

## 仕様と表示

- [仕様の入口](docs/README.md)
- [Pythonの範囲](packages/portable-core/README.md)
- [文字の正規化とUnicodeの版](docs/unicode-normalization.md)
- [YAMLの文字とエスケープ](docs/yaml-source-characters.md)
- [ライセンス本文](LICENSE)と[権利表示](NOTICE)
- [外部依存の表示](THIRD_PARTY_NOTICES.md)
- [初版の同梱ファイルの由来と検査値](SOURCE-MANIFEST.json)

由来の一覧はタグ`v0.1.0`を作った時点の配布記録です。
その後の文書更新と実装例を含む現在の全ファイル一覧ではありません。
現在の`main`のNode.js最低要件は26.13.0で、既存のタグ`v0.1.0`の要件は変更していません。

同梱した独自コード、文書、図、Schemaと検証用データは`Apache-2.0`です。
外部由来の内容は元の条件を維持します。
仕様中の同梱対象外の資料と開発時の非公開リンクは、対象外と注記してリンクを外しています。
中核の仕様本文と実装の意味を変更するための処理ではありません。
開発時のGit履歴、閲覧一式、実測の生データは含めません。
保守責任者は`koukemo`です。
