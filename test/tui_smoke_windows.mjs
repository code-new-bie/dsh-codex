#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as pty from 'node-pty';

const PROMPT = 'smoke 中文 输入 from conpty';

function stripTerminalControl(value) {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function stringEnv(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra })
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );
}

function waitForOutput(state, needle, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const transcript = stripTerminalControl(state.output);
      if (transcript.includes(needle)) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() - started < timeoutMs) return;
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${JSON.stringify(needle)}. Transcript:\n${transcript}`));
    }, 50);
  });
}

if (process.platform !== 'win32') {
  throw new Error('tui_smoke_windows.mjs must run on Windows/ConPTY');
}

const root = process.cwd();
const binary = path.join(root, 'dist', 'bin', 'dshx-tui.exe');
const stub = path.join(root, 'bin', 'dshx-stub-stdio.mjs');
if (!fs.existsSync(binary)) throw new Error(`built DSHX TUI missing: ${binary}`);
if (!fs.existsSync(stub)) throw new Error(`DSHX stdio stub missing: ${stub}`);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-conpty-home-'));
let term;
let dataDisposable;
try {
  term = pty.spawn(binary, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: root,
    env: stringEnv({
      TERM: 'xterm-256color',
      CODEX_HOME: codexHome,
      DSHX_APP_SERVER_PROGRAM: process.execPath,
      DSHX_APP_SERVER_SCRIPT: stub,
      DSHX_STUB_EVENT_DELAY_MS: '8'
    })
  });
  const state = { output: '' };
  dataDisposable = term.onData((chunk) => { state.output += chunk; });

  await waitForOutput(state, 'DeepSeek Harness');
  // ConPTY resize plus a real UTF-8 CJK prompt catches width/input regressions
  // that ASCII-only protocol tests cannot see.
  term.resize(100, 40);
  term.write(`${PROMPT}\r`);
  await waitForOutput(state, 'DSHX protocol stub received:');
  await waitForOutput(state, PROMPT);
  process.stdout.write('Windows ConPTY DSHX stdio/CJK/resize smoke passed\n');
} finally {
  dataDisposable?.dispose?.();
  try { term?.kill(); } catch {}
  fs.rmSync(codexHome, { recursive: true, force: true });
}
