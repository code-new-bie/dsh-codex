import assert from 'node:assert/strict';
import test from 'node:test';
import { UiRequestBroker } from '../src/protocol/request-broker.mjs';

test('correlates a server-initiated request with a TUI response', async () => {
  const sent = [];
  const broker = new UiRequestBroker({ send: (message) => sent.push(message), timeoutMs: 1000 });
  const pending = broker.request('item/commandExecution/requestApproval', { itemId: 'item-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'item/commandExecution/requestApproval');
  assert.match(sent[0].id, /^dshx-ui-/);

  assert.equal(broker.handleResponse({ id: sent[0].id, result: { decision: 'accept' } }), true);
  assert.deepEqual(await pending, { decision: 'accept' });
  assert.equal(broker.pending.size, 0);
});

test('client errors reject only the matching request', async () => {
  const sent = [];
  const broker = new UiRequestBroker({ send: (message) => sent.push(message), timeoutMs: 1000 });
  const pending = broker.request('x', {});
  broker.handleResponse({ id: sent[0].id, error: { code: -32000, message: 'nope' } });
  await assert.rejects(pending, /nope/);
});

test('unknown client response is not consumed', () => {
  const broker = new UiRequestBroker({ send() {} });
  assert.equal(broker.handleResponse({ id: 'other', result: {} }), false);
  assert.equal(broker.handleResponse({ id: 'other', method: 'turn/start', params: {} }), false);
});

test('abort rejects the UI wait immediately', async () => {
  const controller = new AbortController();
  const broker = new UiRequestBroker({ send() {}, timeoutMs: 1000 });
  const pending = broker.request('x', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(broker.pending.size, 0);
});

test('closing transport rejects all outstanding presentation waits', async () => {
  const broker = new UiRequestBroker({ send() {}, timeoutMs: 1000 });
  const first = broker.request('a', {});
  const second = broker.request('b', {});
  broker.close('connection lost');
  await assert.rejects(first, /connection lost/);
  await assert.rejects(second, /connection lost/);
  assert.equal(broker.pending.size, 0);
});
