from io import BufferedReader, BytesIO, RawIOBase
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from portable_cli import read_request_bytes
from stdin_transport import read_bounded_stdin


@unittest.skipUnless(os.name == "posix", "POSIX descriptor controls")
class StdinTransportTests(unittest.TestCase):
    def test_prefetched_bytes_and_original_blocking_state_are_preserved(self):
        payload = "buffered 日本語😀 and remaining bytes".encode()
        for blocking in (True, False):
            with self.subTest(blocking=blocking):
                reader, writer = os.pipe()
                os.write(writer, payload)
                os.close(writer)
                with os.fdopen(reader, "rb") as stream:
                    os.set_blocking(reader, blocking)
                    self.assertTrue(stream.peek(1))
                    self.assertEqual(stream.read(3), payload[:3])
                    self.assertEqual(read_bounded_stdin(stream, 4096), payload[3:])
                    self.assertEqual(os.get_blocking(reader), blocking)

    def test_cli_reader_waits_for_later_fragments_and_real_eof(self):
        reader, writer = os.pipe()
        source = "日本語😀 invalid suffix".encode()
        fragments = [source[:1], source[1:], None]
        active_writer = writer

        def ready(readable, writable, exceptional):
            nonlocal active_writer
            self.assertEqual((readable, writable, exceptional), ([reader], [], []))
            part = fragments.pop(0)
            if part is None:
                os.close(active_writer)
                active_writer = None
            else:
                self.assertEqual(os.write(active_writer, part), len(part))
            return readable, writable, exceptional

        try:
            with os.fdopen(reader, "rb") as stream:
                os.set_blocking(reader, False)
                with patch("stdin_transport.select.select", side_effect=ready):
                    self.assertEqual(read_request_bytes(stream), source)
                self.assertEqual(fragments, [])
                self.assertFalse(os.get_blocking(reader))
        finally:
            if active_writer is not None:
                os.close(active_writer)

    def test_limit_plus_one_leaves_the_remaining_bytes_unread(self):
        reader, writer = os.pipe()
        os.write(writer, b"abcdefTAIL")
        os.close(writer)
        with os.fdopen(reader, "rb") as stream:
            with self.assertRaises(ValueError):
                read_bounded_stdin(stream, 5)
            self.assertTrue(os.get_blocking(reader))
            self.assertEqual(stream.read1(64), b"TAIL")

    def test_read_errors_restore_the_original_descriptor_state(self):
        for blocking in (True, False):
            with self.subTest(blocking=blocking):
                reader, writer = os.pipe()
                try:
                    with os.fdopen(reader, "rb") as stream:
                        os.set_blocking(reader, blocking)
                        with patch("stdin_transport.os.read", side_effect=OSError("PRIVATE_ERROR_CONTROL")):
                            with self.assertRaises(OSError):
                                read_bounded_stdin(stream, 64)
                        self.assertEqual(os.get_blocking(reader), blocking)
                finally:
                    os.close(writer)

    def test_regular_files_and_memory_streams_keep_the_existing_reader(self):
        payload = b"explicit input bytes"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            path.write_bytes(payload)
            with path.open("rb") as stream, patch("stdin_transport.os.set_blocking", side_effect=AssertionError("not a pipe")):
                self.assertEqual(read_bounded_stdin(stream, 64), payload)
        self.assertEqual(read_bounded_stdin(BytesIO(payload), 64), payload)

    def test_custom_raw_stream_does_not_bypass_its_logical_eof(self):
        reader, writer = os.pipe()
        payload = b"PRIVATE_BORROWED_DESCRIPTOR_CONTROL"
        os.write(writer, payload)
        os.close(writer)

        class LogicalEof(RawIOBase):
            def readable(self):
                return True

            def fileno(self):
                return reader

            def readinto(self, buffer):
                return 0

        try:
            with BufferedReader(LogicalEof()) as stream:
                self.assertEqual(read_bounded_stdin(stream, 64), b"")
            self.assertEqual(os.read(reader, 64), payload)
        finally:
            os.close(reader)


if __name__ == "__main__":
    unittest.main()
