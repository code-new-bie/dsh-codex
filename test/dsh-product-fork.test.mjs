import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxProductAdapter } from '../src/dsh/product-adapter.mjs';

function sourceAgent() {
  return {
    id: 'source-session',
    session: {
      header: { id: 'source-session', cwd: process.cwd() },
      events: [
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
      ]
    }
  };
}

function adapterFixture({ cold = false } = {}) {
  const adapter = Object.create(DshxProductAdapter.prototype);
  adapter.controllers = new Map();
  adapter.send = () => {};
  const source = sourceAgent();
  const target = {
    id: 'fork-session',
    session: {
      header: { id: 'fork-session', parentSession: source.id, cwd: process.cwd() },
      events: source.session.events
    }
  };
  const driverCalls = [];
  let sourceDisposed = 0;
  adapter.driver = {
    getLive(id) {
      return !cold && id === source.id ? source : undefined;
    },
    async resume(id) {
      assert.equal(id, source.id);
      driverCalls.push(['resume', id]);
      return { agent: source, async dispose() { sourceDisposed += 1; } };
    },
    async fork(receivedSource, options) {
      assert.equal(receivedSource, source);
      driverCalls.push(['fork', options]);
      return { agent: target, async dispose() {} };
    }
  };
  const presetSets = [];
  adapter.permissions = {
    current(agent) {
      assert.equal(agent, source);
      return { preset: 'workspace-write' };
    },
    set(agent, preset) {
      assert.equal(agent, target);
      presetSets.push(preset);
    }
  };
  adapter.installController = (handle) => {
    const controller = { agent: handle.agent };
    adapter.controllers.set(String(handle.agent.id), controller);
    return controller;
  };
  adapter.threadResponse = (agent, options) => ({
    thread: {
      id: String(agent.id),
      forkedFromId: source.id,
      turns: options.includeTurns ? ['history'] : []
    },
    model: 'dshx:model',
    modelProvider: 'deepseek',
    serviceTier: null,
    cwd: process.cwd(),
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'externalSandbox', networkAccess: 'enabled' },
    activePermissionProfile: { id: ':workspace', extends: null },
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly'
  });
  return {
    adapter,
    source,
    target,
    driverCalls,
    presetSets,
    get sourceDisposed() { return sourceDisposed; }
  };
}

test('thread/fork uses DSH seed prefix and inherits DSH permission preset', async () => {
  const fx = adapterFixture();
  const response = await fx.adapter.threadFork({
    threadId: fx.source.id,
    lastTurnId: 'dsh-turn-1',
    excludeTurns: true
  });
  const forkCall = fx.driverCalls.find(([name]) => name === 'fork');
  assert.ok(forkCall);
  assert.deepEqual(forkCall[1].seed.map((event) => event.seq), [1, 2]);
  assert.match(forkCall[1].sessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(fx.presetSets, ['workspace-write']);
  assert.equal(response.result.thread.id, fx.target.id);
  assert.deepEqual(response.result.thread.turns, []);
  assert.equal(typeof response.afterResponse, 'function');
});

test('cold thread/fork temporarily resumes official DSH source and releases it', async () => {
  const fx = adapterFixture({ cold: true });
  await fx.adapter.threadFork({ threadId: fx.source.id });
  assert.deepEqual(fx.driverCalls.map(([name]) => name), ['resume', 'fork']);
  assert.equal(fx.sourceDisposed, 1);
});

test('thread/fork rejects Codex-only fork state DSH cannot faithfully own', async () => {
  const fx = adapterFixture();
  await assert.rejects(
    () => fx.adapter.threadFork({ threadId: fx.source.id, deferGoalContinuation: true }),
    /no Codex thread-goal continuation state/
  );
  await assert.rejects(
    () => fx.adapter.threadFork({ threadId: fx.source.id, ephemeral: true }),
    /does not expose ephemeral Codex forks/
  );
});
