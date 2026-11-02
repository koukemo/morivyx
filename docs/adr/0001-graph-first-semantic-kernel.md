---
type: Architecture Decision Record
title: "ADR-0001: Graph-first Semantic Kernel"
description: Morivyx の中核を型付けされた論理 Graph とする決定。
status: Accepted
date: 2026-07-23
scope: Core architecture
---

# ADR-0001: 論理 Graph と Semantic Kernel

## 文脈

Morivyx は、Goal、Intent、Decision、Knowledge、Plan、Execution、Artifact、Verification、Observation、Learning の意味を、ファイル形式、AI モデル、外部ツールを越えて長期維持する必要があります。

文書、コード、実行手順、Graph 専用データベースのいずれかを製品の中心にすると、その表現や実装の lifecycle が意味モデルを支配します。

## 決定

Morivyx の中核を、型付けされた Entity と Relation からなる論理 Graph とします。

- Graph は論理モデルであり、Graph 専用データベースの採用決定ではない
- Kernel は Entity、Relation、Revision、Provenance、ChangeSet、Invariant に限定する
- Goal などの意味型は、version を持つ Semantic Profile として登録する
- serialization、storage、Query 処理部、画面は交換可能な adapter と Projection にする
- Relation は ID、Revision、Provenance を持つ第一級の要素とする
- 型、`predicate`、Schema には名前空間と version を持たせる

## 検討した選択肢

### Artifact を正本とする案

Markdown、コード、図を正本にし、リンクを付加情報として追加する。

却下理由：複数表現をまたぐ同一性、判断、証拠、時間的な関係が表現形式へ埋没する。

### 実行順序を正本とする案

改善ループを固定した実行手順として実装する。

却下理由：実行順序が意味モデルを支配し、Domain ごとの異なる改善ループや手作業を扱いにくい。

### storage を正本とする案

Graph 専用データベースの Schema と Query 言語を中核仕様にする。

却下理由：物理実装の lifecycle と製品固有機能へ依存する。

### 論理 Graph と Semantic Kernel を正本とする案

意味を小さな論理 Graph と Profile で定義し、物理表現を分離する。

採用理由：長期的な交換可能性、traceability、複数 Domain への拡張を最も直接支える。

## 結果

### 利点

- storage、serialization、AI、画面を交換しやすい
- Relation の意味と provenance を検証できる
- 競合する Claim や複数の視点を保持できる
- Domain Profile を Core と独立して進化させられる

### 負担

- Kernel と Profile の境界設計が必要
- semantic diff、Migration、Invariant の検査機能が不可欠
- 単純な文書管理より初期コストが高い
- Graph を過剰に一般化する誘惑がある

## 制限

- Core 追加には Extension で不十分な理由を要求する
- Graph の要素数や Relation 数を成功指標にしない
- 特定の問い、Goal、対象範囲に不要な情報を取り込まない
- 外部成果物を無条件に Graph 内へ複製しない

## 検証

- 異なる3実例を同じ Kernel で表現できる
- storage adapter を変えても意味適合検査が通る
- 未知の Extension を lossless に round-trip できる
- 必須の Trace Query が物理 storage に依存しない

## 再検討条件

- Entity / Relation では重要な意味を自然に表現できない
- Profile 境界が同じ情報の大量重複を生む
- 複数の独立実装で同じ Graph の意味を再現できない
