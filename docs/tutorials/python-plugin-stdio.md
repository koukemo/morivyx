---
type: Tutorial
title: Pythonで拡張機能の応答側を作る
description: 標準入力の要求を独立した複写で検証と処理へ渡し、上限付きの結果と固定した診断を返す。
---

# Pythonで拡張機能の応答側を作る

`serve_plugin_stdio`は、一つの要求を読み、明示した検証関数と処理関数へ渡して、一つの結果を返す共通処理です。
一般契約とバイト数を確認し、入力と例外の本文を診断へ含めません。
宣言、許可と時間を管理する[起動側](python-plugin-runtime.md)と組み合わせて使います。

## 準備する

リポジトリのルートで、[対応するPython](README.md#実行環境を選ぶ)を使います。
以下はmacOSのPython 3.14と3.15で確認し、LinuxとWindowsでは実行していません。
標準機能だけを使い、Node.js、Git、通信と認証情報を必要としません。
例は保存済みの要求を読みますが、正本とファイルを書き換えません。

[合成した応答側](../../packages/portable-core/fixtures/plugin-stdio-echo.py)は、一般契約を満たす要求の値をそのまま返す検査用の例です。
実際の取込機能ではなく、ファイル読取と通信及びOSの権限隔離を行いません。

## 1. 合成した応答側へ要求を渡す

```sh
python3 -B -c 'import json; from pathlib import Path; print(json.dumps(json.loads(Path("packages/kernel/test/fixtures/plugin-communication/request.json").read_text())))' | python3 -B packages/portable-core/fixtures/plugin-stdio-echo.py
```

一つのJSONの結果を末尾の改行付きで返します。
`status`は`success`で、`output.value`に要求の`input`が入ります。
この直接入力では一般契約だけを検査し、宣言と許可情報の照合は次の起動側で行います。

## 2. Pythonの起動側から接続する

```sh
PYTHONPATH=packages/portable-core python3 -B - <<'PY'
import json
from pathlib import Path
import sys
from plugin_runtime import run_plugin_process

value = json.loads(Path("packages/portable-core/fixtures/plugin-runtime-vectors.json").read_text())["templates"]["runtime"]
child = Path("packages/portable-core/fixtures/plugin-stdio-echo.py").resolve()
result = run_plugin_process(**value, command=sys.executable, args=["-B", str(child)])
assert result["output"]["value"] == value["request"]["input"]
print(json.dumps({"status": result["status"], "value": result["output"]["value"]}, ensure_ascii=False))
PY
```

信頼する実行物を明示し、起動側で宣言、要求と許可情報を照合してから子を起動します。
時間と合計出力の上限は起動側が強制します。
応答側の共通処理だけでは、実行情報の正当性、ファイル、通信と機器の権限を検証しません。

## 3. 自分の処理関数と検証関数を渡す

```sh
PYTHONPATH=packages/portable-core python3 -B - <<'PY'
import asyncio
import io
import json
from pathlib import Path
from plugin_stdio import serve_plugin_stdio

request = json.loads(Path("packages/kernel/test/fixtures/plugin-communication/request.json").read_text())

async def handle(value):
    await asyncio.sleep(0)
    return {"format": "morivyx.plugin-run-result/0.1", "runId": value["runId"],
            "plugin": value["plugin"], "capabilityId": value["capability"]["id"],
            "status": "success", "output": {"externalId": value["input"]["externalId"]}}

def validate_request(value):
    return value["input"].get("externalId") == "repository:fixture"

streams = {"stdin": io.BytesIO(json.dumps(request).encode()), "stdout": io.BytesIO(), "stderr": io.BytesIO()}
status = asyncio.run(serve_plugin_stdio({"handleRequest": handle, "validateRequest": validate_request}, streams))
assert status == {"valid": True, "exitCode": 0}
assert streams["stderr"].getvalue() == b""
print(streams["stdout"].getvalue().decode(), end="")
PY
```

設定の項目名は既存のNode.js経路と同じです。
`handleRequest`は必須で、`validateRequest`と`validateResult`は必要な場合に指定します。
同期関数と待機可能な戻り値を扱い、検証関数は`False`だけを拒否とします。
それぞれに別の複写を渡し、結果の検証前に出力用の保存値を作るため、検証関数による変更は元の要求と出力へ反映しません。

入出力を省略した場合は、そのプロセスの標準入出力を使います。
明示する場合は、Pythonのバイナリ入出力を`stdin`、`stdout`と`stderr`へ指定します。
入口は非同期関数ですが、読み書きは同期的なため、起動側から専用の子プロセスとして呼びます。
自分の処理を組み込む場合も、許可と時間の管理を起動側へ接続してください。

## 4. 不正な入力を固定した診断で拒否する

```sh
python3 -B - <<'PY'
import subprocess
import sys

result = subprocess.run([sys.executable, "-B", "packages/portable-core/fixtures/plugin-stdio-echo.py"],
                        input=b"invalid input", capture_output=True)
assert result.returncode == 2
assert result.stdout == b""
assert result.stderr == b"PLUGIN_STDIO_INPUT_INVALID\n"
print(result.stderr.decode(), end="")
PY
```

設定、読取、入力形式、要求、処理、結果、出力上限と書込の失敗を、段階ごとの固定した診断で区別します。
応答側のAPIは`exitCode`を返し、実際の終了は呼出し側が決めます。
合成した応答側は成功時0、失敗時2で終了します。
書込に失敗した出力先を閉じ、終了時に同じバッファーを再送することを防ぎます。
OSへの書込が途中で失敗した場合に、先に出たバイト列を取り消す保証はありません。

入力と出力の上限は既定1MiB、設定できる最大値は16MiBです。
`maxInputBytes`は入力の空白を含み、`maxOutputBytes`は出力末尾の改行を含みます。
重複した同名のJSON項目は既存経路と同じく最後の値を使い、正規化後の項目名の衝突と不正な論理値は後続で拒否します。
形式の正しい失敗結果を受理する場合もあるため、通信の`valid`に加えて結果自身の`status`を確認します。

固定した359例と公開対象35モジュールだけの検査、PythonとNode.jsの両起動側への接続を確認しています。
検査の駆動部は外から渡し、中核と合成した応答側はNode.jsとGitがない環境でも動きます。
実際の取込、権限隔離、本人性、実通信、実機、全機能の独立適合と長期互換は、この結果では証明できません。

![要求と結果を独立した複写で検証し、上限付きの応答又は固定した診断を返す流れ](../diagrams/python-plugin-stdio.png)

[図の生成元](../diagrams/python-plugin-stdio.mmd)
