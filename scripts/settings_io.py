#!/usr/bin/env python3
"""Bounded, symlink-safe read/write for the plugin's settings file.

The settings path is fixed and predictable
(~/.local/state/omarchy/settings/mawaqit-times.json), so QML doesn't open it
directly: O_NOFOLLOW keeps a symlink planted there from being read through or
written through, O_NONBLOCK plus an upfront regular-file check keeps a FIFO
planted there from blocking the read, and a size cap bounds memory use.
Writes go through a temp file + atomic rename, which replaces whatever inode
(file, symlink, or FIFO) currently sits at the destination without ever
opening it.

Usage:
  settings_io.py read <path>
  settings_io.py write <path>      (content: one line on stdin)

The content to write comes in on stdin, terminated by a newline, rather than
as an argument: a process's argv is readable by every local user through
/proc/<pid>/cmdline and ps, and the settings hold the user's mosques. The
caller sends compact JSON (JSON.stringify output), which never contains a
raw newline, so the first line is the whole document.

Prints a single JSON object to stdout and always exits 0, mirroring
mawaqit_times.py, so the caller can rely on stdout alone.
"""

import errno
import json
import os
import stat
import sys

MAX_BYTES = 1024 * 1024  # settings are a small JSON blob; 1 MiB is generous


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(0)


def do_read(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno == errno.ENOENT:
            print(json.dumps({"ok": True, "exists": False, "text": ""}))
            return
        fail(f"could not open settings file: {e.strerror}")

    chunks = []
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            fail("settings path is not a regular file")

        total = 0
        while total <= MAX_BYTES:
            want = min(65536, MAX_BYTES - total + 1)
            try:
                chunk = os.read(fd, want)
            except BlockingIOError:
                break
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > MAX_BYTES:
            fail("settings file is too large")
    finally:
        os.close(fd)

    text = b"".join(chunks).decode("utf-8", "replace")
    print(json.dumps({"ok": True, "exists": True, "text": text}))


def read_content_line():
    """The settings document from stdin: one newline-terminated line, at most
    MAX_BYTES long. Bounded the same way the file read is, and a missing
    newline (truncated or oversized input) is an error, not a partial write."""
    line = sys.stdin.buffer.readline(MAX_BYTES + 1)
    if not line.endswith(b"\n"):
        fail("settings content is too large" if len(line) > MAX_BYTES else "settings content was incomplete")
    return line[:-1]


def do_write(path, raw):

    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp{os.getpid()}"
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            os.replace(tmp_path, path)
        except OSError:
            os.unlink(tmp_path)
            raise
    except OSError as e:
        fail(f"could not write settings file: {e.strerror}")

    print(json.dumps({"ok": True}))


def main():
    if len(sys.argv) < 3:
        fail("Usage: settings_io.py <read|write> <path>")

    action, path = sys.argv[1], sys.argv[2]
    if action == "read":
        if len(sys.argv) != 3:
            fail("read takes only <path>")
        do_read(path)
    elif action == "write":
        if len(sys.argv) != 3:
            fail("write takes only <path>; the content comes on stdin")
        do_write(path, read_content_line())
    else:
        fail(f"Unknown action '{action}'")


if __name__ == "__main__":
    main()
