import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxPresentationAdapter } from '../src/dsh/presentation-adapter.mjs';

function adapterFixture() {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.cwd = process.cwd();
  adapter.controllers = new Map();
  adapter.driver = { getLive() { return undefined; } };
  adapter.applyModelOverride = async () => {};
  adapter.applyStartPermissions = async () => {};
  return adapter;
}

test('thread/resume excludeTurns keeps the response bounded for Codex paginated hydration', async () => {
  const adapter = adapterFixture();
  const agent = { session: { header: { cwd: process.cwd() } } };
  adapter.controllers.set('session-1', { agent });
  const calls = [];
  adapter.threadResponse = (receivedAgent, options) => {
    assert.equal(receivedAgent, agent);
    calls.push(options);
    return { thread: { id: 'session-1', turns: options.includeTurns ? ['large-history'] : [] } };
  };

  const response = await adapter.threadResume({ threadId: 'session-1', excludeTurns: true });
  assert.deepEqual(calls, [{ includeTurns: false }]);
  assert.deepEqual(response.result.thread.turns, []);
});

test('legacy-compatible resume can still request inline turns when excludeTurns is absent', async () => {
  const adapter = adapterFixture();
  const agent = { session: { header: { cwd: process.cwd() } } };
  adapter.controllers.set('session-1', { agent });
  adapter.threadResponse = (_agent, options) => ({ thread: { turns: options.includeTurns ? ['history'] : [] } });

  const response = await adapter.threadResume({ threadId: 'session-1' });
  assert.deepEqual(response.result.thread.turns, ['history']);
});
