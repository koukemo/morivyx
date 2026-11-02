"""Check frozen private CLI examples against an explicitly selected trusted Python implementation."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import subprocess
import sys


VECTOR_SHA256 = "24c885f346f4bc509a58be49172feb01a3da97ba7ebeff974777a76f03af2e2c"
ROOT = Path(__file__).resolve().parent.parent
OPERATIONS = {"digest", "read-yaml", "read-report", "serialize-report", "read-package", "export-package",
              "validate-package", "validate-graph", "index", "trace", "diff", "migration-diff",
              "apply-changeset", "apply-migration", "compare-external", "assess-approvals"}


class CheckFailure(Exception):
    def __init__(self, code, case=None):
        self.code, self.case = code, case


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_value):
        raise ValueError("non-JSON number")

    return json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs, parse_constant=constant)


def json_equal(left, right):
    # Python equality alone equates True with 1; preserve JSON type boundaries.
    if type(left) in (int, float) and type(right) in (int, float):
        return (type(left) is int or math.isfinite(left)) and (type(right) is int or math.isfinite(right)) and left == right
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(json_equal(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def check(vectors, implementation):
    try:
        with vectors.open("rb") as stream:
            raw = stream.read(2 * 1024 * 1024 + 1)
        if hashlib.sha256(raw).hexdigest() != VECTOR_SHA256:
            raise CheckFailure("PORTABLE_VECTORS_PIN_MISMATCH")
        data = strict_json(raw)
    except (OSError, ValueError, RecursionError):
        raise CheckFailure("PORTABLE_VECTORS_INPUT_INVALID") from None
    cases = data["cases"]
    if len(cases) != 24 or {value["operation"] for value in cases} != OPERATIONS:
        raise CheckFailure("PORTABLE_VECTORS_INPUT_INVALID")
    for case in cases:
        request = json.dumps(case["input"], ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        try:
            result = subprocess.run([sys.executable, "-B", str(implementation), case["operation"]], input=request,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise CheckFailure("PORTABLE_VECTOR_PROCESS_FAILED", case["name"]) from None
        if result.returncode != case["exit"] or result.stderr or len(result.stdout) > 1024 * 1024:
            raise CheckFailure("PORTABLE_VECTOR_MISMATCH", case["name"])
        try:
            output = strict_json(result.stdout)
        except (ValueError, RecursionError):
            raise CheckFailure("PORTABLE_VECTOR_OUTPUT_INVALID", case["name"]) from None
        if not json_equal(output, case["expected"]):
            raise CheckFailure("PORTABLE_VECTOR_MISMATCH", case["name"])
    return {"valid": True, "cases": len(cases), "operations": len(OPERATIONS), "matched": len(cases),
            "fixtureSha256": VECTOR_SHA256, "sourceCommit": data["sourceCommit"], "automaticRetries": 0,
            "driverRuntime": {"python": platform.python_version(), "executable": sys.executable},
            "childExecutable": sys.executable, "implementation": str(implementation),
            "timeoutSecondsPerCase": 30, "outputSizeCheckedAfterExit": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vectors", type=Path, default=ROOT / "packages/portable-core/fixtures/portable-cli-vectors.json")
    parser.add_argument("--implementation", type=Path, default=ROOT / "packages/portable-core/portable_cli.py")
    args = parser.parse_args()
    try:
        result = check(args.vectors, args.implementation)
    except CheckFailure as error:
        diagnostic = {"error": {"code": error.code}}
        if error.case is not None:
            diagnostic["error"]["case"] = error.case
        print(json.dumps(diagnostic, separators=(",", ":")), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
