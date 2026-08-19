#!/usr/bin/env python3
import os
import pathlib
import subprocess
import tempfile

import pexpect

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOKEN = "dshx-pty-smoke-token-0123456789abcdefghijklmnopqrstuvwxyz"

server_env = os.environ.copy()
server_env["DSHX_STUB_TOKEN"] = TOKEN
server = subprocess.Popen(
    ["node", "bin/dshx-stub-server.mjs"],
    cwd=ROOT,
    env=server_env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)

try:
    endpoint = server.stdout.readline().strip()
    if not endpoint.startswith("ws://127.0.0.1:"):
        stderr = server.stderr.read()
        raise RuntimeError(f"stub did not produce a loopback endpoint: {endpoint!r}\n{stderr}")

    binary = ROOT / "dist" / "bin" / "dshx-tui"
    if not binary.exists():
        raise RuntimeError(f"built TUI missing: {binary}")

    with tempfile.TemporaryDirectory(prefix="dshx-codex-home-") as codex_home:
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "CODEX_HOME": codex_home,
            "DSHX_APP_SERVER_ENDPOINT": endpoint,
            "DSHX_APP_SERVER_TOKEN": TOKEN,
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
            raise AssertionError("Pinned DSHX TUI smoke failed. Transcript:\n" + "".join(transcript))
        finally:
            child.close(force=True)
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)
