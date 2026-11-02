---
type: Documentation Index
title: 中核仕様の入口
description: 配布したCore定義、設計文書、採用済みの契約と用語集への入口。
---

# 中核仕様の入口

使い始める場合は、[利用手順の入口](tutorials/README.md)から進めます。

## Coreと保存

- [Coreの定義](schema/morivyx-core-0-1.md)
- [機械可読のCore Schema](schema/morivyx.core@0.1.yaml)
- [用語集](terminology/glossary.md)

## 設計

- [構想と設計原則](architecture/01-foundation.md)
- [中核概念](architecture/02-core-concepts.md)
- [中核のモデル](architecture/03-core-meta-model.md)
- [目標と判断の追跡](architecture/04-goals-decisions-traceability.md)
- [プラグインの境界](architecture/05-plugin-architecture.md)
- [保存形式](architecture/06-serialization-strategy.md)
- [最初の対象範囲](architecture/07-mvp-scope.md)

## 採用済みの契約

- [0001-graph-first-semantic-kernel](adr/0001-graph-first-semantic-kernel.md)
- [0002-canonical-graph-and-derived-artifacts](adr/0002-canonical-graph-and-derived-artifacts.md)
- [0003-plugins-propose-kernel-commits](adr/0003-plugins-propose-kernel-commits.md)
- [0004-repository-working-agreement](adr/0004-repository-working-agreement.md)
- [0005-controlled-terminology](adr/0005-controlled-terminology.md)
- [0006-stage-0-graph-constraints](adr/0006-stage-0-graph-constraints.md)
- [0007-git-authoring-and-canonical-form](adr/0007-git-authoring-and-canonical-form.md)
- [0008-schema-registry-and-validator-contract](adr/0008-schema-registry-and-validator-contract.md)
- [0009-graph-package-and-revision-records](adr/0009-graph-package-and-revision-records.md)
- [0010-changeset-format-and-apply-rules](adr/0010-changeset-format-and-apply-rules.md)
- [0011-schema-definition-digest](adr/0011-schema-definition-digest.md)
- [0012-trace-query-and-semantic-diff](adr/0012-trace-query-and-semantic-diff.md)
- [0013-migration-format-and-boundaries](adr/0013-migration-format-and-boundaries.md)
- [0014-external-artifact-stale-detection](adr/0014-external-artifact-stale-detection.md)
- [0015-external-artifact-report-persistence](adr/0015-external-artifact-report-persistence.md)
- [0016-migration-semantic-diff-boundary](adr/0016-migration-semantic-diff-boundary.md)
- [0017-network-acquisition-and-isolated-conversion](adr/0017-network-acquisition-and-isolated-conversion.md)

提案中の契約と試作のProfileは、第1版の規範として含めません。
Node.jsのプラグイン用の機械可読の契約は、リポジトリ直下の`contracts/`にあります。
