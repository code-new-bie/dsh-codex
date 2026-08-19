#!/usr/bin/env node
import { startDshxLocalServer } from '../src/dsh/local-server.mjs';
import { ProtocolStub, normalizeDispatchResult } from '../src/protocol.mjs';

const delayMs = Number(process.env.DSHX_STUB_EVENT_DELAY_MS || 18);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LocalStubAdapter {
  constructor({ send, cwd }) {
    this.send = send;
    this.stub = new ProtocolStub({ cwd });
  }

  async handle(message) {
    if (message?.id === undefined) return null;
    const { response, events } = normalizeDispatchResult(this.stub, message);
    return {
      response,
      afterResponse: async () => {
        for (const event of events) {
          const threadId = event?.params?.threadId;
          const turnId = event?.params?.turnId ?? event?.params?.turn?.id;
          const belongsToActiveTurn =
            typeof threadId === 'string' &&
            typeof turnId === 'string' &&
            event.method !== 'turn/completed';
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) break;
          if (delayMs > 0) await sleep(delayMs);
          if (belongsToActiveTurn && !this.stub.isTurnActive(threadId, turnId)) break;
          this.send(event);
          if (
            event.method === 'turn/completed' &&
            typeof threadId === 'string' &&
            typeof turnId === 'string'
          ) {
            this.stub.completeTurn(threadId, turnId);
          }
        }
      }
    };
  }

  async close() {}
}

const server = await startDshxLocalServer({
  runtime: { async dispose() {} },
  Adapter: LocalStubAdapter,
  log: (message) => process.stderr.write(`[dshx-local-stub] ${message}\n`)
});
process.stdout.write(`${server.url}\n`);

async function shutdown() {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
