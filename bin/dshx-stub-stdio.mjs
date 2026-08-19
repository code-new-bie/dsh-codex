#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';
import { ProtocolStub, normalizeDispatchResult } from '../src/protocol.mjs';

const eventDelayMs = Number(process.env.DSHX_STUB_EVENT_DELAY_MS ?? 8);
const stub = new ProtocolStub({ cwd: process.cwd() });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function sendEvents(events) {
  for (const event of events) {
    const threadId = event?.params?.threadId;
    const turnId = event?.params?.turnId ?? event?.params?.turn?.id;
    const belongsToActiveTurn =
      typeof threadId === 'string' &&
      typeof turnId === 'string' &&
      event.method !== 'turn/completed';

    if (belongsToActiveTurn && !stub.isTurnActive(threadId, turnId)) break;
    if (eventDelayMs > 0) await sleep(eventDelayMs);
    if (belongsToActiveTurn && !stub.isTurnActive(threadId, turnId)) break;
    send(event);
    if (
      event.method === 'turn/completed' &&
      typeof threadId === 'string' &&
      typeof turnId === 'string'
    ) {
      stub.completeTurn(threadId, turnId);
    }
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${error instanceof Error ? error.message : String(error)}`
      }
    });
    continue;
  }

  if (message?.id === undefined) continue;
  const { response, events } = normalizeDispatchResult(stub, message);
  send(response);
  if (events.length > 0) void sendEvents(events);
}
