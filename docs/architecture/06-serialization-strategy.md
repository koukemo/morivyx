---
type: Architecture Reference
title: シリアライズ戦略
description: Graph の正規表現、交換形式、派生成果物の方針を定義する。
---

# serialization 方針

## 原則

Core Meta Model と serialization を分離します。Entity、Relation、Revision、Provenance の意味が仕様であり、YAML、JSON、Graph 専用データベースの表現は codec または Projection です。

ただし、相互運用性のために「どの表現でもよい」とはしません。MVP では人間による review、Git の差分、決定的な digest を検証する一つの厳格な Git authoring profile を定めます。

## 三つの serialization 層

### 1. Git authoring profile

人間が読み、編集し、Pull Request で review する厳格な YAML の制限表現です。原則として一つの Entity または Relation を一ファイルにします。

### 2. 内容要約用の canonical form

論理対象を決定的な JSON 表現へ正規化し、Revision ID、Graph の根、署名、一時保存のキー、再現性判定に使います。YAML の表記差は意味上の Revision 差にしません。

### 3. Bundle と転送用 Profile

大量データ、通信転送、他規格との交換に使う追加 codec です。NDJSON、バイナリ符号化、JSON-LD などを将来追加できますが、その都合を Core Meta Model へ持ち込みません。

## Git 配置案

```text
.morivyx/
  project.yaml
  schema.lock.yaml
  plugins.lock.yaml
  policies/
  recipes/
  graph/
    entities/
      <stable-id>.yaml
    relations/
      <stable-id>.yaml
  ledger/
    <changeset-id>.yaml
  artifact-manifests/
```

- ファイルの場所は同一性ではない
- 表示名変更でファイル名を変えない
- 運用データベース、検索索引、Graph 専用データベースはこの package から lossless に再構築できる
- View、Report、一時保存は正規 Graph と分離し、再生成可能にする
- 生成物を Git に含める場合は Artifact の Manifest と不一致検査を伴う

分割戦略は実データで検証します。大量の小ファイルが問題になる規模では、同じ論理 profile を保った bundle codec を追加します。

## 検査値

serialization 検査値（同梱対象外の参照）に、同じ意味を持つ二つの Entity 入力、正解 canonical form、Revision ID、round-trip の正解、不正入力を記録します。

Relation も同じ Git authoring profile と canonical form を使います。
accepted な判断、検証、派生物に関わる Relation は、`source` と `target` の Revision を固定します。
GraphElement 自身の `revision` だけを内容要約値の入力から除き、接続先 Revision は除きません。

## YAML の制限

一つの Entity または Relation を一つの YAML 1.2.2 文書へ保存します。
ファイルは UTF-8、`BOM` なし、`LF` 改行、末尾改行一件とします。

許可する値は、対応表、一覧、二重引用符付き文字列、真偽値、Schema が許可した `null`、安全な範囲の整数です。
文字列と項目名は NFC へ正規化します。
整数は `-9007199254740991` から `9007199254740991` までとします。

既知の対応表は Schema の `authoringOrder`、未知の Extension 内の対応表は NFC 正規化後の Unicode 符号位置で項目を並べます。
真偽値と `null` は小文字、整数は先頭の零、正の符号、負の零がない表記だけを許可します。

曖昧さと不要な diff を避けるため、次を禁止します。

- 重複する項目名と、NFC 正規化後に重複する項目名
- 引用符のない文字列値
- 小数、指数表記、安全な範囲を超える整数
- `anchor`、`alias`、`merge key`、`custom tag`
- `NaN`、`Infinity`
- `flow style`、`block scalar`、複数 YAML 文書
- YAML の指示行と文書境界表記
- タブ、`CRLF`、`BOM`、コメント
- Schema で定義されない項目と `null`

日時は `YYYY-MM-DDTHH:mm:ss`、必要な場合の小数部、`Z` または `+HH:mm`、`-HH:mm` の時間帯を持つ形とし、canonical form では `UTC` の秒単位と末尾 `Z` へ変換します。
秒は `00` から `59`、時間帯の差は `-14:00` から `+14:00` までとします。
`observedAt` と `recordedAt` は分けます。
物理量は値と単位、空間座標は基準座標系を伴う型として Domain Profile で定義します。

## 正規化と内容要約値

canonical form は論理値を一つの JSON 値として表した UTF-8 のバイト列です。
末尾改行と `BOM` を付けません。

- 対応表の項目名を NFC 正規化後の Unicode 符号位置で並べる
- 項目間の空白を除く
- 文字列の `escape`、真偽値、`null`、整数を一意な表記にする
- 順序を持つ一覧は入力順を保つ
- Schema が集合と定義した一覧は、各要素の canonical form のバイト順に並べ、重複を拒否する
- 未知の Extension の論理値と一覧順序を含める
- GraphElement 自身の `revision` だけを入力から除く

MVP の digest 算法は SHA-256、算法 ID は `sha256` とします。
Revision ID は、`morivyx:revision:v1`、一バイトの `00`、canonical form を順に結合して計算します。
同じ意味の入力は同じ canonical form と Revision ID を生成しなければなりません。

別算法を追加する場合は、算法 ID、用途を区別する接頭辞、検査値を追加します。
既存 Revision ID は書き換えません。
Graph の根は別の用途を示す接頭辞と検査値を使い、Revision ID の digest を流用しません。

## 同一性

- MVP の stable ID は UUID の版4を小文字の `urn:uuid:` 表記にする
- ID はオフラインでも生成できる不透明かつ世界で一意な識別子とする
- ID に型、表示名、所有者、場所、提供元を埋め込まない
- 人間が読める別名は変更可能な属性として持つ
- 外部 ID は ExternalSource との対応として保持する
- Importer は再取り込み時に同じ外部対象を同じ論理対象へ対応付ける
- 誤った同一視と分割は、履歴付き ChangeSet で訂正する

stable ID 方式と digest 算法は Schema 固定情報に記録します。

## Artifact と大容量データ

「Graph から導出可能」は、すべてのバイトを Graph の属性に埋め込むことを意味しません。

### managed Projection

View、Report、生成した Manifest などは、次から再生成可能にします。

- 入力 Graph Revision
- 生成規則とひな形の digest
- Projector ID、version、package digest
- 明示的な設定

### external Artifact または大容量 Artifact

repository、バイナリデータ、三次元成果、動画、データ集合、遠隔測定値、物理物は、それぞれの正本を維持します。Graph には次を保持します。

- URI または外部同一性
- 変更されない version または一時点の記録
- 内容の digest と算法
- 媒体種別、大きさ、利用許諾、保持区分
- 作成・取得 provenance
- Goal、Decision、Execution、Verification との Relation

保存先は Git の大容量ファイル保存、対象保存機構、OCI の登録簿などへ交換できます。場所が変わっても同一性と完全性を確認できるようにします。

## semantic diff と統合

文字列の差分に加え、少なくとも次を semantic diff として提示します。

- Entity / Relation の追加、改訂、失効、置換
- Decision の選択・根拠・影響範囲の変更
- Goal の Criterion と達成評価の変更
- Trace の完成、欠落、stale 化
- provenance または external digest の変更
- 未知の Extension と Schema の version の変更

同じ属性の競合、削除と編集の競合、Decision の選択競合、Relation の Invariant 違反は自動で後勝ちにしません。

## version の区分

次の version を混ぜません。

- Core Meta Model
- Semantic Profile / Extension schema
- Git の serialization 形式
- Plugin の通信契約
- Plugin package
- Capability の入力と出力の Schema
- Graph Revision と根の digest
- 生成規則、ひな形、指示文
- Artifact の Revision

固定情報ファイルは解釈と再生成に必要な Schema、Plugin package の digest、生成規則を固定します。未知の Extension は不透明なまま保持し、未知の Core の意味は拒否します。

## Migration 方針

Migration は決定的、副作用なし、idempotency を持つ Graph 変換とします。

1. schema と Plugin の互換性を診断する
2. Migration の Plan と semantic diff を生成する
3. 試行実行で事前条件を検証する
4. 専用ブランチに ChangeSet を生成する
5. 事後条件、Traceability、round-trip を検証する
6. 人間レビュー後に適用する
7. 派生 View と Artifact を再生成する

各 Migration は変換元と変換先の version、変換規則、新旧の対応、変換前後の Graph の根、実行手段の digest を記録します。

- 暗黙の migration は行わない
- Extension の migration は所有 Profile / Plugin が提供する
- 未知 Extension を破壊しない
- 不可逆変換は旧内容を Policy の範囲内で退避する
- 過渡期には旧版読取用と新版書込用の adapter を許容する
- schema migration は外部 API や物理作用を発火しない

## 削除、保持、秘匿

通常の意味変更は削除印、撤回、置換で履歴を保ちます。一方、個人情報、機密値、法的削除要求には実データ削除が必要です。

- 機密内容と長期保持する Provenance を分離する
- 保持区分と責任者を記録する
- 秘匿後は、許される範囲で削除理由と影響した Trace を残す
- digest 自体が情報を漏らす場合も Policy 対象にする
- 予備保存、一時保存、派生 Artifact まで削除範囲を追跡する
