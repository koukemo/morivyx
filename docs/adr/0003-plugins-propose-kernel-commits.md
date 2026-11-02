---
type: Architecture Decision Record
title: "ADR-0003: Plugins Propose, Kernel Commits"
description: Plugin が変更を提案し Kernel が検証して確定する決定。
status: Accepted
date: 2026-07-23
scope: Plugin writes and external effects
---

# ADR-0003: Plugin が提案し Kernel が採択する

## 文脈

Importer、Generator、agent、Executor が Core Graph を直接変更できると、Plugin ごとに Schema、権限、処理単位、Provenance の解釈が分岐します。確率的な AI 出力や部分失敗が正規データへ混入する危険もあります。

## 決定

Plugin は Core Graph を直接変更しません。

1. Plugin は固定された入力 Graph Revision と Capability の許可を受け取る
2. Proposal、Observation、Artifact の記述、外部 Receipt を一時領域へ返す
3. Kernel が Schema、Invariant、Traceability、Policy、approval を検証する
4. 検証済み操作を一つの原子的な ChangeSet として採択する

外部作用は、Graph への採択と同じ処理単位で一回だけ実行されると仮定しません。ActionIntent、idempotency、Receipt、Observation、reconciliation により状態を追跡します。

## 検討した選択肢

### storage への直接接続

却下理由：Plugin が storage 実装と権限を迂回し、移植性と監査性を失う。

### 同一処理内で信頼する Plugin

却下理由：障害、依存関係、供給経路の危険が Kernel と同じ障害範囲になる。

### 別処理の Proposal に基づく Plugin

採用理由：言語非依存、最小権限、原子的な検証、AI 提案の人間による review を両立できる。

## 結果

### 利点

- Plugin の異常終了で Graph を部分更新しない
- 人間、AI、規則、Importer の変更を同じ review 手順で扱える
- Plugin ごとの最小権限を強制できる
- 採択される Graph Revision の Invariant を Kernel が一元管理できる

### 負担

- 一時領域、ChangeSet、approval、Run の Provenance が必要
- 大量取込には逐次処理と分割処理の設計が必要
- 外部作用では reconciliation と補償処理が必要

## 検証

- 不正な Plugin 出力が Graph Revision を作らない
- 時間切れまたは異常終了後に同じ idempotency のキーで安全に再試行できる
- Plugin 削除後も過去の Graph と provenance を読める
- 読み取り範囲と外部通信の組み合わせを Policy が拒否できる

## 再検討条件

- Proposal の一時領域が必要な処理量を満たさない
- 一つの ChangeSet が扱える規模を恒常的に超える
- 物理作用に追加の独立した安全用 Kernel が必要になる
