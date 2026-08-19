import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxProductAdapter } from '../src/dsh/product-adapter.mjs';

function bareAdapter() {
  const adapter = Object.create(DshxProductAdapter.prototype);
  adapter.cwd = '/workspace';
  adapter.controllers = new Map();
  adapter.diagnostics = () => {};
  adapter.send = () => {};
  return adapter;
}

test('manual compaction delegates to DSH commands.execute and does not own compaction semantics', async () => {
  const adapter = bareAdapter();
  const calls = [];
  const warnings = [];
  adapter.warnThread = (threadId, message) => warnings.push([threadId, message]);
  const commands = {
    async execute(agent, line, signal) {
      calls.push({ agent, line, signal });
      return { result: { kind: 'success', text: 'No compactable history yet.' } };
    }
  };
  const agent = {
    ctx: { get(name) { return name === 'commands' ? commands : undefined; } }
  };
  const abortController = new AbortController();
  adapter._manualCompactions = new Map([['session-1', abortController]]);

  await adapter.runManualCompaction({
    threadId: 'session-1',
    controller: { agent },
    abortController
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, agent);
  assert.equal(calls[0].line, '/compact');
  assert.equal(calls[0].signal, abortController.signal);
  assert.deepEqual(warnings, [['session-1', 'No compactable history yet.']]);
  assert.equal(adapter._manualCompactions.size, 0);
});

test('thread/fork passes only a presentation anchor to official DSH Host fork', async () => {
  const adapter = bareAdapter();
  const hostCalls = [];
  const sourceEvents = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'u1' } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  const childAgent = { id: 'child-session', session: { events: [], header: { id: 'child-session' } } };

  adapter.forkSourceEvents = async (sourceId) => {
    assert.equal(sourceId, 'source-session');
    return sourceEvents;
  };
  adapter.hostApi = () => ({
    async forkSession(request) {
      hostCalls.push(request);
      return { sessionId: 'child-session' };
    }
  });
  adapter.driver = {
    getLive(sessionId) {
      assert.equal(sessionId, 'child-session');
      return childAgent;
    }
  };
  adapter.installController = (handle) => {
    assert.equal(handle.agent, childAgent);
    const controller = { agent: childAgent };
    adapter.controllers.set('child-session', controller);
    return controller;
  };
  adapter.threadResponse = (agent, options) => {
    assert.equal(agent, childAgent);
    assert.equal(options.includeTurns, false);
    return { thread: { id: 'child-session', turns: [] } };
  };

  const response = await adapter.threadFork({
    threadId: 'source-session',
    lastTurnId: 'dsh-turn-1',
    excludeTurns: true
  });

  assert.deepEqual(hostCalls, [{ sessionId: 'source-session', atSeq: 3 }]);
  assert.equal(response.result.thread.id, 'child-session');
});
