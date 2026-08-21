#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

import pexpect

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMPT = "你好，DSHX PTY resize"
trace_fd, trace_name = tempfile.mkstemp(prefix="dshx-protocol-trace-", suffix=".jsonl")
os.close(trace_fd)
trace_path = pathlib.Path(trace_name)
server_env = os.environ.copy()
server_env["DSHX_STUB_TRACE_FILE"] = str(trace_path)
server = subprocess.Popen(
    ["node", "bin/dshx-stub-local.mjs"],
    cwd=ROOT,
    env=server_env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)


def wait_for_protocol_notification(method, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if trace_path.exists():
            for line in trace_path.read_text(encoding="utf-8").splitlines():
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    record.get("direction") == "out"
                    and record.get("kind") == "notification"
                    and record.get("method") == method
                ):
                    if method == "thread/started" and not isinstance(record.get("threadId"), str):
                        continue
                    return
        time.sleep(0.05)
    trace = trace_path.read_text(encoding="utf-8") if trace_path.exists() else "<missing trace>"
    raise AssertionError(f"Timed out waiting for protocol notification {method!r}.\nProtocol trace:\n{trace}")


try:
    endpoint = server.stdout.readline().strip()
    if not endpoint.startswith("unix://"):
        stderr = server.stderr.read()
        raise RuntimeError(f"local stub did not produce a unix endpoint: {endpoint!r}\n{stderr}")

    binary = ROOT / "dist" / "bin" / "dshx-tui"
    if not binary.exists():
        raise RuntimeError(f"built TUI missing: {binary}")

    with tempfile.TemporaryDirectory(prefix="dshx-codex-home-") as codex_home:
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "CODEX_HOME": codex_home,
            "DSHX_APP_SERVER_ENDPOINT": endpoint,
            # pexpect provides a PTY transport, not a terminal emulator that can
            # negotiate kitty keyboard enhancement modes. Use Codex's supported
            # fallback so this gate measures TUI/local-IPC/CJK/resize behavior
            # consistently on Linux and macOS rather than terminal emulation.
            "CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT": "1",
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
            wait_for_protocol_notification("thread/started")
            child.setwinsize(40, 100)
            child.send(PROMPT)
            # With keyboard enhancement disabled, Linux PTYs report Enter as CR,
            # while the macOS pexpect/raw-PTY path requires LF to surface the same
            # KeyCode::Enter event. Keep each platform on the encoding its real
            # PTY path accepts instead of emulating a terminal protocol here.
            child.send("\n" if sys.platform == "darwin" else "\r")
            child.expect("DSHX protocol stub received:")
            transcript.append(child.before + child.after)
            child.expect(PROMPT)
            transcript.append(child.before + child.after)
        except Exception:
            transcript.append(child.before or "")
            trace = trace_path.read_text(encoding="utf-8") if trace_path.exists() else "<missing trace>"
            raise AssertionError(
                "Pinned DSHX TUI local-IPC/CJK/resize smoke failed.\n"
                f"Protocol trace:\n{trace}\n"
                "Transcript:\n" + "".join(transcript)
            )
        finally:
            child.close(force=True)
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)
    trace_path.unlink(missing_ok=True)
