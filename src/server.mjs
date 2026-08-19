import { WebSocketServer } from 'ws';
import { ProtocolStub, normalizeDispatchResult } from './protocol.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_EVENT_DELAY_MS = 18;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

async function sendEvents(socket, events, delayMs, stub) {
  for (const event of events) {
    const threadId = event?.params?.threadId;
    const turnId = event?.params?.turnId ?? event?.params?.turn?.id;
    const belongsToActiveTurn =
      typeof threadId === 'string' &&
      typeof turnId === 'string' &&
      event.method !== 'turn/completed';

    if (belongsToActiveTurn && !stub.isTurnActive(threadId, turnId)) break;
    if (delayMs > 0) await sleep(delayMs);
    if (belongsToActiveTurn && !stub.isTurnActive(threadId, turnId)) break;

    sendJson(socket, event);
    if (
      event.method === 'turn/completed' &&
      typeof threadId === 'string' &&
      typeof turnId === 'string'
    ) {
      stub.completeTurn(threadId, turnId);
    }
  }
}

export async function startProtocolStubServer({
  host = DEFAULT_HOST,
  port = 0,
  cwd = process.cwd(),
  eventDelayMs = DEFAULT_EVENT_DELAY_MS,
  log = () => {}
} = {}) {
  const stub = new ProtocolStub({ cwd });
  const server = new WebSocketServer({ host, port });

  server.on('connection', (socket, request) => {
    log(`client connected from ${request.socket.remoteAddress ?? 'unknown'}`);

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        sendJson(socket, {
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${error instanceof Error ? error.message : error}`
          }
        });
        return;
      }

      // Notifications intentionally have no id and receive no response.
      if (message?.id === undefined) {
        log(`notification ${message?.method ?? '<unknown>'}`);
        return;
      }

      log(`request ${message.method} id=${String(message.id)}`);
      const { response, events } = normalizeDispatchResult(stub, message);
      sendJson(socket, response);
      if (events.length > 0) void sendEvents(socket, events, eventDelayMs, stub);
    });

    socket.on('error', (error) => log(`socket error: ${error.message}`));
  });

  await new Promise((resolve, reject) => {
    if (server.address()) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Protocol stub server did not bind a TCP address');
  }

  return {
    host,
    port: address.port,
    url: `ws://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
