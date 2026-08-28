#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_NODE_PTY_VERSION = '1.2.0-beta.15';
const EXPECTED_TUI_VERSION = process.env.DSHX_VERSION ?? '1.0.0-ci';
const EXPECTED_MODEL_DISPLAY_NAME = 'DSHX Protocol Stub';

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
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for ${JSON.stringify(needle)}. Transcript:\n${transcript}`));
      }
    }, 50);
  });
}

function waitForProtocolNotification(traceFile, method, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (fs.existsSync(traceFile)) {
        for (const line of fs.readFileSync(traceFile, 'utf8').split(/\r?\n/)) {
          if (!line) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (
            record.direction === 'out' &&
            record.kind === 'notification' &&
            record.method === method &&
            (method !== 'thread/started' || typeof record.threadId === 'string')
          ) {
            clearInterval(poll);
            resolve();
            return;
          }
        }
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(poll);
        const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '<missing trace>';
        reject(new Error(`Timed out waiting for protocol notification ${JSON.stringify(method)}.\nProtocol trace:\n${trace}`));
      }
    }, 50);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (process.platform !== 'win32') throw new Error('tui_smoke_windows.mjs must run on Windows/ConPTY');
const nodePtyPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'node-pty', 'package.json'), 'utf8'));
if (nodePtyPackage.version !== EXPECTED_NODE_PTY_VERSION) {
  throw new Error(`Windows ConPTY smoke must use frozen node-pty ${EXPECTED_NODE_PTY_VERSION}; got ${nodePtyPackage.version}`);
}

const binary = path.join(ROOT, 'dist', 'bin', 'dshx-tui.exe');
if (!fs.existsSync(binary)) throw new Error(`built DSHX TUI missing: ${binary}`);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-conpty-home-'));
const traceFile = path.join(os.tmpdir(), `dshx-conpty-trace-${process.pid}-${Date.now()}.jsonl`);
let term;
let dataDisposable;
try {
  term = pty.spawn(process.execPath, [path.join(ROOT, 'devtools', 'tui-stub-parent.mjs')], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: ROOT,
    env: stringEnv({
      TERM: 'xterm-256color',
      CODEX_HOME: codexHome,
      DSHX_TUI_BIN: binary,
      DSHX_STUB_TRACE_FILE: traceFile,
      CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1'
    })
  });
  const state = { output: '' };
  dataDisposable = term.onData((chunk) => { state.output += chunk; });

  await waitForOutput(state, `DeepSeek Harness (v${EXPECTED_TUI_VERSION})`);
  await waitForProtocolNotification(traceFile, 'thread/started');
  await waitForOutput(state, EXPECTED_MODEL_DISPLAY_NAME);
  const startupTranscript = stripTerminalControl(state.output);
  if (startupTranscript.includes('v0.0.0')) {
    throw new Error(`Codex crate version leaked into DSHX startup presentation:\n${startupTranscript}`);
  }
  if (startupTranscript.includes('dshx:Wy')) {
    throw new Error(`opaque DSHX model wire id leaked into TUI presentation:\n${startupTranscript}`);
  }

  term.resize(100, 40);
  const prompt = '你好，DSHX ConPTY resize';
  term.write(prompt);
  await sleep(250);
  term.write('\r');
  await waitForOutput(state, 'DSHX protocol stub received:');
  await waitForOutput(state, prompt);
  process.stdout.write('Windows ConPTY DSHX directional stdio + CJK + resize smoke passed\n');
} finally {
  dataDisposable?.dispose?.();
  try { term?.kill(); } catch {}
  await sleep(100);
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(traceFile, { force: true });
}
