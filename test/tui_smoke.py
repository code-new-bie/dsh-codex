#!/usr/bin/env python3
import os
import pathlib
import shutil
import tempfile

import pexpect

ROOT = pathlib.Path(__file__).resolve().parents[1]

binary = ROOT / "dist" / "bin" / "dshx-tui"
if not binary.exists():
    raise RuntimeError(f"built TUI missing: {binary}")
node = shutil.which("node")
if not node:
    raise RuntimeError("node executable not found for DSHX stdio smoke")
stub = ROOT / "bin" / "dshx-stub-stdio.mjs"
if not stub.exists():
    raise RuntimeError(f"stdio stub missing: {stub}")

with tempfile.TemporaryDirectory(prefix="dshx-codex-home-") as codex_home:
    env = os.environ.copy()
    env.update({
        "TERM": "xterm-256color",
        "CODEX_HOME": codex_home,
        "DSHX_APP_SERVER_PROGRAM": node,
        "DSHX_APP_SERVER_SCRIPT": str(stub),
        "DSHX_STUB_EVENT_DELAY_MS": "8",
    })
    child = pexpect.spawn(
        str(binary),
        cwd=str(ROOT),
        env=env,
        encoding="utf-8",
        timeout=30,
        dimensions=(32, 120),
    )
    transcript = []
    try:
        child.expect("DeepSeek Harness")
        transcript.append(child.before + child.after)
        child.send("smoke from pty\r")
        child.expect("DSHX protocol stub received:")
        transcript.append(child.before + child.after)
        child.expect("smoke from pty")
        transcript.append(child.before + child.after)
    except Exception:
        transcript.append(child.before or "")
        raise AssertionError("Pinned DSHX stdio TUI smoke failed. Transcript:\n" + "".join(transcript))
    finally:
        child.close(force=True)
