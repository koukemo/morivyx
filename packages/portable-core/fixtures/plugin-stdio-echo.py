"""Synthetic echo service using production framing, not an importer or sandbox."""

import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plugin_stdio import serve_plugin_stdio


async def handle(request):
    await asyncio.sleep(0)
    return {"format": "morivyx.plugin-run-result/0.1", "runId": request["runId"],
            "plugin": request["plugin"], "capabilityId": request["capability"]["id"],
            "status": "success", "output": {"value": request["input"]}}


async def main():
    result = await serve_plugin_stdio({"handleRequest": handle} if len(sys.argv) == 1 else {})
    return result["exitCode"]


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
