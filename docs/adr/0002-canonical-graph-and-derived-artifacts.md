---
type: Architecture Decision Record
title: "ADR-0002: Canonical Graph and Derived Artifacts"
description: 正規 Graph と派生成果物の所有関係を定める決定。
status: Accepted
date: 2026-07-23
scope: Data ownership and projections
---

# ADR-0002: 正規 Graph と派生 Artifact

## 文脈

創設原則には「すべての成果物は Graph から導出可能であること」があります。しかし、repository、Figma、外部文書、データ集合、三次元成果、実機まで Graph の内部表現へ複製すると、Morivyx が巨大で不完全な二次正本になります。

一方、生成 Report や manifest を手編集可能な別の正本にすると、Graph と表示が乖離します。

## 決定

成果物を二種類に分けます。

### managed Projection

View、Trace Report、Decision の Markdown、生成した Manifest など、Morivyx が管理する表現は承認済み Graph Revision から決定的に再生成できるようにします。

各 projection は次を記録します。

- 入力 Graph Revision
- 生成規則とひな形の digest
- Projector ID、version、package digest
- 設定の digest

### external Artifact または独立した正本

repository、Figma のデータ、外部文書、バイナリデータ、データ集合、機器などは、それぞれの正本を維持します。Morivyx は次を Graph で管理します。

- 論理同一性と外部同一性
- 変更されない version、取得時点の記録、内容の digest
- URI、媒体種別、保持区分
- provenance
- Goal、Decision、Execution、Verification との Relation

したがって「Graph から導出可能」とは、対象の全バイトではなく、その意味、入力、生成条件、判断、検証、由来を復元できることと定義します。

## 検討した選択肢

### すべてを Graph 内に置く案

却下理由：外部ツールの正本を複製し、規模、再現精度、権限、同期の問題を中核へ持ち込む。

### すべてを外部ファイルに置く案

却下理由：判断、来歴、関係、再生成条件が各形式に分散する。

### 正規 Graph と Artifact の正本を分離する案

採用理由：意味の正本と、バイト列または物理物の正本を混同せず、不一致を検出できる。

## 結果

### 利点

- 既存ツールとデータ所有権を尊重できる
- 大容量・物理 Artifact を扱える
- managed Projection の不一致を検出できる
- Graph を世界の不完全コピーにしない

### 負担

- external Artifact の参照に対する stale の検出が必要
- ExternalSource が消えた場合の保持 Policy が必要
- 再生成可能性のレベルを Artifact ごとに明示する必要がある

## 検証

- managed Projection が同じ入力から同一バイト列として再生成される
- external Artifact の変更を digest で検出できる
- Artifact の正本と Morivyx の責任範囲を人間が判別できる
- 外部 Artifact を取得できなくても、その判断と provenance が読める

## 再検討条件

- ExternalSource が安定した version または digest を提供しない
- projection の決定性が実務価値を損なう
- 個人情報保護または利用許諾により digest や付加情報の保持も許されない
