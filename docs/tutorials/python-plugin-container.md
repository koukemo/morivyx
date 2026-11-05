---
type: Tutorial
title: Pythonで実行条件を照合してコンテナ実行へ接続する
description: 入力の複写、実行条件の照合と後片付けを模擬接続で試し、実際のOS隔離の確認範囲を区別する。
---

# Pythonで実行条件を照合してコンテナ実行へ接続する

`run_plugin_container`は、宣言、要求と許可から実行情報を作り、固定したイメージへ入力を渡します。
返された設定を照合してから開始し、結果を元の要求へ結び付けます。
`PLUGIN_ISOLATED_RUN_FORMAT`が形式を、変更できない`PLUGIN_CONTAINER_LIMITS`が上限を表します。
Pythonの標準機能だけで使えます。

## 外部操作を伴わない例を実行する

公開ソースのルートで実行します。
同梱した合成データと、ホスト側で信頼する模擬接続を使います。
実Docker、実イメージ、認証と外部通信は使いません。
申告された設定の照合を試す例であり、実際のOS隔離の実証ではありません。

```sh
python3.14 -B - <<'PY'
import asyncio
import copy
import json
from pathlib import Path
import sys

core = Path.cwd() / "packages/portable-core"
sys.path.insert(0, str(core))
from plugin_container import run_plugin_container
from schema_validation import ValidationError

vectors = json.loads((core / "fixtures/plugin-container-vectors.json").read_text())
input_value = copy.deepcopy(vectors["input"])
for item in input_value["files"]:
    item["bytes"] = bytearray(item["bytes"])
container_id = vectors["receipt"]["isolation"]["containerId"]
state = {}

async def transport(args, settings):
    assert settings["timeoutMs"] > 0
    if args[0] == "info":
        return {"code": 0, "stdout": json.dumps(vectors["server"])}
    if args[0] == "image":
        return {"code": 0, "stdout": input_value["imageId"]}
    if args[1] == "create":
        def flag(key):
            return args[args.index(key) + 1]
        source = flag("--mount").split("source=", 1)[1].split(",", 1)[0]
        assert (Path(source) / "source.txt").read_bytes() == b"source\n"
        state["source"] = source
        state["info"] = {
            "Id": container_id, "Image": input_value["imageId"],
            "Config": {"Labels": {"morivyx.run": flag("--label").split("=", 1)[1]},
                       "User": "65534:65534", "WorkingDir": "/input"},
            "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                "CapDrop": ["ALL"], "CapAdd": None, "SecurityOpt": ["no-new-privileges=true"],
                "Memory": int(flag("--memory")), "MemorySwap": int(flag("--memory-swap")),
                "PidsLimit": 32, "NanoCpus": 1000000000, "LogConfig": {"Type": "none"},
                "PidMode": "", "IpcMode": "none", "CgroupnsMode": "private"},
            "Mounts": [{"Type": "bind", "Source": source, "Destination": "/input", "RW": False}],
        }
        return {"code": 0, "stdout": container_id}
    if args[1] == "inspect":
        return {"code": 0, "stdout": json.dumps([state["info"]])}
    if args[1] == "start":
        assert json.loads(settings["input"]) == input_value["request"]
        return {"code": 0, "stdout": json.dumps(vectors["receipt"]["result"])}
    if args[1] == "rm":
        assert "signal" not in settings
        state["removed"] = True
        return {"code": 0, "stdout": container_id}
    raise AssertionError("unexpected operation")

result = asyncio.run(run_plugin_container(input_value, {"transport": transport}))
print(result["result"]["status"], result["isolation"]["containerRemoved"])
print(state["removed"], not Path(state["source"]).exists())
invalid = copy.deepcopy(input_value)
invalid["files"][0]["path"] = "../outside"
try:
    asyncio.run(run_plugin_container(invalid, {"transport": transport}))
except ValidationError as error:
    print(error.code)
PY
```

出力は次のとおりです。

```text
success True
True True
PLUGIN_ISOLATION_PATH_INVALID
```

最初の結果は模擬接続が返した成功で、次の行は除去の要求と所有した一時領域の除去を表します。
最後は親フォルダーへ移動する入力の拒否です。
呼出し側の要求と入力バイト列は、関数を呼び出した時点で複写されます。

## 自分の呼出し側へ接続する

入力には`manifest`、`request`、`policy`、`imageId`と`files`を渡します。
各ファイルは相対パスの`path`、許可名の`permission`とバイト列の`bytes`を持ちます。
バイト列には`bytes`、`bytearray`と、これらを参照する連続した符号なし一バイトの`memoryview`を使えます。
共有した記憶領域と解放済みの参照は拒否します。
宣言と許可の準備は[実行情報の手順](python-plugin-runtime.md)も参照してください。

`options`には絶対パスの`dockerPath`、信頼するホスト側の接続処理の`transport`と、[中断通知](python-figma-import.md)で使う`AbortSignal`の`signal`を指定できます。
接続処理は引数と設定を受け、応答または待機可能な応答を返します。
注入した接続処理自身が期限や通知を無視する場合まで、入口による強制停止を保証しません。
標準の子の起動処理は、時間と合計出力の上限、不正なUTF-8と中断を扱います。
実際の基盤へ接続する場合は、利用する基盤、イメージと許可を運用側で確認します。
この手順では、実基盤への接続と実際のOS隔離を未確認とします。

入力は256ファイルまで、一件1 MiB、合計8 MiBまでです。
要求は1 MiB、許可は64 KiBまで、実行時間は30秒、出力は1 MiBまでに制限します。
記憶容量は最低32 MiB、既定128 MiB、上限256 MiBです。
未対応のネットワーク、秘密情報、端末への権限、Graph読取と費用上限は拒否します。

後片付けに失敗した場合は`PLUGIN_ISOLATION_CLEANUP_FAILED`を優先し、`details`へ対象の識別子、実行名と作業場所を返します。
空の対象一覧だけから取消し完了とは推定しません。
残した対象を確認してから、運用側で後続の処置を決めます。
拡張機能が失敗を返しても、結果の形式と要求との対応が正しければ正常な応答として返せます。

## 照合する

```sh
cd packages/portable-core
python3.14 -B -m unittest -v test_plugin_container
```

元の実装から固定した652例と、設定、権限と後片付けに関する追加21結果を照合します。
公開46本番モジュールだけの環境で、NodeとGitを探索せずに固定結果を再現します。
模擬接続による設定照合と、所有する模擬実行物の時間及び出力の制限を確認する範囲です。
本人性、採用権限、基盤の真正性、実際のOS隔離と実外部取得の確認を含みません。

![入力を複写して実行条件を照合し、後片付けの失敗を残して実際のOS隔離の確認と分ける流れ](../diagrams/python-plugin-container.png)

[図の生成元](../diagrams/python-plugin-container.mmd)
