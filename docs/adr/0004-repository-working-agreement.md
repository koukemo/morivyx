---
type: Architecture Decision Record
title: "ADR-0004: リポジトリ作業規則"
description: Git、Issue、Pull Request、文書、ADR の運用規則を定める提案。
status: Accepted
date: 2026-07-24
scope: Repository governance
---

# ADR-0004: リポジトリ作業規則

## 背景

人間とエージェントが同じ品質基準で変更し、判断根拠と作業の対応関係を追跡できる運用が必要です。

## 決定

リポジトリ作業ルール（同梱対象外の参照）を、このリポジトリ全体の作業規則とします。

- 変更は Issue と Pull Request を経由する
- ブランチ、コミット、マージ方式を規定する
- Issue と Pull Request の担当者、ラベル、コメントの責務を規定する
- 文書は既定で日本語の Markdown とし、OKF `v0.1` に準拠させる
- ADR は `docs/adr/` で連番管理し、人間の承認までは `Proposed` とする

## 結果

変更の入口、受け入れ条件、レビュー結果、意思決定の所在が一貫します。運用規則の更新も Issue と Pull Request を経由します。

## 参照

- [Open Knowledge Format `v0.1` 仕様](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
