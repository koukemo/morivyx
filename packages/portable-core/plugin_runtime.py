"""Independent execution grants and bounded direct-child plugin transport.

This is not an OS sandbox. Permission names are data, not enforced filesystem,
network or device controls. Only the direct child is killed on transport failure.
"""

import json
import os
import re
import subprocess
import sys
import time
from typing import NamedTuple

from canonical import canonical_json as _canonical_json, load_json
from plugin_host_policy import authorize_plugin_host_policy
from plugin_messages import authorize_plugin_run_request, validate_plugin_run_result
from schema_validation import SPACE, ValidationError
from stdin_transport import read_bounded_stdin

GRANT_FORMAT = "morivyx.plugin-execution-grant/0.1"
GRANT_ENV = "MORIVYX_PLUGIN_EXECUTION_GRANT"
LIMIT = 8 * 1024 * 1024
_UNSET = object()


class PluginExecutionGrant(NamedTuple):
    """Immutable raw JSON snapshot; extracted mappings are fresh mutable copies."""

    json_text: str

    def to_dict(self):
        return load_json(self.json_text)

    @property
    def canonical_json(self):
        return _canonical_json(self.to_dict())


def create_plugin_execution_grant(manifest, request, policy=None):
    """Bind the declaration and host permission data into an immutable snapshot."""
    authorize_plugin_run_request(manifest, request)
    capability = authorize_plugin_host_policy(manifest, request["capability"]["id"], policy)
    value = {
        "format": GRANT_FORMAT,
        "runId": request["runId"],
        "plugin": {key: manifest["identity"][key] for key in ("id", "version")},
        "capability": {key: capability[key] for key in ("id", "effect", "permissions", "resources")},
    }
    return PluginExecutionGrant(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


def _failed():
    raise ValidationError("PLUGIN_RUN_FAILED", "/") from None


def _json_text(value):
    """JSON.stringify-compatible logical values without Python recursion."""
    output, active, work = [], set(), [("value", value)]
    while work:
        operation, current = work.pop()
        if operation == "text":
            output.append(current)
        elif operation == "leave":
            active.remove(current)
        elif current is None:
            output.append("null")
        elif type(current) is bool:
            output.append("true" if current else "false")
        elif type(current) is str:
            output.append(json.dumps(current, ensure_ascii=False))
        elif type(current) in (int, float):
            output.append(str(int(current)))
        elif type(current) in (dict, list):
            identity = id(current)
            if identity in active:
                raise ValueError("cycle")
            active.add(identity)
            work.append(("leave", identity))
            if type(current) is list:
                output.append("[")
                work.append(("text", "]"))
                for index in range(len(current) - 1, -1, -1):
                    work.extend((("value", current[index]), ("text", "," if index else "")))
            else:
                indices = sorted((key for key in current if re.fullmatch(r"(?:0|[1-9][0-9]*)", key)
                                  and len(key) <= 10 and int(key) < 4294967295), key=int)
                indexed = set(indices)
                keys = [*indices, *(key for key in current if key not in indexed)]
                output.append("{")
                work.append(("text", "}"))
                for index, key in reversed(list(enumerate(keys))):
                    work.extend((("value", current[key]), ("text", ("," if index else "") + json.dumps(key, ensure_ascii=False) + ":")))
        else:
            raise ValueError("value")
    return "".join(output)


def _json_value(source, reject_duplicates=False):
    """Parse JSON containers iteratively; standard JSON decoders parse atoms."""
    def constant(_):
        raise ValueError("number")

    decoder = json.JSONDecoder(parse_int=lambda token: -0.0 if token == "-0" else int(token), parse_constant=constant)
    frames, result, position = [], _UNSET, 0
    while True:
        while position < len(source) and source[position] in " \t\r\n":
            position += 1
        if frames:
            frame = frames[-1]
            container, state, key = frame
            closer = "}" if type(container) is dict else "]"
            if state == "comma":
                if source[position:position + 1] == closer:
                    frames.pop()
                    position += 1
                elif source[position:position + 1] == ",":
                    frame[1] = "key" if type(container) is dict else "value"
                    position += 1
                else:
                    raise ValueError("separator")
                continue
            if state in ("first-key", "key"):
                if state == "first-key" and source[position:position + 1] == "}":
                    frames.pop()
                    position += 1
                    continue
                if source[position:position + 1] != '"':
                    raise ValueError("key")
                frame[2], position = decoder.raw_decode(source, position)
                frame[1] = "colon"
                continue
            if state == "colon":
                if source[position:position + 1] != ":":
                    raise ValueError("colon")
                frame[1] = "value"
                position += 1
                continue
            if state == "first-value" and source[position:position + 1] == "]":
                frames.pop()
                position += 1
                continue
        elif result is not _UNSET:
            if position != len(source):
                raise ValueError("tail")
            return result
        opening = source[position:position + 1]
        if opening in ("{", "["):
            value = {} if opening == "{" else []
            position += 1
        else:
            value, position = decoder.raw_decode(source, position)
        if frames:
            container, _, key = frames[-1]
            if type(container) is dict:
                if reject_duplicates and key in container:
                    raise ValueError("duplicate key")
                container[key] = value
            else:
                container.append(value)
            frames[-1][1] = "comma"
        else:
            result = value
        if opening in ("{", "["):
            frames.append([value, "first-key" if opening == "{" else "first-value", None])


def _cleanup(process):
    for stream in (process.stdin, process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _exchange(process, input_bytes, output_limit, deadline):
    """Pump all three nonblocking pipes without retaining stderr contents."""
    offset, total, output = 0, 0, bytearray()
    try:
        for stream in (process.stdin, process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            progressed = False
            if not process.stdin.closed:
                if offset == len(input_bytes):
                    process.stdin.close()
                    progressed = True
                else:
                    try:
                        count = os.write(process.stdin.fileno(), input_bytes[offset:offset + 65536])
                        offset += count
                        progressed = count > 0
                    except BlockingIOError:
                        pass
            for stream in (process.stdout, process.stderr):
                if stream.closed:
                    continue
                try:
                    chunk = os.read(stream.fileno(), min(65536, output_limit - total + 1))
                except BlockingIOError:
                    continue
                progressed = True
                if not chunk:
                    stream.close()
                else:
                    total += len(chunk)
                    if total > output_limit:
                        raise ValueError("output limit")
                    if stream is process.stdout:
                        output.extend(chunk)
            status = process.poll()
            if status is not None:
                if offset != len(input_bytes):
                    raise BrokenPipeError()
                if not process.stdin.closed:
                    process.stdin.close()
                if process.stdout.closed and process.stderr.closed:
                    return status, bytes(output)
            if not progressed:
                time.sleep(min(0.002, remaining))
    finally:
        _cleanup(process)


def _parse_result(data, request):
    try:
        text = data.decode("utf-8", errors="strict")
        # ECMAScript trim differs from str.strip for BOM and NEL, among others.
        text = re.sub(rf"^[{SPACE}]+|[{SPACE}]+$", "", text)
        if not text or "\n" in text:
            raise ValueError("framing")

        # Match JSON.parse's last-key-wins behavior at this transport boundary.
        # Logical validation still rejects NFC key collisions and invalid values.
        value = _json_value(text)
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValidationError("PLUGIN_RESULT_INVALID", "/") from None
    return validate_plugin_run_result(value, request)


def run_plugin_process(*, command=_UNSET, args=_UNSET, manifest=None, request=None, policy=None, cwd=_UNSET):
    """Run a trusted executable with only grant data in its supplied environment.

    Enforce the wall-clock and combined stdout/stderr byte limits. Memory and
    cost limits cannot be enforced and are rejected before any child is started.
    This does not confine OS permissions or guarantee termination of descendants.
    """
    grant = create_plugin_execution_grant(manifest, request, policy)
    resources = grant.to_dict()["capability"]["resources"]
    if any(key in resources for key in ("maxMemoryBytes", "maxCostUnits")):
        raise ValidationError("PLUGIN_RUN_RESOURCE_UNSUPPORTED", "/policy/capability/resources")
    if args is _UNSET:
        args = []
    if type(command) is not str or not command or "\0" in command or type(args) is not list or \
            any(type(value) is not str or "\0" in value for value in args) or \
            (cwd is not _UNSET and (type(cwd) is not str or "\0" in cwd)):
        raise ValidationError("PLUGIN_RUN_INVALID", "/command")
    try:
        text = _json_text(request)
        sent_request = _json_value(text)
        data = (text + "\n").encode("utf-8")
        deadline = time.monotonic() + resources["timeoutMs"] / 1000
        process = subprocess.Popen([command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=None if cwd is _UNSET else cwd, env={GRANT_ENV: grant.canonical_json},
                                   bufsize=0, close_fds=True, shell=False)
        status, output = _exchange(process, data, int(resources["maxOutputBytes"]), deadline)
    except Exception:
        _failed()
    if status != 0:
        _failed()
    return _parse_result(output, sent_request)


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("arguments")
        value = _json_value(read_bounded_stdin(sys.stdin.buffer, LIMIT).decode("utf-8", errors="strict"), reject_duplicates=True)
        if type(value) is not dict or set(value) != {"operation", "manifest", "request", "policy"} or value["operation"] != "grant":
            raise ValueError("operation")
        grant = create_plugin_execution_grant(value["manifest"], value["request"], value["policy"])
        output = (json.dumps({"grant": grant.to_dict()}, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(output) > LIMIT:
            raise ValueError("output")
        sys.stdout.buffer.write(output)
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError, OverflowError):
        print('{"error":{"code":"PLUGIN_RUNTIME_INPUT_INVALID","path":"/"}}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
