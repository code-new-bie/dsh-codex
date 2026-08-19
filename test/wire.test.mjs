import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startProtocolStubServer } from '../src/server.mjs';

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function createInbox(socket) {
  const queued = [];
  const waiters = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'));
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });

  socket.on('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  return {
    async next(timeoutMs = 2000) {
      if (queued.length > 0) return queued.shift();
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          waiters.push(waiter);
          timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
          }, timeoutMs);
        });
      } finally {
        clearTimeout(timer);
      }
    },

    async until(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      const seen = [];
      while (Date.now() < deadline) {
        const message = await this.next(Math.max(1, deadline - Date.now()));
        seen.push(message);
        if (predicate(message)) return { message, seen };
      }
      throw new Error('Timed out waiting for matching WebSocket message');
    }
  };
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', resolve);
    socket.close();
  });
}

test('wire: Codex-style initialize → thread → streamed turn lifecycle', async (t) => {
  const server = await startProtocolStubServer({ eventDelayMs: 2 });
  t.after(async () => server.close());

  const socket = await openSocket(server.url);
  t.after(async () => closeSocket(socket));
  const inbox = createInbox(socket);

  send(socket, {
    id: 'initialize',
    method: 'initialize',
    params: { clientInfo: { name: 'codex-tui', version: 'wire-test' } }
  });
  const initialize = await inbox.next();
  assert.equal(initialize.id, 'initialize');
  assert.equal(initialize.result.platformFamily.length > 0, true);
  assert.equal(Object.hasOwn(initialize, 'jsonrpc'), false);

  // Codex sends this after a successful initialize response. It is a notification,
  // so the server must accept it without replying.
  send(socket, { method: 'initialized' });

  for (const [id, method, expected] of [
    [1, 'account/read', (result) => result.requiresOpenaiAuth === false],
    [2, 'model/list', (result) => result.data?.[0]?.model === 'dshx-stub'],
    [3, 'configRequirements/read', (result) => result.requirements === null]
  ]) {
    send(socket, { id, method, params: {} });
    const response = await inbox.until((message) => message.id === id);
    assert.equal(expected(response.message.result), true, `${method} returned unexpected result`);
  }

  send(socket, { id: 4, method: 'thread/start', params: {} });
  const threadStart = await inbox.until((message) => message.id === 4);
  const threadId = threadStart.message.result.thread.id;
  assert.equal(typeof threadId, 'string');

  const threadStarted = await inbox.until(
    (message) => message.method === 'thread/started' && message.params?.thread?.id === threadId
  );
  assert.equal(threadStarted.message.params.thread.modelProvider, 'dsh');

  send(socket, {
    id: 5,
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: 'wire hello', text_elements: [] }]
    }
  });

  const turnResponse = await inbox.until((message) => message.id === 5);
  const turnId = turnResponse.message.result.turn.id;
  assert.equal(turnResponse.message.result.turn.status, 'inProgress');

  const events = [];
  while (true) {
    const message = await inbox.next();
    if (message.method) events.push(message);
    if (
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId
    ) break;
  }

  const methods = events.map((event) => event.method);
  assert.equal(methods[0], 'turn/started');
  assert.equal(methods[1], 'item/started');
  assert.ok(methods.includes('item/agentMessage/delta'));
  assert.equal(methods.at(-2), 'item/completed');
  assert.equal(methods.at(-1), 'turn/completed');

  const deltas = events
    .filter((event) => event.method === 'item/agentMessage/delta')
    .map((event) => event.params.delta)
    .join('');
  assert.match(deltas, /wire hello/);
});
