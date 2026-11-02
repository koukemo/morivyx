---
type: Project Scope
title: MVP の範囲
description: Morivyx の初期実装に含める範囲と含めない範囲を定義する。
---

# MVP の範囲

## MVP で検証する仮説

最初に検証する仮説は一つです。

> 小さく、人間がレビュー可能な意味 Graph によって、Goal、Decision、Plan、Execution、Artifact、Verification、Observation の関係を、ツールや AI モデルを越えて維持できる。

MVP の目的は、改善ループの完全自動化ではありません。意味、判断理由、外部成果物、証拠の trace を、実務で維持できるコストで保存できるかを検証することです。

## Stage 0: 実装前

コードを書く前に、次を満たします。

- 3つの性質が異なる実例を手作業でモデル化する
- 標準の Trace Query が実際の問いとして有用か確認する
- Core 型を増やさず表現できる範囲と反例を記録する
- Entity と Relation の方向、要素数、lifecycle の曖昧さを洗い出す
- Git diff を第三者が読み、意味変更を説明できるか確認する
- YAML の round-trip と正規化の検査値を設計する

実例で価値を示せない場合、Kernel 実装へ進みません。

## 対象

### Workspace

- 単一 repository、単一 workspace
- ローカルを優先し、オフラインで検証、Trace、Report の生成が可能
- Git を review と履歴の転送手段として利用
- 一つの厳格な YAML authoring profile

### Semantic Kernel

- stable ID と変更されない Revision ID
- Entity、Relation、GraphRevision、ChangeSet、Provenance
- Schema の version と固定情報
- 未知の名前空間付き Extension の lossless round-trip
- 参照、型、要素数、循環、Traceability の検証
- 文字列差分を補助する semantic diff

### 最初の垂直実例で使う用語

専用の実行手順を実装する型は、最初の Trace に必要な範囲へ限定します。

- Goal
- Decision
- Plan
- Execution
- Artifact reference
- Verification
- Observation

Intent は Goal と Decision の Context と、必要に応じた試験用 Entity で検証します。Knowledge は根拠となる Claim または ExternalSource の参照として扱い、Learning は Observation から新しい Goal、Decision、ChangeSet が生じる Trace として検証します。

Stage 0 の実例で独立した lifecycle と query が必要だと確認できた概念だけを、安定 Core Profile へ昇格します。Core Meta Model に列挙した概念は設計語彙であり、すべてを MVP のサブシステムにするという意味ではありません。

### 操作

概念的には次の操作だけを対象にします。

```text
init
add / revise / supersede
relate
validate
diff
trace
report
```

### Plugin の境界

- manifest と Capability の最小仕様
- 既定拒否の読み取り範囲
- ChangeSet の Proposal
- Run provenance
- 一つの読み取り専用 repository Importer

Importer の目的は大量取り込みではなく、外部同一性、digest、再取り込み差分、Provenance の契約を検証することです。

### 決定的な Projection

- 標準の Trace Report
- Decision の Markdown Projection
- 同じ Graph Revision と生成規則から同一バイト列として再生成

## 参照用の垂直実例

Morivyx 自身の設計変更を題材に、次の一周を記録します。

1. Goal: 長期に意味を保持できる設計基盤を定義する
2. Decision: 論理 Graph と Semantic Kernel を採用する
3. Plan: 初期設計成果物を作成し、レビューする
4. Execution: 文書を作成・更新する
5. Artifact: この repository の設計文書
6. Verification: リンク、構造、必須 Trace、Decision の整合性を検査する
7. Observation: 検査結果とレビューフィードバックを記録する
8. Learning: 語彙または規則の変更を ChangeSet として提案する

この垂直実例を AI なしでも完了でき、AI を追加してもデータモデルを変更しないことを確認します。

## 必須 Query

- この Artifact はどの Goal のために存在するか
- どの Decision によって現在の形になったか
- Decision は何を根拠とし、どの反証を認識していたか
- Goal の達成を示す Verification / Observation は何か
- どの Observation が Goal または Decision の変更を起こしたか

## 明示的な対象外

- 自律 agent の実行調整と無承認 Graph 更新
- コード生成、ソースコード完全意味解析、汎用推論
- ベクトルデータベースや AI 記憶基盤
- 即時共同編集、サービス型ソフトウェア、クラウド同期
- 組織横断 Graph、細粒度の組織用権限管理
- 遠隔 Plugin 登録簿または配布市場
- GitHub、Jira、Notion、Figma、統合開発環境の置き換え
- Graph 専用データベースの採用を前提とした Query 最適化
- 分散 Execution と継続的な遠隔測定値の保存
- 拡張現実、接続機器、ロボティクスの実機制御
- デジタルツインと物理世界の完全モデル
- 因果関係、真偽、Goal 達成の自動保証
- すべての Domain に共通する統一語彙

## MVP の終了条件

- 3つの実例を Core 型追加なしで表現できる
- 5つの必須 Query が、人間が確認した正解と一致する
- 複製後、通信と AI なしで検証と Report の生成を実行できる
- 同じ入力から同一バイト列の canonical form と Projection を生成できる
- Schema 違反、重複 ID、接続先がない Relation、禁止する循環を検出できる
- 未知の Extension を round-trip しても情報を失わない
- Git diff だけで、第三者が主要な意味変更を説明できる
- stale external Artifact reference を digest で検出できる
- Plugin を削除しても Core のデータと過去の Provenance を読める
- 一つの Decision を記録・更新する維持コストが実務上許容できる

## 成功指標

測定するもの：

- Goal へ到達できない Artifact の割合
- Verification または Observation の根拠がない達成済み Goal の割合
- stale external reference の割合
- `superseded` の Decision を現行として参照する Trace の割合
- 一つの意味変更に必要な手作業時間
- 意味検証と Migration の成功率
- 人間が Proposal を承認、修正、却下した割合
- Core 型の増加速度

成功指標にしないもの：

- ノード数
- Relation 数
- 取り込みデータ量
- AI 実行回数
- 生成成果物数
