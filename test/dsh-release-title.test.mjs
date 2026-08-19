import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxReleaseAdapter } from '../src/dsh/release-adapter.mjs';
import { foldDshSessionTitle } from '../src/dsh/thread-title.mjs';

test('durable title fold is latest-wins over DSH session/title events', () => {
  assert.equal(foldDshSessionTitle([
    { type: 'session/title', data: { title: 'First' } },
    { type: 'user/message', data: {} },
    { type: 'session/title', data: { title: 'Pinned rename' } }
  ]), 'Pinned rename');
  assert.equal(foldDshSessionTitle([]), null);
});

test('thread/name/set delegates loaded rename to DSH and notifies only after RPC response', async () => {
  const adapter = Object.create(DshxReleaseAdapter.prototype);
  const sent = [];
  const agent = { id: 'session-1', session: { events: [] } };
  adapter.controllers = new Map([['session-1', { agent }]]);
  adapter.send = (message) => sent.push(message);
  adapter.driver = {
    getLive() { return undefined; },
    renameTitle(received, title) {
      assert.equal(received, agent);
      assert.equal(title, 'New title');
      return { title: 'New title', source: { kind: 'user' } };
    }
  };

  const response = await adapter.threadNameSet({ threadId: 'session-1', name: 'New title' });
  assert.deepEqual(response.result, {});
  assert.deepEqual(sent, []);
  response.afterResponse();
  assert.deepEqual(sent, [{
    method: 'thread/name/updated',
    params: { threadId: 'session-1', threadName: 'New title' }
  }]);
});

test('cold thread/name/set uses official DSH resume only for mutation lifetime', async () => {
  const adapter = Object.create(DshxReleaseAdapter.prototype);
  const agent = { id: 'session-2', session: { events: [] } };
  let disposed = 0;
  adapter.controllers = new Map();
  adapter.send = () => {};
  adapter.driver = {
    getLive() { return undefined; },
    async resume(id) {
      assert.equal(id, 'session-2');
      return { agent, async dispose() { disposed += 1; } };
    },
    renameTitle(received, title) {
      assert.equal(received, agent);
      return { title };
    }
  };

  const response = await adapter.threadNameSet({ threadId: 'session-2', name: 'Stored rename' });
  assert.equal(disposed, 1);
  assert.equal(typeof response.afterResponse, 'function');
});

test('live thread response always carries latest DSH title', () => {
  const adapter = Object.create(DshxReleaseAdapter.prototype);
  const agent = {
    id: 'session-1',
    session: { events: [{ type: 'session/title', data: { title: 'Log title' } }] }
  };
  adapter.driver = {
    currentTitle(received) {
      assert.equal(received, agent);
      return { title: 'Folded service title' };
    }
  };
  adapter.permissions = { current() { return { preset: 'workspace-write' }; } };
  Object.getPrototypeOf(DshxReleaseAdapter.prototype).threadResponse = () => {
    throw new Error('test should stub through product prototype explicitly');
  };

  const product = Object.getPrototypeOf(DshxReleaseAdapter.prototype);
  const original = product.threadResponse;
  product.threadResponse = () => ({ thread: { id: 'session-1', name: null } });
  try {
    const response = adapter.threadResponse(agent);
    assert.equal(response.thread.name, 'Folded service title');
  } finally {
    product.threadResponse = original;
  }
});

test('thread list and read enrich cold metadata with sessionQuery title snapshots', async () => {
  const adapter = Object.create(DshxReleaseAdapter.prototype);
  adapter.diagnostics = () => {};
  adapter.driver = {
    async readTitle(id) { return { title: `Title ${id}` }; }
  };
  const product = Object.getPrototypeOf(DshxReleaseAdapter.prototype);
  const originalList = product.threadList;
  const originalRead = product.threadRead;
  product.threadList = async () => ({
    result: { data: [{ id: 'a', name: null }, { id: 'b', name: null }], nextCursor: null, backwardsCursor: null }
  });
  product.threadRead = async () => ({ result: { thread: { id: 'a', name: null } } });
  try {
    const listed = await adapter.threadList({});
    assert.deepEqual(listed.result.data.map((thread) => thread.name), ['Title a', 'Title b']);
    const read = await adapter.threadRead({ threadId: 'a' });
    assert.equal(read.result.thread.name, 'Title a');
  } finally {
    product.threadList = originalList;
    product.threadRead = originalRead;
  }
});
