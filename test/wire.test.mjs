import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolStub, normalizeDispatchResult } from '../devtools/protocol-poc.mjs';

function dispatch(stub, message) {
  return normalizeDispatchResult(stub, message);
}

function request(stub, id, method, params = {}) {
  const { response, events } = dispatch(stub, { id, method, params });
  assert.equal(response?.id, id, `${method} must preserve the request id`);
  return { response, events };
}

test('wire contract: Codex-style initialize → thread → streamed turn lifecycle', () => {
  const stub = new ProtocolStub({ cwd: process.cwd() });

  const initialized = request(stub, 'initialize', 'initialize', {
    clientInfo: { name: 'codex-tui', version: 'wire-test' }
  });
  assert.equal(initialized.response.result.platformFamily.length > 0, true);
  assert.equal(Object.hasOwn(initialized.response, 'jsonrpc'), false);
  assert.match(initialized.response.result.userAgent, /^dshx\//);

  // Codex sends this notification after initialize. The protocol fixture must
  // accept it without synthesizing a response or a transport-level side effect.
  const notification = dispatch(stub, { method: 'initialized' });
  assert.equal(notification.response ?? null, null);
  assert.deepEqual(notification.events, []);

  for (const [id, method, expected] of [
    [1, 'account/read', (result) => result.requiresOpenaiAuth === false],
    [2, 'model/list', (result) => result.data?.[0]?.model === 'dshx-stub'],
    [3, 'configRequirements/read', (result) => result.requirements === null]
  ]) {
    const { response } = request(stub, id, method);
    assert.equal(expected(response.result), true, `${method} returned unexpected result`);
  }

  const started = request(stub, 4, 'thread/start');
  const threadId = started.response.result.thread.id;
  assert.equal(typeof threadId, 'string');
  const threadStarted = started.events.find(
    (event) => event.method === 'thread/started' && event.params?.thread?.id === threadId
  );
  assert.ok(threadStarted, 'thread/start must emit thread/started');
  assert.equal(threadStarted.params.thread.modelProvider, 'dsh');

  const accepted = request(stub, 5, 'turn/start', {
    threadId,
    input: [{ type: 'text', text: 'wire hello', text_elements: [] }]
  });
  const turnId = accepted.response.result.turn.id;
  assert.equal(accepted.response.result.turn.status, 'inProgress');

  const events = accepted.events;
  const methods = events.map((event) => event.method);
  assert.equal(methods[0], 'turn/started');
  assert.equal(methods[1], 'item/started');
  assert.ok(methods.includes('item/agentMessage/delta'));
  assert.equal(methods.at(-2), 'item/completed');
  assert.equal(methods.at(-1), 'turn/completed');
  assert.equal(events.at(-1)?.params?.threadId, threadId);
  assert.equal(events.at(-1)?.params?.turn?.id, turnId);

  const deltas = events
    .filter((event) => event.method === 'item/agentMessage/delta')
    .map((event) => event.params.delta)
    .join('');
  assert.match(deltas, /wire hello/);
});
