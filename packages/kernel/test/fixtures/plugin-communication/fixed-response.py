"""Independent wire-format fixture, not a repository reader or security boundary."""

import json
from pathlib import Path
import sys

request = json.loads(sys.stdin.buffer.read(1048577))
result = json.loads(Path(__file__).with_name("result.json").read_text(encoding="utf-8"))
result["runId"] = request["runId"]
result["plugin"] = request["plugin"]
result["capabilityId"] = request["capability"]["id"]
sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
