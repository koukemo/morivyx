---
type: Schema Definition
title: Core Schema morivyx.core 0.2
description: Decision に決めたことを記録する属性と利用方法を示す。
---

# Core Schema `morivyx.core` 0.2

## 決めたことの記録

Decision の `attributes.statement` に、決めた方針や行動を文章で記録します。複数行の本文を使えます。本文を省略した下書きも保存できます。指定する場合は空白以外の文字を含めます。

作成要求と更新要求の `attributes` に同じ項目を使います。更新要求では属性全体を指定するため、引き継ぐ問い、選択理由、影響も含めます。

```yaml
format: "morivyx.decision-creation-request/0.1"
decisionId: "urn:uuid:00000000-0000-4000-8000-000000100001"
attributes:
  consequences:
    - "端末の紛失に備えて書き出し手順が必要になる。"
  question: "操作履歴をどこに保存するか。"
  rationale: "通信できない場所でも履歴を参照できるようにする。"
  statement: "操作履歴を端末内に保存する。"
changeSetId: "urn:uuid:00000000-0000-4000-8000-000000100101"
resultingRevision: "graph:decision-statement-first"
actor: "urn:uuid:00000000-0000-4000-8000-000000100900"
recordedAt: "2026-11-26T05:30:00Z"
```

例を `request.yaml` として保存し、Core 0.2 の Schema を固定した package を入力に指定します。

```console
node packages/kernel/src/cli.js create-decision <base> request.yaml <output>
node packages/kernel/src/cli.js validate <output>
```

更新では、現在の Decision ID、未使用の ChangeSet ID、新しい Graph Revision ID を指定します。要求の `format` を `morivyx.decision-revision-request/0.1` にして `revise-decision` を使います。決定本文がある場合、Markdown では問いの次に「決めたこと」が表示されます。

Python の作成・更新でも、JSON 要求の `attributes.statement` に同じ本文を指定します。 [Python の作成・更新手順](../tutorials/python-decision.md#自分の正本から作成して更新する)

## Schema の固定と既存記録

| 項目 | 値 |
| --- | --- |
| Schema ID | `morivyx.core` |
| version | `0.2` |
| Schema 内容の digest | `sha256:bb8ef01105c1d0df373718f64e65e8cdddd62537599a26143073299f24748eaf` |
| 機械可読な定義 | [`morivyx.core@0.2.yaml`](morivyx.core@0.2.yaml) |

空の 0.2 package で試すには、新しい `base` ディレクトリの `.morivyx/schemas/` に [機械可読な定義](morivyx.core@0.2.yaml) を置き、次の2ファイルを `base/.morivyx/` に保存します。

`schema.lock.yaml`

```yaml
format: "morivyx.schema-lock/0.1"
stableIdScheme: "urn-uuid-v4"
digestAlgorithm: "sha256"
schemas:
  - schemaId: "morivyx.core"
    version: "0.2"
    digest: "sha256:bb8ef01105c1d0df373718f64e65e8cdddd62537599a26143073299f24748eaf"
```

`revision.yaml`

```yaml
format: "morivyx.graph-revision/0.1"
id: "graph:decision-statement-base"
parentRevision: null
rootDigest: "sha256:75f555e3c5c85eb8ecf75b94672e62887e5c435668693d43e637e36fbf1fcd97"
schemaLockDigest: "sha256:6ce79fbc2900c94eeed9459d0945064afb7e6f8cfb3ee40b438772f429933634"
```

既存の 0.1 の package は、その版の Schema 固定情報で引き続き読み書きできます。既存の記録に新しい欄を使う場合は、`migrate` で 0.2 の Schema を固定する別の package を用意します。移行計画で既存の Core 要素の `typeVersion` と revision、およびそれらに固定した参照の扱いを指定します。

[Core Schema 0.1](morivyx-core-0-1.md) · [Python の移行手順](../tutorials/python-migration.md)
