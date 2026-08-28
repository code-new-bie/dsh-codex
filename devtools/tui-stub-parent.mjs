#!/usr/bin/env node
/** Deterministic presentation-only parent for PTY/ConPTY tests.
 *
 * This intentionally mirrors the production process ownership: the parent owns
 * the protocol adapter and launches only the native TUI child. Child fd0 is the
 * parent->TUI protocol pipe, fd3 preserves the terminal input handle, and fd4 is
 * the TUI->parent protocol pipe. No listener, socket, bridge, or backend child is
 * created by the TUI.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDshxStdioTransport } from '../src/dsh/stdio-transport.mjs';
import { ProtocolStub, normalizeDispatchResult } from './protocol-poc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delayMs = Number(process.env.DSHX_STUB_EVENT_DELAY_MS || 18);
const traceFile = process.env.DSHX_STUB_TRACE_FILE;
const binary = process.env.DSHX_TUI_BIN || path.join(ROOT, 'dist', 'bin', process.platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trace(record) {
  if (!traceFile) return;
  fs.appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...record })}\n`, 'utf8');
}

class LocalStubAdapter {
  constructor({ send, cwd }) {
    this.send = send;
    this.stub = new ProtocolStub({ cwd });
  }

  async handle(message) {
    if (message?.id === undefined) {
      trace({ direction: 'in', kind: 'notification', method: message?.method ?? null });
      return null;
    }
    trace({ direction: 'in', kind: 'request', id: message.id, method: message?.method ?? null });
    const { response, events } = normalizeDispatchResult(this.stub, message);
    return {
      response,
      afterResponse: async () => {
        trace({
          direction: 'out',
          kind: response?.error ? 'error' : 'response',
          id: response?.id ?? null,
          method: message?.method ?? null,
          error: response?.error?.message ?? null
        });
        for (const event of events) {
          const threadId = event?.params?.threadId ?? event?.params?.thread?.id;
          const turnId = event?.params?.turnId ?? event?.params?.turn?.id;
          const belongsToActiveTurn = typeof threadId === 'string'
            && typeof turnId === 'string'
            && event.method !== 'turn/completed';
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) break;
          if (delayMs > 0) await sleep(delayMs);
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) break;
          this.send(event);
          trace({ direction: 'out', kind: 'notification', method: event.method, threadId: threadId ?? null, turnId: turnId ?? null });
          if (event.method === 'turn/completed' && typeof threadId === 'string' && typeof turnId === 'string') {
            this.stub.completeTurn(threadId, turnId);
          }
        }
      }
    };
  }

  async close() {}
}

if (!fs.existsSync(binary)) throw new Error(`DSHX TUI binary not found: ${binary}`);
const child = spawn(binary, process.argv.slice(2), {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSHX_APP_SERVER_INPUT_FD: '0',
    DSHX_TERMINAL_INPUT_FD: '3',
    DSHX_APP_SERVER_OUTPUT_FD: '4'
  },
  stdio: ['pipe', 'inherit', 'inherit', 0, 'pipe'],
  windowsHide: false
});
const protocolOutput = child.stdio?.[4];
if (!child.stdin || !protocolOutput) throw new Error('directional TUI protocol pipes were not created');

const transport = startDshxStdioTransport({
  ctx: { get: () => undefined },
  Adapter: LocalStubAdapter,
  cwd: process.cwd(),
  input: protocolOutput,
  output: child.stdin,
  diagnostics: (message) => process.env.DSHX_DEBUG === '1' && process.stderr.write(`[dshx-stub-parent] ${message}\n`)
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await transport.close(); } catch {}
  if (child.exitCode == null && child.signalCode == null) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

child.once('error', (error) => {
  process.stderr.write(`[dshx-stub-parent] native TUI spawn failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  void transport.close().finally(() => {
    process.exitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
  });
});
process.once('SIGTERM', () => { void close(); });
