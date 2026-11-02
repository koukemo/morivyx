---
type: Architecture Reference
title: Morivyx の中核概念
description: Morivyx が扱う主要概念と境界を定義する。
---

# Core の概念

## Morivyx が保存するもの

Morivyx は世界のすべての知識を保存しません。

> 特定の Goal、主体、対象範囲において、継続的な判断と改善に必要な主張、成果物への参照、根拠、関係を保存する。

Graph へ追加する情報は、少なくとも一つの明示的な問いに答えられる必要があります。「取り込めるから取り込む」こと、ノード数や Relation 数を価値とみなすことは避けます。

## 意味上の面

改善ループの概念を、混同してはいけない四つの面に分けます。

| Plane | 問い | 主な概念 |
|---|---|---|
| Normative | 何を望み、何を選び、何をする予定か | Goal, Intent, Decision, Plan |
| Actual | 実際に何を行い、何が生まれたか | Execution, Artifact |
| Evidential | 何を、どの方法で観測・評価したか | Verification, Observation |
| Epistemic | 何を知っていると主張し、理解がどう変わったか | Knowledge, Learning |

「計画した」「実行した」「観測した」「真だと判断した」は別の事実です。Morivyx は Relation によってこれらを接続しますが、一つの状態へ潰しません。

## 主要概念

### Goal

実現したい、観測可能な状態です。解決方法ではありません。受益者、対象範囲、成功条件、制約、時間軸を伴います。

### Intent

Goal を人間がどう解釈しているかを表します。動機、意味、優先順位、範囲、譲れない条件を保持します。同じ Goal に複数の Intent が併存できます。

### Decision

特定の文脈で問いを閉じ、選択肢を選んだ記録です。結論だけでなく、不採用案、根拠、反証、影響、再検討条件を保持します。

### Knowledge

評価または反証可能な主張です。文書そのものは Artifact であり、その文書から採用した主張が Knowledge です。事実、仮説、推論、規範を区別します。

### Plan

Goal へ向かう予定された行為、依存関係、順序、資源、停止条件です。実行済みであることを意味しません。

### Execution

Plan またはその一部を実際に実行した履歴です。実行主体、入力、開始・終了、結果、再試行、外部作用を保持します。実装は、Execution とそれが生む Artifact の組み合わせとして表現します。

### Artifact

コード、文書、設計データ、モデル、設定、データセット、物理物など、生成・輸入・変更された参照可能な成果です。

Morivyx が管理する View や Report は Graph から再生成可能にします。一方、外部 repository、Figma データ、実機などには固有の正本があり、Morivyx は URI、外部 ID、version、内容の digest、由来、意味的関係を管理します。

### Verification

対象を Criterion に照らして評価した行為と判定です。テスト定義そのものではなく、特定の対象・版・環境に対する評価実行を指します。

### Observation

特定の時点と文脈で観測された結果です。Observation は真理ではなく証拠であり、観測対象、方法、主体または装置、`observedAt` と `recordedAt` を持ちます。

### Learning

Observation や Verification から導かれた理解の変化または変更提案です。Learning は中核 Graph を直接書き換えず、新しい Knowledge、Goal、Decision、Plan への提案を開始します。

## 補助概念

| 概念 | 役割 |
|---|---|
| Actor | 人間、組織、AI、サービス、ツール、装置などの責任主体 |
| Context | 対象範囲、環境、時間、適用領域、信頼境界 |
| Criterion | Goal の達成または Verification の判定に使う評価基準 |
| Option | Decision で検討した選択肢。採用されなかったものも保持する |
| Constraint | Goal、Intent、Plan、Execution に対する制約 |
| ExternalSource | 外部システム、文書、データ、イベントの同一性と取得点 |
| ChangeSet | Graph に対する原子的で検証可能な変更提案 |

これらをすべて Kernel の組み込み型にはしません。Kernel は Entity、Relation、Revision、Provenance、ChangeSet の構造だけを理解し、意味概念はバージョン付き Semantic Profile として登録します。

## 主張、根拠、真理

Morivyx の Graph は、単一の真理を強制する場所ではありません。誰が、いつ、何を、どの根拠で主張したかを保持する場所です。

- 競合する Knowledge と Observation は併存できる
- `confidence` は根拠の代わりにならない
- `imported`、`asserted`、`inferred`、`generated`、`observed`、`verified` を区別する
- AI の非公開な思考過程は必須データにしない
- 結論、参照した根拠、入力版、モデルまたは規則、検証結果を保存する
- 反証や撤回は削除ではなく、Relation と lifecycle で表現する

## 同一性と変更

- 論理 ID は不透明で、表示名、型、パス、ベンダー、製品名を埋め込まない
- 論理 ID と不変な Revision ID を分ける
- 表記修正は同一 Entity の新 Revision として扱える
- 意味、選択、適用範囲を変える変更は、新 Entity と `supersedes` で表す
- 採択済み Decision、Observation、Verification の履歴は破壊的に更新しない
- 個人情報保護や法的削除要求に対応するため、無条件の追記専用保存は採用しない

## Core への採用規則

新しい概念を共通 Core Profile へ追加するには、次をすべて満たす必要があります。

1. 複数の異なる適用領域で必要である。
2. 既存概念の属性、Relation、Domain Profile では意味を保てない。
3. 少なくとも一つの重要な Query または Invariant を可能にする。
4. lifecycle、provenance、migration の意味を定義できる。
5. Extension では不十分な理由を Decision として記録する。
