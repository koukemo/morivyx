---
type: Architecture Decision Record
title: Git authoring profile と canonical form
description: YAML の入力制限、JSON の正規化、stable ID、Revision ID、digest の決定を記録する。
status: Accepted
---

# ADR-0007: Git authoring profile と canonical form

## 文脈

Stage 0 の参照 Graph では、YAML の round-trip と正規化で確認する観点を記録しましたが、同じ意味の入力から生成する正解バイト列と digest は固定していません。
入力表記、文字正規化、項目順、日時、一覧、Revision ID の計算範囲が未確定なままでは、別実装が同じ Graph Revision を生成できません。

人間が review する YAML と、内容同一性に使う canonical form の責任を分け、MVP の検査値を固定します。

## 決定

### 1. stable ID

MVP の stable ID は、UUID の版4を小文字の `urn:uuid:` 表記にした文字列とします。

```text
urn:uuid:550e8400-e29b-41d4-a716-446655440000
```

ID はオフラインで生成し、型、表示名、場所、所有者、提供元を含めません。
別の ID 方式は将来追加できますが、一つの Graph package 内では Schema 固定情報に方式を一つだけ記録します。

### 2. Git authoring profile

一つの Entity または Relation を一つの YAML 1.2.2 文書として保存します。
ファイルは UTF-8、`BOM` なし、`LF` 改行、末尾改行一件とします。

許可する値は、対応表、一覧、二重引用符付き文字列、真偽値、`null`、安全な範囲の整数です。
`null` は Schema が明示的に許可した項目だけで使います。
整数は `-9007199254740991` から `9007199254740991` までとし、先頭の零、正の符号、負の零を禁止します。

真偽値は `true` または `false`、空値は `null` の小文字表記だけを許可します。
整数は `0` または、零以外で始まる数字列に必要な場合だけ `-` を付けた表記とします。

既知の対応表は Schema が定める `authoringOrder` で項目を並べます。
未知の Extension 内の対応表は、NFC 正規化後の項目名を Unicode 符号位置の昇順に並べます。
読み取り機能は別順序の対応表を論理値へ変換できますが、Git authoring profile の検査は順序違反を拒否します。

次を禁止します。

- 重複する項目名と、NFC 正規化後に重複する項目名
- 引用符のない文字列値
- 小数と指数表記
- `NaN` と `Infinity`
- `anchor`、`alias`、`merge key`、`custom tag`
- `flow style`、`block scalar`、複数 YAML 文書
- YAML の指示行と文書境界表記
- タブ、`CRLF`、`BOM`
- コメント
- Schema が許可しない項目と `null`

項目名は文字列とし、NFC へ正規化します。
文字列値も読み取り直後に NFC へ正規化します。
正規化後に異なる項目を同一視する入力と、不正な UTF-8 を拒否します。
Git authoring profile における文字列の論理値は NFC 正規化後の値であり、正規化前の符号位置列は保持対象ではありません。

### 3. 論理値

YAML の表記差を取り除いた後、Schema に従って論理値を作ります。

- 対応表は順序を持たない
- 一覧は既定で順序を持つ
- Schema が集合と定義した一覧は、各要素の canonical form のバイト順に並べ、重複を拒否する
- 未知の Extension 内の一覧は順序を保持する
- 日時項目は `YYYY-MM-DDTHH:mm:ss`、必要な場合の小数部、`Z` または `+HH:mm`、`-HH:mm` の時間帯を持つ形とし、`UTC` の秒単位、末尾 `Z` へ変換する
- 日時の小数秒は、Schema が許可する場合だけ使い、末尾の不要な零を除く

日時は実在する日付と時刻だけを許可し、秒は `00` から `59`、時間帯の差は `-14:00` から `+14:00` までとします。
英字の `T` と `Z` は大文字だけを許可します。

### 4. canonical form

canonical form は、論理値を一つの JSON 値として表した UTF-8 のバイト列です。
末尾改行と `BOM` を付けません。

- 対応表の項目名を、NFC 正規化後の Unicode 符号位置の昇順に並べる
- JSON の項目間に空白を入れない
- 文字列は `"`、`\`、制御文字だけを JSON の `escape` で表す
- 制御文字のうち、短い `escape` があるものは `\b`、`\t`、`\n`、`\f`、`\r` を使う
- その他の制御文字は小文字の4桁16進数を持つ `\u` の `escape` を使う
- `/` と制御文字以外の Unicode 文字は `escape` しない
- 真偽値と `null` は JSON の小文字表記を使う
- 整数は先頭の零、正の符号、負の零がない10進表記を使う
- 一覧は論理値で確定した順序を保つ

GraphElement 自身の `revision` 項目だけを canonical form の入力から除きます。
Relation の接続先 Revision、Provenance の入力 Revision など、別対象を参照する項目は除きません。

### 5. Revision ID と digest

MVP の digest 算法は SHA-256、算法 ID は `sha256` とします。
Revision ID は次のバイト列を順に結合し、SHA-256 で計算します。

1. `ASCII` の `morivyx:revision:v1`
2. 一バイトの `00`
3. `revision` を除いた canonical form

接頭辞の16進表記は次です。

```text
6d6f72697679783a7265766973696f6e3a763100
```

Revision ID は、小文字の64桁16進数に `sha256:` を付けます。

```text
sha256:<64桁の小文字16進数>
```

読み取り時は、文書に記録された Revision ID と再計算値を比較します。
不一致なら受け入れません。
別算法を追加する場合は、新しい算法 ID、用途を区別する接頭辞、検査値を追加し、既存 Revision ID を書き換えません。

### 6. approval と Revision

対象 Revision を参照する approval の ProvenanceRecord は、対象 GraphElement の canonical form に埋め込みません。
先に対象 Revision ID を計算し、別の記録からその Revision を参照します。
これにより自己参照を避けます。

### 7. Extension の round-trip

未知の名前空間付き Extension は、対応表、一覧、文字列、真偽値、`null`、整数の論理値を保持します。
YAML のコメント、引用方法、項目順など、Git authoring profile で意味を持たない表記は保持対象にしません。

未知の Extension を読み、canonical form を生成し、再び Git authoring profile へ出力したとき、論理値と一覧の順序が一致しなければなりません。

## 結果

### 利点

- YAML の見た目の差が Revision 差になりません。
- 同じ意味の入力から別実装が同じ Revision ID を計算できます。
- `revision` の自己参照と approval の循環参照を避けられます。
- 未知の Extension を論理値として保持できます。
- 小数表現と日時表現の実装差を MVP から除外できます。

### 負担

- YAML の自由な表記、コメント、`flow style`、`block scalar` を使えません。
- 小数と安全な範囲を超える整数は、Schema で型を持つ文字列として表す必要があります。
- 日時の元の時間帯表記は canonical form に残りません。
- UUID の版4以外の stable ID は、方式追加の決定が必要です。

## 検証

- 項目順、日時の時間帯、Unicode の合成方法が異なる二入力から同じ canonical form と Revision ID を得ること。
- 正解 canonical form が検査値に記録した519バイトと一致すること。
- `revision` 項目を変更しても再計算値は変わらず、他の項目変更では再計算値が変わること。
- 未知の Extension の文字列と一覧順序が round-trip 後も一致すること。
- 禁止した YAML 入力をすべて拒否すること。
- 同じ Revision ID を別の用途の digest として再利用しないこと。

## 再検討条件

- 小数を文字列で扱うと必要な Query または semantic diff を表現できない場合。
- UUID の版4で衝突対策または運用上の識別が不足する場合。
- JSON 以外の canonical form が複数実装間の一致をより単純に検証できる場合。
- コメントを禁止すると人間による review に必要な文脈を保持できない場合。
- SHA-256 の継続利用が安全要件または外部規格を満たさなくなった場合。
