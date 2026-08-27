#!/usr/bin/env python3
import json
import os
import pathlib
import tempfile
import time

import pexpect

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMPT = "你好，DSHX PTY resize"
PROMPT_TOKENS = ("你", "好", "，", "DSHX", "PTY", "resize")
EXPECTED_TUI_VERSION = os.environ.get("DSHX_VERSION", "1.0.0-ci")
EXPECTED_MODEL_DISPLAY_NAME = "DSHX Protocol Stub"
trace_fd, trace_name = tempfile.mkstemp(prefix="dshx-protocol-trace-", suffix=".jsonl")
os.close(trace_fd)
trace_path = pathlib.Path(trace_name)


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


def expect_rendered_tokens(child, tokens):
    rendered = []
    for token in tokens:
        child.expect_exact(token)
        rendered.append(child.before + child.after)
    return "".join(rendered)


try:
    binary = ROOT / "dist" / "bin" / "dshx-tui"
    if not binary.exists():
        raise RuntimeError(f"built TUI missing: {binary}")

    with tempfile.TemporaryDirectory(prefix="dshx-codex-home-") as codex_home:
        env = os.environ.copy()
        env.update({
            "TERM": "xterm-256color",
            "CODEX_HOME": codex_home,
            "DSHX_STUB_TRACE_FILE": str(trace_path),
            "DSHX_APP_SERVER_CMD": json.dumps([
                os.environ.get("NODE", "node"),
                str(ROOT / "bin" / "dshx-stub-local.mjs"),
            ]),
            # pexpect is a PTY transport rather than a full terminal emulator.
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
            child.expect(f"v{EXPECTED_TUI_VERSION}")
            transcript.append(child.before + child.after)
            wait_for_protocol_notification("thread/started")
            child.expect(EXPECTED_MODEL_DISPLAY_NAME)
            transcript.append(child.before + child.after)
            rendered_startup = "".join(transcript)
            if "v0.0.0" in rendered_startup:
                raise AssertionError("Codex crate version leaked into DSHX startup presentation:\n" + rendered_startup)
            if "dshx:Wy" in rendered_startup:
                raise AssertionError("opaque DSHX model wire id leaked into TUI presentation:\n" + rendered_startup)

            child.setwinsize(40, 100)
            child.send(PROMPT)
            transcript.append(expect_rendered_tokens(child, PROMPT_TOKENS))
            time.sleep(0.25)
            child.send("\r")
            child.expect_exact("received:")
            transcript.append(child.before + child.after)
            transcript.append(expect_rendered_tokens(child, PROMPT_TOKENS))
        except Exception:
            transcript.append(child.before or "")
            trace = trace_path.read_text(encoding="utf-8") if trace_path.exists() else "<missing trace>"
            raise AssertionError(
                "Pinned DSHX TUI stdio/CJK/resize smoke failed.\n"
                f"Protocol trace:\n{trace}\n"
                "Transcript:\n" + "".join(transcript)
            )
        finally:
            child.close(force=True)
finally:
    trace_path.unlink(missing_ok=True)
