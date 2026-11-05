"""Bounded container-engine exchange with captured inputs and owned staging.

An injected transport is trusted host code and must honor timeout and signal.
Reported engine configuration alone does not establish OS isolation.
"""

import asyncio
import copy
import errno
import inspect
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from types import MappingProxyType

from canonical import canonical_json
from figma_import import AbortSignal
from plugin_messages import validate_plugin_run_result
from plugin_runtime import GRANT_ENV, _TRIM, _json_text, create_plugin_execution_grant
from schema_validation import ValidationError

PLUGIN_ISOLATED_RUN_FORMAT = "morivyx.plugin-isolated-run/0.1"
PLUGIN_CONTAINER_LIMITS = MappingProxyType({
    "maxFiles": 256, "maxFileBytes": 1048576, "maxTotalBytes": 8388608,
    "maxRequestBytes": 1048576, "maxGrantBytes": 65536, "maxOutputBytes": 1048576,
    "maxTimeoutMs": 30000, "minMemoryBytes": 33554432, "maxMemoryBytes": 268435456,
    "defaultMemoryBytes": 134217728, "pids": 32, "cpus": 1, "cleanupTimeoutMs": 5000,
})
_UNSET = object()
_IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
_CONTAINER = re.compile(r"[0-9a-f]{64}")


class PluginIsolationError(ValidationError):
    def __init__(self, suffix):
        super().__init__("PLUGIN_ISOLATION_" + suffix, "/isolation")


def _check(condition, suffix):
    if not condition:
        raise PluginIsolationError(suffix)


def _record(value, keys, required=None):
    return type(value) is dict and all(type(key) is str and key in keys for key in value) and all(
        key in value for key in (keys if required is None else required))


def _bytes(value):
    # Invoke native descriptors directly: byte subclasses may shadow public
    # length, indexing and conversion hooks. Never execute those hooks.
    ancestry = type.__dict__["__mro__"].__get__(type(value), type(type(value)))
    try:
        if any(base is bytearray for base in ancestry):
            length = bytearray.__len__(value)
            _check(length <= 1048576, "INPUT_LIMIT")
            return bytes(bytearray.__getitem__(value, slice(None)))
        if any(base is bytes for base in ancestry):
            length = bytes.__len__(value)
            _check(length <= 1048576, "INPUT_LIMIT")
            return bytes.__getitem__(value, slice(None))
        if type(value) is memoryview and value.ndim == 1 and value.format == "B" and value.c_contiguous and type(value.obj) in (bytes, bytearray):
            _check(value.nbytes <= 1048576, "INPUT_LIMIT")
            return value.tobytes()
    except PluginIsolationError:
        raise
    except (ValueError, BufferError):
        pass
    raise PluginIsolationError("INPUT_INVALID")


def _prepare(value):
    _check(_record(value, ("manifest", "request", "policy", "imageId", "files")), "INPUT_INVALID")
    grant = create_plugin_execution_grant(value["manifest"], value["request"], value["policy"]).to_dict()
    image = value["imageId"]
    _check(type(image) is str and _IMAGE.fullmatch(image) is not None, "IMAGE_INVALID")
    permissions, resources = grant["capability"]["permissions"], grant["capability"]["resources"]
    _check(all(not permissions[key] for key in ("graphRead", "network", "secrets", "devices")), "PERMISSION_UNSUPPORTED")
    _check("maxCostUnits" not in resources, "RESOURCE_UNSUPPORTED")
    memory = min(resources.get("maxMemoryBytes", 134217728), 268435456)
    _check(memory >= 33554432, "RESOURCE_UNSUPPORTED")
    resources.update(timeoutMs=min(resources["timeoutMs"], 30000), maxOutputBytes=min(resources["maxOutputBytes"], 1048576), maxMemoryBytes=memory)
    request = copy.deepcopy(value["request"])
    request_text, grant_text = _json_text(request) + "\n", canonical_json(grant)
    _check(len(request_text.encode("utf-8")) <= 1048576 and len(grant_text.encode("utf-8")) <= 65536, "INPUT_LIMIT")
    source_files = value["files"]
    _check(type(source_files) is list and len(source_files) <= 256, "INPUT_INVALID")
    paths, files, total = set(), [], 0
    for item in source_files:
        _check(_record(item, ("path", "permission", "bytes")), "INPUT_INVALID")
        path = item["path"]
        _check(type(path) is str and 0 < len(path.encode("utf-16-le", errors="surrogatepass")) // 2 <= 1024 and
               not os.path.isabs(path) and re.search(r"[:\\\x00-\x1f\x7f]", path) is None and
               all(part not in ("", ".", "..") for part in path.split("/")), "PATH_INVALID")
        try:
            canonical_json(path)
        except Exception:
            raise PluginIsolationError("PATH_INVALID") from None
        _check(path not in paths, "PATH_INVALID")
        _check(type(item["permission"]) is str and item["permission"] in permissions["fileRead"], "PERMISSION_DENIED")
        raw = _bytes(item["bytes"])
        total += len(raw)
        _check(total <= 8388608, "INPUT_LIMIT")
        paths.add(path)
        files.append((path, raw))
    for path in paths:
        parts = path.split("/")[:-1]
        while parts:
            _check("/".join(parts) not in paths, "PATH_INVALID")
            parts.pop()
    return {"request": request, "requestText": request_text, "grantText": grant_text, "grant": grant, "files": files, "imageId": image}


def _get(value, key):
    if value is None:
        raise TypeError("null property")
    return value.get(key) if type(value) is dict else None


def _optional(value, key):
    return value.get(key) if type(value) is dict else None


def _trim(value):
    if type(value) is not str:
        raise TypeError("string required")
    return value.strip(_TRIM)


def _zero(value):
    return type(value) in (int, float) and value == 0


async def _invoke(command, args, settings, cwd):
    signal = settings.get("signal")
    _check(signal is None or not signal.aborted, "CANCELLED")
    try:
        process = await asyncio.create_subprocess_exec(command, *args, cwd=cwd,
            env={"PATH": "/usr/bin:/bin", "LANG": "C"}, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except (OSError, ValueError):
        raise PluginIsolationError("UNAVAILABLE") from None
    total, stdout, stderr = 0, [], []
    loop = asyncio.get_running_loop()
    cancelled = loop.create_future()

    def abort():
        if not cancelled.done():
            cancelled.set_result(None)

    async def read(stream, chunks):
        nonlocal total
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                return
            total += len(chunk)
            _check(total <= settings["maxOutputBytes"], "OUTPUT_LIMIT")
            chunks.append(chunk)

    async def write():
        try:
            process.stdin.write(settings.get("input", "").encode("utf-8"))
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()

    tasks = [asyncio.create_task(read(process.stdout, stdout)), asyncio.create_task(read(process.stderr, stderr)),
             asyncio.create_task(write()), asyncio.create_task(process.wait())]
    exchange = asyncio.gather(*tasks)
    if signal is not None:
        signal.add_event_listener("abort", abort, once=True)
        if signal.aborted:
            abort()
    try:
        done, _ = await asyncio.wait((exchange, cancelled), timeout=settings["timeoutMs"] / 1000, return_when=asyncio.FIRST_COMPLETED)
        _check(bool(done), "TIMEOUT")
        _check(cancelled not in done, "CANCELLED")
        await exchange
        try:
            text = b"".join(stdout).decode("utf-8-sig", errors="strict")
        except UnicodeError:
            raise PluginIsolationError("RESULT_INVALID") from None
        return {"code": process.returncode, "stdout": text, "stderr": b"".join(stderr).decode("utf-8", errors="replace")}
    finally:
        if signal is not None:
            signal.remove_event_listener("abort", abort)
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if not exchange.done():
            exchange.cancel()
        await asyncio.gather(exchange, return_exceptions=True)
        await process.wait()
        cancelled.cancel()


def _verify(info, state, source):
    _check(type(info) in (dict, list), "CONFIGURATION_MISMATCH")
    host, config, mounts = (_optional(info, key) for key in ("HostConfig", "Config", "Mounts"))
    security = _optional(host, "SecurityOpt")
    drops = _optional(host, "CapDrop")
    adds = host.get("CapAdd", _UNSET) if type(host) is dict else _UNSET
    labels = _optional(config, "Labels")
    memory = state["prepared"]["grant"]["capability"]["resources"]["maxMemoryBytes"]
    _check(_optional(info, "Id") == state["id"] and _optional(info, "Image") == state["prepared"]["imageId"] and
           _optional(labels, "morivyx.run") == state["nonce"] and _optional(config, "User") == "65534:65534" and
           _optional(config, "WorkingDir") == "/input" and _optional(host, "NetworkMode") == "none" and
           _optional(host, "ReadonlyRootfs") is True and _optional(host, "Privileged") is False and
           type(drops) is list and len(drops) == 1 and type(drops[0]) is str and drops[0].upper() == "ALL" and
           (adds is None or type(adds) in (list, str) and len(adds) == 0 or
            type(adds) is dict and _zero(adds.get("length"))) and type(security) is list and len(security) == 1 and
           security[0] in ("no-new-privileges", "no-new-privileges=true") and
           type(_optional(host, "Memory")) in (int, float) and _optional(host, "Memory") == memory and
           type(_optional(host, "MemorySwap")) in (int, float) and _optional(host, "MemorySwap") == memory and
           type(_optional(host, "PidsLimit")) in (int, float) and _optional(host, "PidsLimit") == 32 and
           type(_optional(host, "NanoCpus")) in (int, float) and _optional(host, "NanoCpus") == 1000000000 and
           _optional(_optional(host, "LogConfig"), "Type") == "none" and _optional(host, "PidMode") == "" and
           _optional(host, "IpcMode") == "none" and _optional(host, "CgroupnsMode") == "private" and
           type(mounts) is list and len(mounts) == 1 and _get(mounts[0], "Type") == "bind" and
           _optional(mounts[0], "Source") == source and _optional(mounts[0], "Destination") == "/input" and
           _optional(mounts[0], "RW") is False, "CONFIGURATION_MISMATCH")


def run_plugin_container(input_value, options=_UNSET):
    """Capture caller data now, then return an awaitable container exchange.

    transport(args, settings) may return a response or an awaitable response.
    Its timeout is positive milliseconds; cleanup receives no abort signal.
    """
    prepared = _prepare(input_value)
    options = {} if options is _UNSET else options
    _check(_record(options, ("dockerPath", "transport", "signal"), ()), "OPTIONS_INVALID")
    docker_path = options.get("dockerPath")
    docker_path = "/usr/bin/docker" if docker_path is None else docker_path
    _check(type(docker_path) is str and os.path.isabs(docker_path) and "\0" not in docker_path, "OPTIONS_INVALID")
    _check("transport" not in options or callable(options["transport"]), "OPTIONS_INVALID")
    transport, signal = options.get("transport"), options.get("signal")
    _check("signal" not in options or isinstance(signal, AbortSignal), "OPTIONS_INVALID")
    _check(signal is None or not signal.aborted, "CANCELLED")
    return _run(prepared, docker_path, transport, signal)


async def _run(prepared, docker_path, injected, signal):
    root = tempfile.mkdtemp(prefix="morivyx-isolated-")
    source, config = os.path.join(root, "input"), os.path.join(root, "config")
    state = {"prepared": prepared, "nonce": str(uuid.uuid4()), "id": None, "attempted": False}
    name = "morivyx-plugin-" + state["nonce"]
    resources = prepared["grant"]["capability"]["resources"]
    deadline = time.monotonic() + resources["timeoutMs"] / 1000
    prefix = ["--host", "unix:///var/run/docker.sock", "--config", config]

    async def transport(args, settings):
        if injected is None:
            return await _invoke(docker_path, prefix + args, settings, root)
        result = injected(args, settings)
        return await result if inspect.isawaitable(result) else result

    async def control(args, cleanup=False):
        timeout = 5000 if cleanup else min(5000, int((deadline - time.monotonic()) * 1000))
        _check(timeout > 0, "TIMEOUT")
        _check(cleanup or signal is None or not signal.aborted, "CANCELLED")
        if args[:2] == ["container", "create"]:
            state["attempted"] = True
        settings = {"timeoutMs": timeout, "maxOutputBytes": 262144}
        if not cleanup and signal is not None:
            settings["signal"] = signal
        return await transport(args, settings)

    operation_error = cleanup_error = outcome = None
    try:
        _check(re.search(r"[,\x00-\x1f\x7f]", source) is None, "PATH_INVALID")
        os.mkdir(source, 0o755)
        os.mkdir(config, 0o700)
        for path, raw in prepared["files"]:
            destination = os.path.join(source, path)
            parent = source
            for part in path.split("/")[:-1]:
                parent = os.path.join(parent, part)
                try:
                    os.mkdir(parent, 0o755)
                except FileExistsError:
                    if not os.path.isdir(parent):
                        raise
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
        server = await control(["info", "--format", "{{json .}}"])
        try:
            info = json.loads(_get(server, "stdout"))
        except Exception:
            raise PluginIsolationError("UNAVAILABLE") from None
        _check(_zero(_get(server, "code")) and _optional(info, "OSType") == "linux" and
               all(_optional(info, key) is True for key in ("MemoryLimit", "SwapLimit", "PidsLimit", "CpuCfsQuota")) and
               type(_optional(info, "SecurityOptions")) is list and any(type(value) is str and value.startswith("name=seccomp")
               for value in info["SecurityOptions"]), "UNAVAILABLE")
        image = await control(["image", "inspect", prepared["imageId"], "--format", "{{.Id}}"])
        _check(_zero(_get(image, "code")) and _trim(_get(image, "stdout")) == prepared["imageId"], "IMAGE_UNAVAILABLE")
        created = await control(["container", "create", "--pull=never", "--name", name,
            "--label", "morivyx.run=" + state["nonce"], "--interactive", "--network=none", "--read-only",
            "--user", "65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
            "--memory", str(resources["maxMemoryBytes"]), "--memory-swap", str(resources["maxMemoryBytes"]),
            "--pids-limit=32", "--cpus=1", "--ipc=none", "--cgroupns=private", "--log-driver=none", "--workdir=/input",
            "--mount", "type=bind,source=" + source + ",target=/input,readonly,bind-propagation=rprivate",
            "--env", GRANT_ENV + "=" + prepared["grantText"], prepared["imageId"]])
        _check(_zero(_get(created, "code")) and _CONTAINER.fullmatch(_trim(_get(created, "stdout"))) is not None, "CREATE_FAILED")
        state["id"] = _trim(created["stdout"])
        inspected = await control(["container", "inspect", state["id"]])
        _check(_zero(_get(inspected, "code")), "CONFIGURATION_MISMATCH")
        try:
            info = json.loads(_get(inspected, "stdout"))[0]
        except Exception:
            raise PluginIsolationError("CONFIGURATION_MISMATCH") from None
        _verify(info, state, source)
        remaining = int((deadline - time.monotonic()) * 1000)
        _check(remaining > 0, "TIMEOUT")
        _check(signal is None or not signal.aborted, "CANCELLED")
        settings = {"input": prepared["requestText"], "timeoutMs": remaining, "maxOutputBytes": resources["maxOutputBytes"]}
        if signal is not None:
            settings["signal"] = signal
        executed = await transport(["container", "start", "--attach", "--interactive", state["id"]], settings)
        _check(_zero(_get(executed, "code")), "RUN_FAILED")
        text = _trim(_get(executed, "stdout"))
        _check(bool(text) and "\n" not in text, "RESULT_INVALID")
        try:
            result = validate_plugin_run_result(json.loads(text), prepared["request"])
        except Exception:
            raise PluginIsolationError("RESULT_INVALID") from None
        outcome = {"format": PLUGIN_ISOLATED_RUN_FORMAT, "result": result, "isolation": {
            "backend": "docker", "imageId": prepared["imageId"], "containerId": state["id"], "network": "none",
            "rootFilesystem": "read-only", "inputFilesystem": "read-only", "uid": 65534, "gid": 65534,
            "capabilities": [], "noNewPrivileges": True, "memoryBytes": resources["maxMemoryBytes"],
            "pidsLimit": 32, "cpuLimit": 1, "containerRemoved": True}}
    except Exception as error:
        if isinstance(error, OSError):
            error.code = errno.errorcode.get(error.errno, "UNKNOWN")
            error.path = error.filename
        operation_error = error
    finally:
        try:
            if state["attempted"]:
                if state["id"] is None:
                    listed = await control(["container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"], True)
                    _check(_zero(_get(listed, "code")), "CLEANUP_FAILED")
                    _check(_CONTAINER.fullmatch(_trim(_get(listed, "stdout"))) is not None, "CLEANUP_FAILED")
                    state["id"] = _trim(listed["stdout"])
                inspected = await control(["container", "inspect", state["id"]], True)
                found = json.loads(_get(inspected, "stdout"))[0] if _zero(_get(inspected, "code")) else None
                _check(_optional(found, "Id") == state["id"] and
                       _optional(_optional(found, "Config"), "Labels") is not None and
                       _optional(_optional(_optional(found, "Config"), "Labels"), "morivyx.run") == state["nonce"], "CLEANUP_FAILED")
                removed = await control(["container", "rm", "--force", "--volumes", state["id"]], True)
                _check(_zero(_get(removed, "code")), "CLEANUP_FAILED")
            try:
                shutil.rmtree(root)
            except FileNotFoundError:
                pass  # The reference force-removes its owned staging root.
        except Exception:
            cleanup_error = PluginIsolationError("CLEANUP_FAILED")
            cleanup_error.details = {"containerId": state["id"], "containerName": name, "stagingPath": root}
    if cleanup_error is not None:
        raise cleanup_error
    if operation_error is not None:
        operation_error.isolation = {"containerId": state["id"], "containerRemoved": state["id"] is not None}
        raise operation_error
    return outcome
