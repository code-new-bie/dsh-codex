import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startDshxLocalServer } from '../src/dsh/local-server.mjs';

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyz-DSHX-token';

function once(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
  });
}

class FakeAdapter {
  static closes = 0;
  constructor({ send }) {
    this.send = send;
  }
  async handle(message) {
    return { response: { id: message.id, result: { echoed: message.method } } };
  }
  async close() {
    FakeAdapter.closes += 1;
  }
}

test('local server rejects unauthenticated WebSocket clients', async () => {
  const runtime = { async dispose() {} };
  const server = await startDshxLocalServer({ runtime, token: TOKEN, Adapter: FakeAdapter });
  try {
    const socket = new WebSocket(server.url);
    const status = await new Promise((resolve) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('error', () => {});
    });
    assert.equal(status, 401);
    socket.terminate();
  } finally {
    await server.close();
  }
});

test('local server accepts bearer-authenticated RPC and disposes presentation/runtime state', async () => {
  let disposed = 0;
  FakeAdapter.closes = 0;
  const runtime = { async dispose() { disposed += 1; } };
  const server = await startDshxLocalServer({ runtime, token: TOKEN, Adapter: FakeAdapter });
  const socket = new WebSocket(server.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await once(socket, 'open');

  const response = new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString('utf8'))); } catch (error) { reject(error); }
    });
  });
  socket.send(JSON.stringify({ id: 7, method: 'initialize', params: {} }));
  assert.deepEqual(await response, { id: 7, result: { echoed: 'initialize' } });

  socket.close();
  await once(socket, 'close');
  await server.close();
  assert.equal(FakeAdapter.closes, 1);
  assert.equal(disposed, 1);
});

test('local server permits only one active TUI client', async () => {
  const runtime = { async dispose() {} };
  const server = await startDshxLocalServer({ runtime, token: TOKEN, Adapter: FakeAdapter });
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const first = new WebSocket(server.url, { headers });
  await once(first, 'open');
  const second = new WebSocket(server.url, { headers });
  await once(second, 'open');
  const [code] = await once(second, 'close');
  assert.equal(code, 1008);
  first.close();
  await once(first, 'close');
  await server.close();
});
