---
type: Architecture Decision Record
title: Stage 0 で発見した Graph 制約
description: 参照 Graph で見つかった Relation、lifecycle、stale、approval の未決事項に対する決定を記録する。
status: Accepted
---

# ADR-0006: Stage 0 で発見した Graph 制約

## 文脈

3つの参照 Graph を手作業で表した結果、同じ Trace を異なる形で保存できる箇所と、状態または要素数の意味が決まっていない箇所が見つかりました。このまま Kernel と Schema を実装すると、保存する Relation、Query の結果、review state、lifecycle が実装ごとに変わります。

Core 型は追加せず、現在の Entity、Relation、Revision、Provenance で曖昧さを解消します。

## 決定

### 1. 明示 Relation と派生 Relation

正規 Graph には、Actor、規則、Plugin のいずれかが明示的に主張し、Provenance を持つ Relation だけを保存します。Relation をたどって導出できる関係は、正規 Graph へ重複保存せず、Projection または Report として生成します。

Decision が Artifact の現在の形を直接決める場合は、Decision からその Artifact Revision への `governs` を明示します。Decision が Plan だけを `governs` することから、Plan が生んだすべての Artifact への `governs` を暗黙に導出しません。

派生 Relation を一時保存する場合は、入力 Graph Revision、規則 ID、規則版、生成時刻を持たせ、正規 Relation と区別します。

### 2. Decision の根拠と反証

accepted Decision は、固定した Revision を参照する `supported_by` を一件以上持ちます。接続先は Knowledge、Observation、Artifact のいずれかです。

Artifact を根拠にする場合は、Artifact Revision と、根拠となる箇所を示す `locator` を固定します。Artifact 全体を曖昧に参照するだけでは、根拠の最小単位を満たしません。

`challenged_by` は零件以上とします。既知の反証がない場合は、調査した Actor、範囲、時刻、結果を `challengeReview` に記録します。Relation がないことだけから、反証を確認したと推定しません。

### 3. Verification と Criterion の要素数

一つの Verification は、`against` でちょうど一つの Criterion を参照し、`evaluates` で一件以上の対象 Revision を参照します。

複数の Criterion を同じ処理で検査した場合でも、Criterion ごとに Verification を分けます。一つの Criterion に対する複数対象の一つの判定は許可します。対象ごとの判定が必要な場合は Verification も分けます。

### 4. Artifact Revision と Execution

生成または改訂された一つの Artifact Revision は、`produces` によって一つの生成責任を持つ Execution または Verification へ到達できなければなりません。複数の実行が寄与した場合は、それらを入力または `depends_on` として生成責任を持つ Execution の Provenance に記録します。

`produces` は Artifact の stable ID だけでなく、生成した Revision を固定します。Artifact の改訂は同じ stable ID の新しい Revision とし、過去の Revision と `produces` を書き換えません。

外部から取得した Artifact は例外とし、Execution の代わりに ExternalSource、version、digest、取得時刻、取得 Actor を含む Provenance を必須とします。

### 5. Criterion と Learning の lifecycle

Criterion は次の遷移だけを許可します。

```text
draft → active
draft → retracted
active → deprecated
active → superseded
active → retracted
```

意味を変える場合は、新しい Criterion が旧 Criterion を `supersedes` します。表記修正だけは同じ Criterion の新しい Revision とします。

Learning は次の遷移だけを許可します。

```text
draft → active
draft → retracted
active → superseded
active → retracted
```

Learning が Goal、Decision、Plan を開始しても、完了状態へは移しません。後続作業の状態は、`triggers` の接続先で管理します。

### 6. stale の位置

`stale` は Artifact または Artifact reference の lifecycle ではなく、指定した Graph Revision と検査時点に対する Trace の派生状態とします。

`stale` の判定には、記録済みの version または digest、比較した外部対象の version または digest、検査時刻、Verification、Observation を必要とします。Artifact reference 自体は `active` のまま保持でき、`stale` の解消は新しい Revision または後継 Artifact reference で表します。

### 7. approval の Provenance

approval は、少なくとも次を固定する ProvenanceRecord とします。

- approval を行った Actor
- 対象の stable ID と Revision
- 許可した操作または状態遷移
- 適用範囲と条件
- `approvedAt` と `recordedAt`
- 有効期限または失効条件がある場合はその内容

review state を `approved` にする場合は、対象 Revision に適用できる approval を必要とします。lifecycle を `accepted` にする場合は、Schema と Invariant の検証成功、および Policy が要求する approval の両方を必要とします。

review、Pull Request の取り込み、沈黙は approval の代わりにしません。approval の撤回は過去の記録を変更せず、新しい ProvenanceRecord として記録します。

## Invariant

| 対象 | 条件 | 反例 |
|---|---|---|
| 正規 Relation | 明示的な主張と Provenance を持つ | Trace の到達可能性だけから Relation を追加する |
| `governs` | Artifact の現在の形を決めた Decision から対象 Revision へ直接接続する | Plan への接続をすべての生成 Artifact へ暗黙に広げる |
| accepted Decision | 一件以上の `supported_by` と、`challenged_by` または `challengeReview` を持つ | ADR のファイル全体だけを根拠とする |
| Verification | 一件の `against` と一件以上の `evaluates` を持つ | 複数 Criterion の結果を一つの判定へまとめる |
| Artifact Revision | 一つの生成責任を持つ Execution、Verification、取込 Provenance のいずれかを持つ | 複数 Execution が同じ Revision を独立して生成したと記録する |
| Criterion と Learning | 定義した lifecycle だけを使う | Learning を後続 Plan の完了と同時に完了状態へ移す |
| `stale` | 比較入力と検査時点から導出する | Artifact の lifecycle を `stale` にする |
| approval | Actor、対象 Revision、操作、範囲、時刻を固定する | review または取り込みから approval を推定する |

## 結果

### 利点

- 正規 Relation と派生 Relation の責任が分かれます。
- 同じ Graph Revision に対する Query の結果を再現できます。
- Decision の根拠、反証、approval を対象 Revision まで追跡できます。
- Verification の判定と Criterion の対応が一意になります。
- Artifact の改訂履歴を破壊せず、生成責任を一つにできます。
- `stale` と Artifact の lifecycle を混同しません。

### 負担

- Decision ごとに根拠の固定と反証確認の記録が必要です。
- 複数 Criterion の検査では Verification の数が増えます。
- 複数実行から一つの生成責任を持つ Execution または Verification を定める必要があります。
- approval を独立した ProvenanceRecord として保存する必要があります。

## 検証

- 3つの参照 Graph が、新しい Core 型なしで全 Invariant を満たすこと。
- 直接 Relation だけを保存しても、5つの標準 Query に回答できること。
- 複数 Criterion を一つの Verification に接続すると検査が失敗すること。
- 一つの Artifact Revision に複数の生成責任を持つ Execution を接続すると検査が失敗すること。
- digest の不一致が Artifact の lifecycle を変更せず、Trace を `stale` とすること。
- 対象 Revision または Actor のない approval を拒否すること。

## 再検討条件

- 一つの Criterion に対する複数対象の判定を一意に解釈できない場合。
- 一つの Artifact Revision に複数の生成責任者が必要な適用領域が見つかった場合。
- 派生 Relation を正規 Graph に保存しないと、必要な Query の再現性または処理費用を満たせない場合。
- approval の外部正本があり、ProvenanceRecord だけでは失効状態を追跡できない場合。
