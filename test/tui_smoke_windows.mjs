#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import * as pty from 'node-pty';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_NODE_PTY_VERSION = '1.2.0-beta.15';

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
      if (Date.now() - started < timeoutMs) return;
      clearInterval(poll);
      const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '<missing trace>';
      reject(new Error(`Timed out waiting for protocol notification ${JSON.stringify(method)}.\nProtocol trace:\n${trace}`));
    }, 50);
  });
}

function firstLine(stream, child, stderrText, timeoutMs = 15_000) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for local IPC stub: ${stderrText()}`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error) => {
      cleanup();
      lines.close();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => fail(new Error(`local IPC stub exited before ready (${signal ?? code ?? 'unknown'}): ${stderrText()}`));
    child.once('error', onError);
    child.once('exit', onExit);
    lines.once('line', (line) => {
      cleanup();
      lines.close();
      resolve(line);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = new Promise((resolve) => setTimeout(resolve, 5_000, 'timeout'));
  if (await Promise.race([exited.then(() => 'exit'), timer]) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

if (process.platform !== 'win32') {
  throw new Error('tui_smoke_windows.mjs must run on Windows/ConPTY');
}

const nodePtyPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'node-pty', 'package.json'), 'utf8'));
if (nodePtyPackage.version !== EXPECTED_NODE_PTY_VERSION) {
  throw new Error(
    `Windows ConPTY smoke must use frozen node-pty ${EXPECTED_NODE_PTY_VERSION}; got ${nodePtyPackage.version}`
  );
}

const binary = path.join(ROOT, 'dist', 'bin', 'dshx-tui.exe');
const bridge = path.join(ROOT, 'dist', 'bin', 'dshx-ipc-bridge.exe');
if (!fs.existsSync(binary)) throw new Error(`built DSHX TUI missing: ${binary}`);
if (!fs.existsSync(bridge)) throw new Error(`built DSHX IPC bridge missing: ${bridge}`);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-conpty-home-'));
const traceFile = path.join(os.tmpdir(), `dshx-conpty-trace-${process.pid}-${Date.now()}.jsonl`);
let server;
let serverStderr = '';
let term;
let dataDisposable;
try {
  server = spawn(process.execPath, [path.join(ROOT, 'bin', 'dshx-stub-local.mjs')], {
    cwd: ROOT,
    env: stringEnv({ DSHX_IPC_BRIDGE_BIN: bridge, DSHX_STUB_TRACE_FILE: traceFile }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stderr.on('data', (chunk) => {
    serverStderr = `${serverStderr}${chunk.toString('utf8')}`.slice(-8192);
  });
  const endpoint = await firstLine(server.stdout, server, () => serverStderr);
  if (!endpoint.startsWith('unix://')) {
    throw new Error(`local IPC stub returned non-local endpoint ${JSON.stringify(endpoint)}: ${serverStderr}`);
  }

  term = pty.spawn(binary, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: ROOT,
    env: stringEnv({
      TERM: 'xterm-256color',
      CODEX_HOME: codexHome,
      DSHX_APP_SERVER_ENDPOINT: endpoint,
      // node-pty provides a ConPTY transport, not a terminal emulator capable
      // of negotiating Codex's keyboard enhancement protocol. Use Codex's
      // supported fallback and exercise canonical terminal key bytes instead.
      CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1'
    })
  });
  const state = { output: '' };
  dataDisposable = term.onData((chunk) => { state.output += chunk; });

  await waitForOutput(state, 'DeepSeek Harness');
  await waitForProtocolNotification(traceFile, 'thread/started');
  // thread/started precedes the asynchronous model/banner refresh. Wait for
  // the deterministic stub model to render before touching the composer so
  // startup cannot reset input that the ConPTY harness has already injected.
  await waitForOutput(state, 'dshx-stub');
  term.resize(100, 40);
  const prompt = '你好，DSHX ConPTY resize';
  // Exercise the keyboard path like a user rather than injecting one
  // paste-like burst. Codex intentionally suppresses Enter after detected
  // paste input; this smoke validates CJK keyboard input, submit and resize.
  for (const char of prompt) {
    term.write(char);
    await sleep(20);
  }
  await waitForOutput(state, prompt);
  await sleep(100);
  term.write('\r');
  await waitForOutput(state, 'DSHX protocol stub received:');
  await waitForOutput(state, prompt);
  process.stdout.write('Windows ConPTY DSHX local-IPC + CJK + resize smoke passed\n');
} finally {
  dataDisposable?.dispose?.();
  try { term?.kill(); } catch {}
  // Give ConPTY/TUI a bounded moment to close the local socket cleanly before
  // terminating the deterministic adapter process.
  await sleep(100);
  await stopChild(server);
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(traceFile, { force: true });
}
