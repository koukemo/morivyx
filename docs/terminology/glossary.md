---
type: Controlled Vocabulary
title: Morivyx 用語集
description: Morivyx が意味を定める用語の正式表記と意味の境界。
status: Approved
---

# Morivyx 用語集

## 読み方

この用語集にある定義は、すべて利用者の承認済みです。現在の定義と使用条件に従う場合だけ使用できます。

「含む」は、その用語として扱える対象を示します。「含まない」は、近い別概念との境界を示します。許可表記にない表記は、同じ意味の言い換えとして使用しません。

## 基盤

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| Morivyx | Morivyx | 判断と改善に必要な意味、関係、根拠、成果、来歴を接続して保持し、安全な変更を支える基盤 | 意味の保存、変更提案、検証、追跡 | 個別の AI agent、汎用知識庫、特定の保存製品 | `Morivyx` | `Approved` |
| Graph | 論理グラフ | 型を持つ Entity と Relation によって、意味を保存する論理構造 | Entity、Relation、Graph Revision | Graph 専用データベース、画面上の図、無関係なデータ集合 | `Graph` | `Approved` |
| Kernel | 中核構造層 | Graph の同一性、版、関係、来歴、変更検証だけを扱う最小の構造層 | Entity、Relation、Revision、Provenance、ChangeSet の構造 | Goal などの業務上の意味、保存製品、画面 | `Kernel`、`Graph Kernel` | `Approved` |
| Profile | 意味定義集合 | 型、属性、Relation 制約、表示規則を版付きで宣言する交換可能な定義集合 | Core Profile、Domain Profile、Semantic Profile | Kernel の固定構造、実データ | `Profile` | `Approved` |
| Core | 共通意味領域 | 複数の異なる適用領域で共有することが確認された最小の意味領域 | Core Profile、共通 Relation | すべての領域を統一する語彙、Kernel | `Core` | `Approved` |
| Core Profile | 共通意味定義集合 | Core に属する型と Relation の意味を宣言する Profile | Goal、Decision などの採用済み共通概念 | Kernel の固定型、個別領域だけの概念 | `Core Profile` | `Approved` |
| Domain Profile | 適用領域別意味定義集合 | 一つの適用領域に固有の型と規則を宣言する Profile | ソフトウェアなど領域固有の型 | 複数領域で共通と確認された Core | `Domain Profile` | `Approved` |
| Semantic Profile | 意味定義集合 | 意味を持つ型と Relation を宣言する Profile の総称 | Core Profile、Domain Profile、Plugin 固有 Profile | Kernel、保存形式 | `Semantic Profile` | `Approved` |
| Extension | 名前空間付き拡張 | Core を変更せずに追加する、所有者と版を識別できる型または値 | Domain Profile と Plugin の追加項目 | 未登録の Core 項目、意味を失う自由形式データ | `Extension` | `Approved` |
| Schema | 構造制約 | 型、必須項目、値、Relation の許容範囲を機械検査できる形で定めた規則 | Profile の型制約 | 対象データそのもの、業務上の判断 | `Schema`、コード内の `schema` | `Approved` |
| Invariant | 常時成立条件 | 承認済みの対象で常に成立しなければならない検査可能な条件 | 同一性、参照、循環、来歴の条件 | 望ましいだけの目標、単発の検査結果 | `Invariant` | `Approved` |
| Policy | 運用判断規則 | 文脈、主体、権限、危険度に応じて操作の許否を決める規則 | 承認要求、保持、共有、実行の制限 | Schema だけで決まる構造条件 | `Policy` | `Approved` |
| lifecycle | 対象状態の推移 | 一つの対象が生成から失効まで進む状態と遷移 | `draft`、`active`、`deprecated` など | 記録内容がレビューされたかを示す状態 | `lifecycle` | `Approved` |
| review state | 記録確認状態 | 記録内容が確認、提案、承認、却下のどこにあるかを示す状態 | `unreviewed`、`proposed`、`approved`、`rejected` | 対象自体の lifecycle | `review state`、識別子 `reviewState` | `Approved` |
| Core Meta Model | 共通論理モデル | Kernel の構造と Core Profile 候補の関係を、実装から独立して示す論理モデル | GraphElement、Entity、Relation、Revision、Core 候補 | 保存製品の Schema、画面設計、すべての Domain Profile | `Core Meta Model` | `Approved` |
| AI | 人工知能機能 | 学習済み Model または規則によって、分類、推論、生成などの結果を返す機械機能 | AI Model、AI サービス、AI を使う機能 | 人間の承認者、出力の正しさの保証、自律 agent 全体 | `AI` | `Approved` |
| agent | 代理実行機能 | 与えられた Goal、Context、Capability の範囲で、情報取得、判断候補、ツール操作を順に行うソフトウェア | AI を使う agent、規則だけで動く agent | 利用者本人、無制限の権限、最終承認者 | `agent` | `Approved` |
| API | 機能接続契約 | ソフトウェア同士が要求と結果を交換するために公開された操作、入力、出力、失敗の契約 | 外部 API、内部 API、版付き契約 | API を提供する実装全体、画面操作、無契約のファイル共有 | `API` | `Approved` |

## 論理構造

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| GraphElement | グラフ要素 | Entity と Relation が共有する同一性、型、版、状態、来歴の構造 | Entity、Relation の共通部分 | Entity 固有の属性、Graph 全体 | `GraphElement` | `Approved` |
| Entity | 独立対象 | 独立した同一性と lifecycle を持つ GraphElement | Goal、Artifact、Actor など | 二つの対象を結ぶ Relation、単なる表示行 | `Entity` | `Approved` |
| Relation | 意味関係 | `source`、`predicate`、`target` によって Entity 間の意味を表し、自身も同一性と来歴を持つ GraphElement | 型付き二項関係、実体化対象への関係 | 画面だけの線、根拠のない関連、属性値 | `Relation` | `Approved` |
| Revision | 不変版 | 一つの対象内容を変更不能な形で特定する版 | Entity、Relation、Artifact の特定内容 | 表示名、変更可能な現在状態、履歴全体 | `Revision` | `Approved` |
| Graph Revision | グラフ版 | 検証済み Graph 全体の一つの不変な状態 | 親版、根、適用 ChangeSet、Schema の固定情報 | 作業中の未検証変更、Git の履歴記録そのもの | `Graph Revision`、`GraphRevision` | `Approved` |
| ChangeSet | 原子変更提案 | 一つの基準 Graph Revision に対する、まとめて検証し適用する変更提案 | 作成、改訂、失効、置換、撤回 | 検証を通さない直接変更、複数回に分かれる不定な操作 | `ChangeSet` | `Approved` |
| Provenance | 来歴 | 誰が、いつ、どの入力と方法で記録または成果を生んだかを追跡できる情報 | 主体、入力版、方法、時刻、外部参照 | 非公開の思考過程、内容の正しさそのもの | `Provenance`、文中の `provenance` | `Approved` |
| ProvenanceRecord | 来歴記録 | 一つの生成、取得、主張、観測、検証に対応する構造化された Provenance | 方法、入力、主体、時刻、受領情報 | 対象の全履歴をまとめた説明 | `ProvenanceRecord` | `Approved` |
| stable ID | 安定識別子 | 表示名、場所、型が変わっても同じ論理対象を指す不透明な識別子 | 論理対象の同一性 | Revision ID、外部製品の ID、意味を埋め込んだ名前 | `stable ID` | `Approved` |
| Revision ID | 版識別子 | 一つの不変な Revision を特定する識別子 | 特定内容の版 | 論理対象全体の stable ID | `Revision ID` | `Approved` |
| canonical form | 正規形 | 同じ意味の入力から常に同じバイト列を生成する規定済み表現 | 項目順、文字正規化、数値表現 | 人間向けの自由な表記、元入力の書式 | `canonical form` | `Approved` |
| digest | 内容要約値 | 指定した算法で内容から計算し、同一性または完全性の確認に使う値 | 内容確認、版参照 | 内容の意味、暗号化、永続的な論理 ID | `digest` | `Approved` |
| semantic diff | 意味差分 | 表記差ではなく、Entity、Relation、判断、根拠、状態の変化を示す差分 | 追加、置換、関係変更、追跡欠落 | 空白や項目順だけの差、通常の文字列差分全体 | `semantic diff` | `Approved` |
| Migration | 意味移行 | 旧 Schema または Profile の Graph を、意味と来歴を追跡しながら新しい版へ変換する操作 | 事前条件、変換、事後条件、対応表 | 暗黙変換、外部作用、履歴を失う上書き | `Migration`、文中の `migration` | `Approved` |
| version | 契約版 | Schema、Profile、規格、外部成果など、時間とともに変化する系列の位置を示す値 | 互換性を判断する版、外部対象の版 | 一つの不変内容を指す Revision、論理対象の ID | `version` | `Approved` |
| serialization | 直列表現変換 | 論理構造を保存または交換できるバイト列へ変換し、そこから復元する規則 | YAML、JSON、canonical form、codec | 保存場所、論理意味の変更、画面表示だけの変換 | `serialization` | `Approved` |
| storage | 保存機構 | バイト列または記録を保持し、後から取得できる物理的な機構 | ファイル、データベース、物体保存 | Graph の論理意味、serialization 規則、正本の所有判断 | `storage` | `Approved` |
| adapter | 接続変換部 | 一つの契約を別の外部機能または物理実装へ接続する交換可能な実装 | storage adapter、Model 提供元用 adapter | Domain の意味定義、正規 Graph | `adapter`、`Adapter` | `Approved` |
| codec | 符号化変換 | 一つの論理値と特定のバイト表現を相互変換する規則または実装 | JSON、NDJSON、バイナリ符号化の変換 | 保存機構、意味移行、Profile | `codec` | `Approved` |
| Bundle | 交換用集合 | Graph の論理内容と解釈に必要な付属情報を、運搬可能にまとめた集合 | Entity、Relation、Schema 固定情報、構成記録 | 運用中のデータベースそのもの、独立した外部正本 | `Bundle`、文中の `bundle` | `Approved` |
| package | 配布単位 | Plugin、Schema、生成規則などを、版と内容要約値を持つ取得可能な単位へまとめたもの | Plugin package、Profile package | 実行中の Plugin、Graph Revision、Bundle 全体 | `package` | `Approved` |

## 改善に関する概念

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| Goal | 目標 | 実現したい観測可能な状態 | 受益者、範囲、成功条件、制約、時間軸 | 解決方法、実行済みの結果、抽象的な願望だけの文 | `Goal` | `Approved` |
| Intent | 意図解釈 | 人間が Goal の動機、意味、優先順位、範囲、譲れない条件をどう理解しているか | 同じ Goal に対する複数の解釈 | Goal 自体、実行手順、採択済み判断 | `Intent` | `Approved` |
| Decision | 意思決定記録 | 特定の文脈で一つの問いを閉じ、選択肢を選んだ記録 | 問い、選択肢、結論、根拠、反証、影響、再検討条件 | 単なる結論、未決の提案、実行履歴 | `Decision` | `Approved` |
| Knowledge | 主張 | 評価または反証でき、事実、仮説、推論、規範の区分と来歴を持つ主張 | 採用した主張とその根拠 | 文書そのもの、観測行為、無根拠な真理 | `Knowledge` | `Approved` |
| Plan | 計画 | Goal へ向かう予定された行為、依存、順序、資源、停止条件 | 未実行または実行予定の行為 | 実行済みであること、成果物、Goal | `Plan` | `Approved` |
| Execution | 実行履歴 | Plan またはその一部を実際に行った履歴 | 主体、入力、時刻、結果、再試行、外部作用 | 予定だけの Plan、生成された Artifact 自体 | `Execution` | `Approved` |
| Artifact | 参照可能成果 | 生成、輸入、変更され、同一性または参照を持つ成果 | コード、文書、設計データ、設定、物理物 | 成果から採用した Knowledge、成果を生んだ Execution | `Artifact` | `Approved` |
| Criterion | 評価基準 | Goal の達成または Verification の判定に使う規則 | 測定方法、必須条件、許容値 | 実際の評価行為、評価結果、Goal 全体 | `Criterion` | `Approved` |
| Verification | 検証実行 | 特定の対象、版、環境を Criterion に照らして評価した行為と判定 | 方法、対象版、基準、環境、結果 | Criterion の定義だけ、一般的な検査定義 | `Verification` | `Approved` |
| Observation | 観測結果 | 特定の時点と文脈で、対象、方法、主体または装置とともに記録された結果 | `observedAt`、`recordedAt`、値、方法 | 真理の保証、Verification の判定規則 | `Observation` | `Approved` |
| Learning | 理解変更提案 | Observation または Verification から導いた理解の変化または次の変更提案 | Knowledge、Goal、Decision、Plan の変更開始 | Graph への直接変更、観測結果そのもの | `Learning` | `Approved` |
| Actor | 責任主体 | 行為、判断、記録、観測について責任を割り当てられる主体 | 人間、組織、AI、サービス、ツール、装置 | 責任を持たないデータ、単なる識別子 | `Actor` | `Approved` |
| Context | 適用文脈 | 意味または規則が適用される範囲、環境、時間、境界 | 対象範囲、環境、時点、信頼境界 | 対象そのもの、どこでも成立する Invariant | `Context` | `Approved` |
| Option | 選択肢 | Decision で検討した採用可能または不採用の案 | 採用案、不採用案、比較情報 | Decision の結論、実行 Plan | `Option` | `Approved` |
| Constraint | 制約 | Goal、Intent、Plan、Execution の許容範囲を狭める条件 | 禁止、上限、必須条件 | 成功を測る Criterion、運用時の許否を決める Policy | `Constraint` | `Approved` |
| ExternalSource | 外部取得元 | 外部システム、文書、データ、出来事の同一性と取得点を表す対象 | 外部 ID、版、取得時点、取得来歴 | 取得した Artifact 自体、内容から得た Knowledge | `ExternalSource` | `Approved` |
| Artifact reference | 成果参照 | Artifact の内容を複製せず、その同一性、場所、版、内容要約値へ到達するための記録 | URI、外部 ID、version、digest | Artifact の内容、Artifact の所有権、Knowledge | `Artifact reference` | `Approved` |
| external Artifact | 外部正本成果 | Morivyx の外側に独立した正本があり、Morivyx は参照と来歴を管理する Artifact | 外部 repository、Figma のデータ、実機 | Morivyx が再生成責任を持つ Projection | `external Artifact` | `Approved` |
| managed Projection | 管理対象派生表現 | Morivyx が承認済み Graph Revision から再生成し、手編集を正本としない Projection | View、Report、生成 manifest | external Artifact、手編集を正本とする文書 | `managed Projection` | `Approved` |
| Finding | 発見事項 | Analyzer または人間が見つけ、確認や対応の対象として提示する観察または問題候補 | 欠陥候補、差異、注意事項 | 承認済み Knowledge、Verification の最終判定 | `Finding` | `Approved` |
| Claim | 主張内容 | Knowledge が保持する、評価または反証の対象となる一つの文 | 事実候補、仮説、推論、規範 | 主張を含む Artifact、根拠、真理の保証 | `Claim` | `Approved` |

## 面

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| Normative Plane | 規範面 | 何を望み、選び、行う予定かを扱う意味上の面 | Goal、Intent、Decision、Plan | 実行済みの事実、観測結果 | `Normative Plane` | `Approved` |
| Actual Plane | 実績面 | 実際に行われ、生じたものを扱う意味上の面 | Execution、Artifact | 予定、評価、主張 | `Actual Plane` | `Approved` |
| Evidential Plane | 証拠面 | 何をどの方法で観測または評価したかを扱う意味上の面 | Verification、Observation | Goal、実行予定、真理の断定 | `Evidential Plane` | `Approved` |
| Epistemic Plane | 認識面 | 何を知っていると主張し、理解がどう変化したかを扱う意味上の面 | Knowledge、Learning | Artifact 自体、観測行為自体 | `Epistemic Plane` | `Approved` |

## 外部機能との境界

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| Plugin | 外部機能単位 | Kernel の外側で情報取得、分析、生成、検証、外部作用を行い、定められた契約で結果を返す機能単位 | Importer、Analyzer、Generator、Validator、Executor | Kernel の内部処理、無制限の直接 Graph 変更 | `Plugin` | `Approved` |
| Capability | 能力許可 | Plugin が利用できる入力、出力、資源、外部作用の範囲を限定する許可 | 読み取り範囲、出力種別、外部通信、予算 | Plugin の実装、実行結果、包括的な管理者権限 | `Capability` | `Approved` |
| Proposal | 変更候補 | 検証と承認を受ける前の、Graph または外部作用に対する候補 | ChangeSet 候補、生成物候補、変更理由 | 承認済み Graph Revision、実行済み外部作用 | `Proposal` | `Approved` |
| Importer | 取込機能 | ExternalSource から情報を読み、同一性、版、内容要約値、来歴付きの候補へ変換する Plugin | 再取込差分、外部参照、取得記録 | 外部正本の所有、無承認 Graph 変更 | `Importer` | `Approved` |
| Analyzer | 分析機能 | 固定入力を調べ、Finding、Knowledge 候補、評価候補を返す Plugin | 静的分析、分類、診断 | 正規 Graph の直接変更、最終承認 | `Analyzer` | `Approved` |
| Generator | 生成機能 | 固定入力から Artifact 候補または変更候補を作る Plugin | 文書、コード、設定の候補 | 承認済み成果の確定、外部反映 | `Generator` | `Approved` |
| Projector | 投影機能 | 承認済み Graph Revision から決定的な派生成果を作る Plugin | View、Report、生成用 manifest | 外部正本の編集、確率的な承認判断 | `Projector` | `Approved` |
| Validator | 検査機能 | Schema、Invariant、Policy などへの適合を判定する機能 | 構造、参照、権限、追跡の検査 | 対象の修正、利用者の承認 | `Validator` | `Approved` |
| Executor | 外部実行機能 | 承認済みの外部作用を外部システムへ反映し、結果を記録する Plugin | 配備、機器命令、受領記録 | 無承認実行、Graph 内だけの Relation 作成 | `Executor` | `Approved` |
| ActionIntent | 外部作用意図 | 実行前に、対象、操作、入力、危険度、承認、再試行単位を固定する記録 | 外部作用の予定と許可条件 | 実行済み結果、通常の Plan 全体 | `ActionIntent` | `Approved` |
| Receipt | 外部受領記録 | 外部システムが要求を受けたことまたは処理したことを示す参照可能な記録 | 外部 ID、時刻、結果参照 | 実際の世界状態の保証、Observation | `Receipt` | `Approved` |
| reconciliation | 状態照合 | 内部記録と外部状態を比較し、不明または不一致の結果を確定する処理 | 再照会、差分検出、補償判断 | 最初の実行要求、無条件の再試行 | `reconciliation`、`reconcile` | `Approved` |
| Run | 一回の機能実行 | 固定した入力、Capability、版、開始と終了、結果を持つ Plugin または処理の一回の実行 | `RunRequest`、`RunResult`、実行来歴 | Plugin の全 lifecycle、複数回をまとめた系列 | `Run` | `Approved` |
| idempotency | 再実行同一性 | 同じ意図を示す同一キーの要求を繰り返しても、意図した外部作用が重複しない性質 | 要求キー、重複検出、既存結果の返却 | 実行が必ず成功する保証、異なる意図の統合 | `idempotency` | `Approved` |

## 表現と追跡

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| Projection | 派生表現 | Graph から規則に従って生成する、破棄して再生成できる表現 | View、Report、生成 manifest | 独立した外部正本、Graph 自体 | `Projection`、文中の `projection` | `Approved` |
| View | 閲覧表現 | 特定の読み手または問いのために Graph の一部を表示する Projection | 一覧、図、要約 | 正規 Graph、独立編集する文書 | `View` | `Approved` |
| Report | 報告表現 | 指定した問い、条件、入力版に対する結果をまとめる Projection | Trace Report、検査結果 | 正規 Graph、変更提案 | `Report` | `Approved` |
| Manifest | 構成記録 | 成果、入力、版、内容要約値、生成条件の対応を機械可読に列挙する記録 | Artifact manifest、Plugin manifest | 成果内容そのもの、承認 | `Manifest`、文中の `manifest` | `Approved` |
| Trace | 追跡経路 | ある対象から、意味を持つ Relation をたどって根拠、判断、結果、由来へ到達する経路 | Goal から Artifact、Verification、Observation への経路 | ファイル内の単なるリンク列、実行時の詳細ログ | `Trace`、文中の `trace` | `Approved` |
| Traceability | 追跡可能性 | 必要な Trace が存在し、問いに応じて再現、検査できる性質 | 根拠、判断、成果、結果、由来の接続 | Relation 数の多さ、任意の全文検索 | `Traceability`、文中の `traceability` | `Approved` |
| Query | 問いの実行表現 | Graph に対する明示的な問いと、その再現可能な取得条件 | Trace の探索、条件付き取得 | 内容を変更する操作、自然言語の曖昧な要望 | `Query`、文中の `query` | `Approved` |
| repository | 版管理対象集合 | ファイルと変更履歴を一つの管理単位として保持する場所 | Git repository、このリポジトリ | Graph の意味上の同一性、Workspace、外部組織全体 | `repository`、`Repository` | `Approved` |
| Workspace | 一回の作業範囲 | 一つの作業で参照、変更、検査するファイルと設定の境界 | 単一 repository 内の作業場所、作業用設定 | repository の全履歴、Graph 全体、外部組織 | `Workspace`、文中の `workspace` | `Approved` |
| Git authoring profile | Git 編集用表現規則 | 人間が Git 差分として読み書きするために固定した、厳格な serialization 規則 | YAML の制限表現、ファイル配置、差分規則 | canonical form、運用 storage、すべての Git 使用方法 | `Git authoring profile` | `Approved` |
| round-trip | 往復保持 | 表現を読み取り、別表現へ変換し、再び元の論理表現へ戻しても必要情報を失わない性質 | 未知 Extension の保持、読み書きの往復 | バイト列の一致、意味移行、処理成功の保証 | `round-trip` | `Approved` |
| lossless | 情報無損失 | 指定した変換範囲で、復元に必要な情報を失わない性質 | 未知値の保持、可逆変換 | バイト列の一致、不要と決めた情報の保持、正しさの保証 | `lossless` | `Approved` |
| stale | 外部参照の旧化 | 記録した外部対象の版または内容要約値が、現在参照すべき対象と一致しない状態 | 外部変更、参照先更新、取得時点との差 | 参照先の消失、Schema 不適合、内容の誤り | `stale` | `Approved` |
| review | 内容確認 | 定義済み基準に照らして変更内容、根拠、影響を調べ、指摘または判断材料を残す行為 | 差分確認、コメント、問題指摘 | 変更を受け入れる approval、機械検査だけ | `review` | `Approved` |
| approval | 許可判断 | 権限を持つ Actor が、特定の版、操作、条件に対して進行を明示的に許可した記録 | 用語承認、外部作用許可、変更取込許可 | review の実施、沈黙、推定、内容の正しさの保証 | `approval`、`Approval` | `Approved` |

## 状態値

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| `draft` | 下書き状態 | 必須情報の欠落を許し、正規利用の対象にしない lifecycle 状態 | 編集中の対象 | 承認済み、検証済み、正規利用可能 | 識別子 `draft` | `Approved` |
| `active` | 有効状態 | 現在の適用範囲で正規利用する lifecycle 状態 | 現行対象 | 内容がレビュー済みである保証、永久有効 | 識別子 `active` | `Approved` |
| `accepted` | 採択状態 | 検証と必要な approval を通り、正規 Graph の対象として採択された lifecycle 状態 | 正規 Graph に含まれる対象 | review state の `approved`、Goal の達成 | 識別子 `accepted` | `Approved` |
| `deprecated` | 非推奨状態 | 既存参照のため保持するが、新しい使用を認めない lifecycle 状態 | 移行待ちの対象 | 即時削除、意味上の置換完了 | 識別子 `deprecated` | `Approved` |
| `superseded` | 置換済み状態 | 新しい Entity が意味上の後継となり、現行利用を終えた lifecycle 状態 | `supersedes` Relation で後継を示す対象 | 誤りによる撤回、物理削除 | 識別子 `superseded` | `Approved` |
| `retracted` | 撤回状態 | 主張、判断、記録を有効なものとして扱わないと明示した lifecycle 状態 | 反証または誤りで撤回した対象 | 履歴削除、後継による置換 | 識別子 `retracted` | `Approved` |
| `unreviewed` | 未確認状態 | 内容確認がまだ行われていない review state | 新規取込、未確認記録 | 却下、提案、承認 | 識別子 `unreviewed` | `Approved` |
| `proposed` | 提案状態 | 内容を採択または承認するために提示している review state | 確認待ちの候補 | 採択済み、承認済み、却下済み | 識別子 `proposed` | `Approved` |
| `approved` | 承認状態 | 権限を持つ Actor が、特定内容を確認して許可した review state | 明示的な approval を持つ記録 | lifecycle の `accepted`、沈黙、推定承認 | 識別子 `approved` | `Approved` |
| `rejected` | 却下状態 | 権限を持つ Actor が、提示内容を採用しないと判断した review state | 却下理由を持つ候補 | 撤回、置換、未確認 | 識別子 `rejected` | `Approved` |

## 開発と文書管理

| 正式表記 | 日本語の説明名 | 定義 | 含む | 含まない | 許可表記 | 状態 |
|---|---|---|---|---|---|---|
| ADR | 意思決定記録文書 | 重要な設計または運用判断について、文脈、決定、結果、再検討条件を保存する文書 | `docs/adr/` の連番文書 | 一時的な作業メモ、Pull Request のレビュー結果 | `ADR`、`ADR-` と4桁番号 | `Approved` |
| Issue | 作業要求 | 背景、目的、対象、受け入れ条件を管理する GitHub 上の作業単位 | 機能、文書、修正の要求 | 実装差分、レビュー判断 | `Issue` | `Approved` |
| Pull Request | 変更取込要求 | ブランチの変更を別のブランチへ取り込むための GitHub 上のレビュー単位 | 差分、担当者、ラベル、関連 Issue、レビュー | 受け入れ条件の唯一の保管場所、直接の本番反映 | `Pull Request` | `Approved` |
| MVP | 最小検証対象 | 最小の実装と実例で、中心仮説の成立可否を判断する範囲 | 必須の垂直実例、終了条件 | 長期構想の全機能、単なる最初の公開版 | `MVP` | `Approved` |
| Stage | 検証段階 | 前段の終了条件を満たした後に進む、目的と終了条件を持つ開発段階 | Stage 0 から Stage 6 | 暦年、固定納期、機能一覧だけの区切り | `Stage` と番号 | `Approved` |
