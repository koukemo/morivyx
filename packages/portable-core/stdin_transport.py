"""Collect bounded input without blocking reads on POSIX pipes and sockets.

The caller owns the stream and its descriptor for the duration of the read.
Existing buffered bytes are consumed first; descriptor flags are restored.
"""

import io
import os
import select
import stat


def _pollable_descriptor(stream):
    if os.name != "posix" or type(stream) is not io.BufferedReader or type(stream.raw) is not io.FileIO:
        return None
    try:
        descriptor = stream.fileno()
        mode = os.fstat(descriptor).st_mode
    except (OSError, ValueError):
        return None
    return descriptor if stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) else None


def read_bounded_stdin(stream, limit):
    if type(limit) is not int or limit < 0:
        raise ValueError("invalid input limit")
    descriptor = _pollable_descriptor(stream)
    previous = None
    if descriptor is not None:
        previous = os.get_blocking(descriptor)
        os.set_blocking(descriptor, False)
    remaining, data = limit + 1, bytearray()
    try:
        while remaining:
            size = min(65536, remaining)
            try:
                chunk = stream.read1(size)
                if not chunk and descriptor is not None:
                    # BufferedReader.read1 can return b'' for would-block too.
                    # Its buffer is now empty; raw read distinguishes EOF.
                    chunk = os.read(descriptor, size)
            except BlockingIOError:
                if descriptor is None:
                    raise
                select.select([descriptor], [], [])
                continue
            if not chunk:
                break
            data.extend(chunk)
            remaining -= len(chunk)
        if remaining == 0:
            raise ValueError("request exceeds limit")
        return bytes(data)
    finally:
        if descriptor is not None:
            os.set_blocking(descriptor, previous)
