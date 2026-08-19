#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as pty from 'node-pty';
import { startProtocolStubServer } from '../src/server.mjs';

const TOKEN = 'dshx-conpty-smoke-token-0123456789abcdefghijklmnopqrstuvwxyz';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.platform !== 'win32') {
  throw new Error('tui_smoke_windows.mjs must run on Windows/ConPTY');
}

const binary = path.join(process.cwd(), 'dist', 'bin', 'dshx-tui.exe');
if (!fs.existsSync(binary)) throw new Error(`built DSHX TUI missing: ${binary}`);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-conpty-home-'));
const server = await startProtocolStubServer({ token: TOKEN, eventDelayMs: 8 });
let term;
let dataDisposable;
try {
  term = pty.spawn(binary, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: process.cwd(),
    env: stringEnv({
      TERM: 'xterm-256color',
      CODEX_HOME: codexHome,
      DSHX_APP_SERVER_ENDPOINT: server.url,
      DSHX_APP_SERVER_TOKEN: TOKEN
    })
  });
  const state = { output: '' };
  dataDisposable = term.onData((chunk) => { state.output += chunk; });

  await waitForOutput(state, 'DeepSeek Harness');
  term.write('smoke from conpty\r');
  await waitForOutput(state, 'DSHX protocol stub received:');
  await waitForOutput(state, 'smoke from conpty');
  process.stdout.write('Windows ConPTY DSHX TUI smoke passed\n');
} finally {
  dataDisposable?.dispose?.();
  try { term?.kill(); } catch {}
  // Let the killed TUI close its WebSocket before asking ws.Server.close() to
  // wait for all clients; this keeps failures bounded on busy hosted runners.
  await sleep(100);
  await server.close();
  fs.rmSync(codexHome, { recursive: true, force: true });
}
