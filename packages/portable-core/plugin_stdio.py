"""One bounded request/result exchange for explicitly supplied plugin callbacks.

Callbacks can return awaitables. Binary stream reads and writes are blocking;
run a service as a child process, with time and permissions managed by its host.
This module neither grants authority nor provides operating-system isolation.
"""

import inspect
import io
import sys

from plugin_messages import validate_plugin_run_request, validate_plugin_run_result
from plugin_runtime import _json_text, _json_value, _TRIM
from schema_validation import safe_integer

DEFAULT_BYTES = 1024 * 1024
MAX_BYTES = 16 * DEFAULT_BYTES
_UNSET = object()


def _binary_stream(value):
    return isinstance(value, (io.RawIOBase, io.BufferedIOBase))


def _snapshot(value):
    return _json_value(_json_text(value))


async def _resolved(value):
    return await value if inspect.isawaitable(value) else value


def _write(stream, value):
    offset = 0
    while offset < len(value):
        count = stream.write(value[offset:])
        if type(count) is not int or count <= 0 or count > len(value) - offset:
            raise OSError("write")
        offset += count
    stream.flush()


def _close(stream):
    try:
        stream.close()
    except Exception:
        pass


async def serve_plugin_stdio(options, streams=_UNSET):
    """Return protocol status; only fixed stage codes go to the diagnostic stream.

Option keys follow the Node adapter: handleRequest, validateRequest,
validateResult, maxInputBytes and maxOutputBytes. Streams are binary IOBase
instances under stdin, stdout and stderr. Omitted streams use process defaults.
"""
    code, diagnostic = "PLUGIN_STDIO_CONFIG_INVALID", None
    try:
        if streams is _UNSET:
            streams = {}
        if type(streams) is not dict:
            raise ValueError("streams")
        diagnostic = streams["stderr"] if "stderr" in streams else sys.stderr.buffer
        stdin = streams["stdin"] if "stdin" in streams else sys.stdin.buffer
        stdout = streams["stdout"] if "stdout" in streams else sys.stdout.buffer
        if type(options) is not dict:
            raise ValueError("options")
        handle = options.get("handleRequest")
        validate_request = options.get("validateRequest", lambda _: None)
        validate_result = options.get("validateResult", lambda *_: None)
        input_limit = options.get("maxInputBytes", DEFAULT_BYTES)
        output_limit = options.get("maxOutputBytes", DEFAULT_BYTES)
        if not all(callable(callback) for callback in (handle, validate_request, validate_result)) or \
                not all(safe_integer(limit) and 0 < limit <= MAX_BYTES for limit in (input_limit, output_limit)) or \
                not all(_binary_stream(stream) for stream in (stdin, stdout, diagnostic)):
            raise ValueError("config")
        input_limit, output_limit = int(input_limit), int(output_limit)
        code = "PLUGIN_STDIO_READ_FAILED"
        source = bytearray()
        try:
            while True:
                chunk = stdin.read(min(65536, input_limit - len(source) + 1))
                if type(chunk) is str:
                    # Buffer.from(text) replaces lone surrogates but combines pairs.
                    chunk = chunk.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace").encode("utf-8")
                elif type(chunk) not in (bytes, bytearray) and not \
                        (type(chunk) is memoryview and chunk.ndim == 1 and chunk.format == "B" and chunk.c_contiguous):
                    code = "PLUGIN_STDIO_INPUT_INVALID"
                    raise ValueError("chunk")
                if len(chunk) == 0:
                    break
                if len(source) + len(chunk) > input_limit:
                    code = "PLUGIN_STDIO_INPUT_LIMIT"
                    raise ValueError("input limit")
                source.extend(chunk)
        except Exception:
            try:
                stdin.close()
            except Exception:
                pass
            raise
        code = "PLUGIN_STDIO_INPUT_INVALID"
        text = source.decode("utf-8-sig", errors="strict").strip(_TRIM)
        if not text or "\n" in text or "\r" in text:
            raise ValueError("framing")
        request = _json_value(text)
        code = "PLUGIN_STDIO_REQUEST_INVALID"
        validate_plugin_run_request(request)
        if await _resolved(validate_request(_snapshot(request))) is False:
            raise ValueError("request")
        code = "PLUGIN_STDIO_HANDLER_FAILED"
        result = await _resolved(handle(_snapshot(request)))
        code = "PLUGIN_STDIO_RESULT_INVALID"
        validate_plugin_run_result(result, request)
        snapshot = _snapshot(result)
        if await _resolved(validate_result(_snapshot(snapshot), _snapshot(request))) is False:
            raise ValueError("result")
        output = (_json_text(snapshot) + "\n").encode("utf-8")
        code = "PLUGIN_STDIO_OUTPUT_LIMIT"
        if len(output) > output_limit:
            raise ValueError("output limit")
        code = "PLUGIN_STDIO_WRITE_FAILED"
        _write(stdout, output)
        return {"valid": True, "exitCode": 0}
    except Exception:
        # A buffered failed write may otherwise be retried at interpreter exit,
        # replacing exitCode 2 with 120 and leaking an unraisable diagnostic.
        if code == "PLUGIN_STDIO_WRITE_FAILED":
            _close(stdout)
        try:
            if _binary_stream(diagnostic):
                _write(diagnostic, (code + "\n").encode("ascii"))
        except Exception:
            _close(diagnostic)
        return {"valid": False, "exitCode": 2, "code": code}
