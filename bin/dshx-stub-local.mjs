#!/usr/bin/env node
import fs from 'node:fs';
import { startDshxStdioTransport } from '../src/dsh/stdio-transport.mjs';
import { ProtocolStub, normalizeDispatchResult } from '../devtools/protocol-poc.mjs';

const delayMs = Number(process.env.DSHX_STUB_EVENT_DELAY_MS || 18);
const traceFile = process.env.DSHX_STUB_TRACE_FILE;
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
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) {
            trace({ direction: 'drop', method: event.method, threadId, turnId, reason: 'inactive-before-delay' });
            break;
          }
          if (delayMs > 0) await sleep(delayMs);
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) {
            trace({ direction: 'drop', method: event.method, threadId, turnId, reason: 'inactive-after-delay' });
            break;
          }
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

startDshxStdioTransport({
  ctx: { get: () => undefined },
  Adapter: LocalStubAdapter,
  diagnostics: (message) => process.stderr.write(`[dshx-stdio-stub] ${message}\n`)
});
