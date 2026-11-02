---
type: Architecture Reference
title: Goal、Decision、Traceability
description: 目標、意思決定、追跡可能性のモデルを定義する。
---

# Goal、Decision、Traceability

## Goal の論理モデル

Goal は、解決策ではなく実現したい状態を表します。

### 必須の意味

| 項目または Relation | 意味 |
|---|---|
| `statement` | 実現したい結果 |
| `beneficiaries` | 価値を受ける人または対象 |
| `context` | 適用範囲、環境、前提 |
| `has_criterion` | 達成を評価する Criterion |
| `constrained_by` | 守るべき制約 |
| `priority` | 他 Goal との相対的優先度 |
| `horizon` | 時間軸。期限と同一とは限らない |
| `aggregationPolicy` | 子 Goal / Criterion の結果をどう集約するか |
| `owner` | lifecycle に責任を持つ Actor |

### lifecycle

```text
proposed → active → achieved
                  → abandoned
                  → superseded
```

- `refines` による Goal 階層は有向非循環とする
- 親 Goal の達成条件は、子 Goal の数から暗黙に推測しない
- `achieved` への移行は、必須 Criterion の Verification と Observation を根拠にする
- 人間判断による例外は、根拠と影響を持つ Decision として残す
- Goal の意味を変える場合は上書きせず、新しい Goal が旧 Goal を `supersedes` する
- 達成後に反証が得られても履歴を消さず、Decision によって再開または後継 Goal を作る

Goal の達成は「真偽」ではなく、特定の Graph Revision と根拠に対する評価です。

## Decision の論理モデル

Decision は第一級の Entity です。ADR は Decision の人間向け Projection の一つであり、Decision そのものを Markdown 形式に限定しません。

### 必須の意味

| 項目または Relation | 意味 |
|---|---|
| `question` | 閉じるべき問い |
| `context` | 判断が有効な範囲と前提 |
| `addresses` | 関連する Goal、Intent、Knowledge |
| `considers` | 検討した Option |
| `selects` | 採用した Option |
| `rationale` | 選択理由 |
| `supported_by` | 支持する根拠と、その固定 Revision |
| `challenged_by` | 既知の反証、不確実性、懸念 |
| `consequences` | 期待効果、負債、不可逆性 |
| `governs` | 影響を受ける Plan、Artifact など |
| `decider` | 判断責任を持つ Actor |
| `decidedAt` | 採択時刻 |
| `revisitTriggers` | 再検討を開始する条件 |

### lifecycle

```text
proposed → accepted → superseded
         ↘ rejected   ↘ revoked
```

### 規則

- accepted Decision は、既定では Option を一つだけ選択する
- 複数選択が必要な場合は `selectionMode` を明示する
- 不採用 Option と反証を削除しない
- 表記修正は Revision、選択・理由・範囲の変更は新しい Decision とする
- 新しい Decision が旧 Decision を `supersedes` する
- accepted Decision は根拠の Revision、判断者、時刻、影響範囲を固定する
- accepted Decision は一件以上の `supported_by` を持つ
- `challenged_by` が零件の場合は、反証を調査した Actor、範囲、時刻、結果を `challengeReview` に記録する
- Artifact を根拠にする場合は、Artifact Revision と根拠箇所の `locator` を固定する
- Decision の lifecycle と review/approval state を混同しない
- AI は Option、分析、提案を生成できるが、判断主体と approval は明示する

## Criterion と Learning の lifecycle

Criterion は `draft` から `active` へ進み、`deprecated`、`superseded`、`retracted` のいずれかへ移ります。意味変更は新しい Criterion と `supersedes` で表し、表記修正は同じ Criterion の Revision とします。

Learning は `draft` から `active` へ進み、`superseded` または `retracted` へ移ります。Learning が Goal、Decision、Plan を `triggers` しても、後続作業の完了を Learning の lifecycle へ反映しません。

## Traceability 規則

Traceability は、すべてを直接接続することではありません。意味のある型付き Trace が存在し、その Trace を人間と機械が説明できることです。

accepted 状態では次を要求します。

1. Intent は少なくとも一つの Goal を `interprets` する。
2. active Goal は少なくとも一つの Criterion を持つか、Criterion 不要の Decision を持つ。
3. accepted Decision は Goal、Intent、Knowledge のいずれかを `addresses` し、Option、選択、一件以上の固定 Revision を持つ根拠、反証または反証確認記録を持つ。
4. active Plan は Goal または Intent を `pursues` する。
5. Execution は Plan を `executes` する。予定外実行は例外理由と approval を持つ。
6. Artifact Revision は、一つの生成責任を持つ Execution または Verification からの `produces`、または ExternalSource、version、digest、取得時刻、取得 Actor を含む取込時の Provenance を持つ。
7. Verification は一件以上の対象 Revision を `evaluates` し、ちょうど一件の Criterion を `against` で参照する。
8. Observation は観測対象、方法、Actor または装置、`observedAt`、`recordedAt` を持つ。
9. Learning は Observation または Verification から導出され、影響対象か次の変更提案を明示する。
10. Goal の達成判断から、Criterion、Verification、Observation へ到達できる。
11. 派生 Artifact または Relation は、入力 Graph Revision、規則または Plugin の version、生成規則の digest を持つ。
12. Trace の欠落を意図的に許容する場合は、期限付きの免除 Decision を必要とする。

### 標準の Trace Query

MVP は、少なくとも次の問いに答えます。

| 問い | 代表的な Trace |
|---|---|
| この Artifact はなぜ存在するか | `Artifact ← produces ← Execution → Plan → Goal` |
| 現在の形を決めた Decision は何か | `Artifact ← governs ← Decision` |
| Decision の根拠と反証は何か | `Decision → supported_by / challenged_by` |
| Goal の達成を示す根拠は何か | `Goal → Criterion ← Verification → Observation` |
| どの Observation が変更を起こしたか | `Observation ← derived_from ← Learning → triggers` |

### Trace の品質

各 Trace は次の状態を持てます。

- `complete`: 必須 Trace と Provenance がそろっている
- `partial`: draft として許容される欠落がある
- `waived`: Decision によって期限付きで欠落を許容している
- `stale`: 指定した Graph Revision と検査時点で、外部 Artifact の digest または版が記録値と一致しない
- `broken`: 接続先がない参照、失効した Schema、矛盾する要素数がある

要素数やリンク数ではなく、完備した Trace、stale な参照、根拠のない達成判断、Goal へ到達できない Artifact の割合を品質指標とします。

`stale` は Artifact または Artifact reference の lifecycle ではありません。記録値、比較値、検査時刻、Verification、Observation から導出する Trace の状態です。

## 時間と Revision の意味

- `observedAt`: 現象を観測した時刻
- `recordedAt`: Morivyx に記録した時刻
- `validFrom` / `validTo`: 対象領域で主張が有効な期間
- `revision`: 内容が固定された版

accepted Decision、Verification、派生 Artifact は、根拠と入力を論理 ID だけでなく Revision まで固定します。編集画面や探索 query は「最新 Revision」を参照できますが、監査対象の結果は浮動参照にしません。

## approval の Provenance

approval は、Actor、対象の stable ID と Revision、許可した操作または状態遷移、適用範囲と条件、`approvedAt`、`recordedAt` を固定します。

review state を `approved` にするには、対象 Revision に適用できる approval が必要です。lifecycle を `accepted` にするには、Schema と Invariant の検証成功、および Policy が要求する approval が必要です。

approval の撤回は過去の記録を変更せず、新しい ProvenanceRecord として記録します。review、Pull Request の取り込み、沈黙は approval の代わりにしません。

## 免除と例外

完全な Trace を常に要求すると、初期入力や緊急対応を阻害します。そのため `draft` と期限付きの免除を認めます。

免除 Decision には次を必須とします。

- 欠落している規則
- 欠落を許容する理由
- 危険の責任者
- 有効期限または解消条件
- 影響する Goal / Artifact
- 必要な後続作業

免除は Trace を消す仕組みではなく、欠落自体を追跡可能にする仕組みです。
