import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxPresentationAdapter } from '../src/dsh/presentation-adapter.mjs';

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
  const adapter = Object.create(DshxPresentationAdapter.prototype);
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
  const hostCalls = [];
  const adoptions = [];
  adapter.driver = {
    getLive(id) {
      driverCalls.push(['getLive', id]);
      if (!cold && id === source.id) return source;
      if (id === target.id) return target;
      return undefined;
    },
    async inspectSession(id) {
      driverCalls.push(['inspectSession', id]);
      assert.equal(id, source.id);
      return { id, events: source.session.events };
    },
    adoptExternalSelection(agent, options) {
      driverCalls.push(['adoptExternalSelection', agent.id]);
      adoptions.push({ agent, options });
    }
  };
  adapter.hostApi = () => ({
    async forkSession(options) {
      hostCalls.push(['forkSession', options]);
      return { sessionId: target.id };
    },
    async selectModel(options) {
      hostCalls.push(['selectModel', options]);
      return options;
    }
  });
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
    }
  });
  return { adapter, source, target, driverCalls, hostCalls, adoptions };
}

test('thread/fork translates the Codex turn anchor and delegates creation to DSH Host', async () => {
  const fx = adapterFixture();
  const response = await fx.adapter.threadFork({
    threadId: fx.source.id,
    lastTurnId: 'dsh-turn-1',
    excludeTurns: true
  });

  assert.deepEqual(fx.hostCalls[0], [
    'forkSession',
    { sessionId: fx.source.id, atSeq: 2 }
  ]);
  assert.equal(fx.adoptions.length, 1);
  assert.equal(fx.adoptions[0].agent, fx.target);
  assert.equal(response.result.thread.id, fx.target.id);
  assert.deepEqual(response.result.thread.turns, []);
  assert.equal(typeof response.afterResponse, 'function');

  await fx.adoptions[0].options.select({
    provider: 'deepseek',
    model: 'reasoner',
    reasoningEffort: 'high'
  });
  assert.deepEqual(fx.hostCalls[1], [
    'selectModel',
    {
      sessionId: fx.target.id,
      provider: 'deepseek',
      model: 'reasoner',
      reasoningEffort: 'high'
    }
  ]);
});

test('cold thread/fork reads DSH persistence without temporarily resuming or cloning source state', async () => {
  const fx = adapterFixture({ cold: true });
  await fx.adapter.threadFork({ threadId: fx.source.id });

  assert.ok(fx.driverCalls.some((call) => call[0] === 'inspectSession' && call[1] === fx.source.id));
  assert.equal(fx.driverCalls.some((call) => call[0] === 'resume'), false);
  assert.deepEqual(fx.hostCalls[0], [
    'forkSession',
    { sessionId: fx.source.id, atSeq: undefined }
  ]);
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
