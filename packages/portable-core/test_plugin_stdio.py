import asyncio
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from plugin_runtime import run_plugin_process
from plugin_stdio import serve_plugin_stdio

CORE = Path(__file__).parent
VECTORS = json.loads((CORE / "fixtures/plugin-stdio-vectors.json").read_text())
CHILD = CORE / "fixtures/plugin-stdio-echo.py"
spec = importlib.util.spec_from_file_location("stdio_driver", CORE.parents[1] / "tools/python-plugin-stdio-driver.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class PluginStdioTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_frozen_results_and_call_order(self):
        self.assertEqual(len(VECTORS["cases"]), 359)
        self.assertEqual(len({entry["id"] for entry in VECTORS["cases"]}), 359)
        self.assertEqual(sum(entry["expected"]["status"]["valid"] for entry in VECTORS["cases"]), 71)
        for entry in VECTORS["cases"]:
            with self.subTest(name=entry["id"]):
                before = copy.deepcopy(entry)
                self.assertEqual(await driver.run_case(VECTORS, entry), entry["expected"])
                self.assertEqual(entry, before)

    async def test_sync_callbacks_false_only_and_integral_limits(self):
        request, result = VECTORS["templates"]["request"], VECTORS["templates"]["result"]
        for reply in (None, 0, 0.0, "", [], {}):
            streams = {"stdin": io.BytesIO(driver.wire(request).encode()), "stdout": io.BytesIO(), "stderr": io.BytesIO()}
            status = await serve_plugin_stdio({"handleRequest": lambda _: result, "validateRequest": lambda _: reply,
                                              "validateResult": lambda *_: reply, "maxInputBytes": 1048576.0}, streams)
            self.assertEqual(status, {"valid": True, "exitCode": 0})
            self.assertEqual(json.loads(streams["stdout"].getvalue()), result)

    async def test_output_is_snapshot_before_validator_await(self):
        request, result = copy.deepcopy(VECTORS["templates"]["request"]), copy.deepcopy(VECTORS["templates"]["result"])
        saved = copy.deepcopy(result)

        async def validate_response(value, sent):
            value["plugin"]["id"] = "copy-only"
            sent["runId"] = "copy-only"
            result["runId"] = "external-change"
            await asyncio.sleep(0)

        streams = {"stdin": io.BytesIO(driver.wire(request).encode()), "stdout": io.BytesIO(), "stderr": io.BytesIO()}
        status = await serve_plugin_stdio({"handleRequest": lambda _: result, "validateResult": validate_response}, streams)
        self.assertTrue(status["valid"])
        self.assertEqual(json.loads(streams["stdout"].getvalue()), saved)
        self.assertEqual(request, VECTORS["templates"]["request"])

    async def test_short_writes_are_completed_and_flushed(self):
        class Short(driver.Sink):
            def __init__(self):
                super().__init__()
                self.flushed = False

            def write(self, data):
                self.data.extend(data[:1])
                return 1

            def flush(self):
                self.flushed = True

        output = Short()
        result = VECTORS["templates"]["result"]
        status = await serve_plugin_stdio({"handleRequest": lambda _: result},
                                         {"stdin": io.BytesIO(driver.wire(VECTORS["templates"]["request"]).encode()),
                                          "stdout": output, "stderr": io.BytesIO()})
        self.assertTrue(status["valid"])
        self.assertTrue(output.flushed)
        self.assertEqual(bytes(output.data), (driver.wire(result) + "\n").encode())

    async def test_input_limit_stops_and_closes_before_more_reads(self):
        stream = driver.Input(b"x" * 20, {})
        output, diagnostic = io.BytesIO(), io.BytesIO()
        status = await serve_plugin_stdio({"handleRequest": lambda _: self.fail("must not call"), "maxInputBytes": 10},
                                         {"stdin": stream, "stdout": output, "stderr": diagnostic})
        self.assertEqual(status["code"], "PLUGIN_STDIO_INPUT_LIMIT")
        self.assertEqual(stream.read_calls, 1)
        self.assertTrue(stream.closed)
        self.assertEqual(output.getvalue(), b"")
        self.assertEqual(diagnostic.getvalue(), b"PLUGIN_STDIO_INPUT_LIMIT\n")

    async def test_empty_or_invalid_write_counts_and_flush_errors_are_fixed(self):
        for count in (None, 0, -1, 1.2, True, 999999):
            class Wrong(driver.Sink):
                def write(self, data):
                    return count

            diagnostic = io.BytesIO()
            status = await serve_plugin_stdio({"handleRequest": lambda _: VECTORS["templates"]["result"]},
                                             {"stdin": io.BytesIO(driver.wire(VECTORS["templates"]["request"]).encode()),
                                              "stdout": Wrong(), "stderr": diagnostic})
            self.assertEqual(status["code"], "PLUGIN_STDIO_WRITE_FAILED")
            self.assertEqual(diagnostic.getvalue(), b"PLUGIN_STDIO_WRITE_FAILED\n")

        class FlushFailure(driver.Sink):
            def flush(self):
                raise OSError("NEVER_ECHO_FLUSH")

        diagnostic = io.BytesIO()
        status = await serve_plugin_stdio({"handleRequest": lambda _: VECTORS["templates"]["result"]},
                                         {"stdin": io.BytesIO(driver.wire(VECTORS["templates"]["request"]).encode()),
                                          "stdout": FlushFailure(), "stderr": diagnostic})
        self.assertEqual(status["code"], "PLUGIN_STDIO_WRITE_FAILED")
        self.assertEqual(diagnostic.getvalue(), b"PLUGIN_STDIO_WRITE_FAILED\n")

    async def test_invalid_config_does_not_read_and_defaults_are_lazy(self):
        class Unread(io.BytesIO):
            def read(self, *_):
                raise AssertionError("must not read")

        diagnostic = io.BytesIO()
        for options in (None, {}, {"handleRequest": None}):
            status = await serve_plugin_stdio(options, {"stdin": Unread(), "stdout": io.BytesIO(), "stderr": diagnostic})
            self.assertEqual(status["code"], "PLUGIN_STDIO_CONFIG_INVALID")
        self.assertEqual((await serve_plugin_stdio({}, None))["code"], "PLUGIN_STDIO_CONFIG_INVALID")
        request, result = VECTORS["templates"]["request"], VECTORS["templates"]["result"]

        class Default:
            def __init__(self, data):
                self.buffer = io.BytesIO(data)

        stdin, stdout, stderr = Default(driver.wire(request).encode()), Default(b""), Default(b"")
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
            status = await serve_plugin_stdio({"handleRequest": lambda _: result})
        self.assertTrue(status["valid"])
        self.assertEqual(json.loads(stdout.buffer.getvalue()), result)
        # Explicit streams must not evaluate defaults with no .buffer attribute.
        with patch.object(sys, "stdin", object()), patch.object(sys, "stdout", object()), patch.object(sys, "stderr", object()):
            status = await serve_plugin_stdio({"handleRequest": lambda _: result},
                                             {"stdin": io.BytesIO(driver.wire(request).encode()), "stdout": io.BytesIO(), "stderr": io.BytesIO()})
        self.assertTrue(status["valid"])

    def test_actual_python_host_and_service_connect(self):
        value = json.loads((CORE / "fixtures/plugin-runtime-vectors.json").read_text())["templates"]["runtime"]
        result = run_plugin_process(**value, command=sys.executable, args=["-B", str(CHILD.resolve())])
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["output"]["value"], value["request"]["input"])

    def test_real_service_invalid_input_and_argument_do_not_disclose(self):
        for args, data, code in [([], b"INPUT_SENTINEL", "PLUGIN_STDIO_INPUT_INVALID"),
                                 ([], b"\xff", "PLUGIN_STDIO_INPUT_INVALID"),
                                 ([], b"x" * 1048577, "PLUGIN_STDIO_INPUT_LIMIT"),
                                 (["INPUT_SENTINEL"], b"{}", "PLUGIN_STDIO_CONFIG_INVALID")]:
            result = subprocess.run([sys.executable, "-B", str(CHILD), *args], input=data, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, (code + "\n").encode())

    def test_real_closed_stdout_returns_only_fixed_diagnostic(self):
        child = subprocess.Popen([sys.executable, "-B", str(CHILD)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdout.close()
            child.stdin.write(driver.wire(VECTORS["templates"]["request"]).encode())
            child.stdin.close()
            diagnostic = child.stderr.read()
            self.assertEqual(child.wait(timeout=30), 2)
            self.assertEqual(diagnostic, b"PLUGIN_STDIO_WRITE_FAILED\n")
        finally:
            child.stderr.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=30)


if __name__ == "__main__":
    unittest.main()
