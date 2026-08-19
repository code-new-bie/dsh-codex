import assert from 'node:assert/strict';
import test from 'node:test';
import { DshAgentDriver } from '../src/dsh/agent-driver.mjs';

function fixture({ loggedConfig = undefined } = {}) {
  const calls = [];
  const listeners = [];
  const agent = {
    id: 'session-live',
    session: {
      requestHeader() {
        return loggedConfig === undefined ? undefined : { config: loggedConfig };
      }
    },
    ctx: {
      on(name) {
        listeners.push(name);
        return () => {};
      }
    },
    followup(message) { calls.push(['followup', message]); },
    steer(message) { calls.push(['steer', message]); },
    cancel(cause, options) { calls.push(['cancel', cause, options]); },
    whenIdle() { calls.push(['whenIdle']); return Promise.resolve(); }
  };
  const handle = { agent, dispose: async () => {} };
  const agentCtx = { ...agent.ctx, agent };
  const services = {
    loader: { async await() { calls.push(['loader.await']); } },
    agentDefaultModel: {
      currentSelection() {
        calls.push(['defaultModel.currentSelection']);
        return { provider: 'deepseek', model: 'deepseek-test', reasoningEffort: 'high' };
      }
    },
    agents: {
      async create(options) {
        calls.push(['agents.create', options]);
        await options.setup?.(agentCtx);
        return handle;
      },
      async resume(options) {
        calls.push(['agents.resume', options]);
        await options.setup?.(agentCtx);
        return handle;
      },
      get(id) { calls.push(['agents.get', id]); return agent; },
      list() { calls.push(['agents.list']); return [agent]; },
      roots() { calls.push(['agents.roots']); return [agent]; }
    },
    llm: {
      listProviders() {
        calls.push(['llm.listProviders']);
        return [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'broken', name: 'Broken provider' }
        ];
      },
      async listModels(provider) {
        calls.push(['llm.listModels', provider]);
        if (provider === 'broken') throw new Error('catalog unavailable');
        return [
          { provider, id: 'model-a', name: 'Model A', description: 'First model' },
          { provider, id: 'model-b', name: 'Model B' }
        ];
      },
      async resolveModelInfo(provider, model) {
        calls.push(['llm.resolveModelInfo', provider, model]);
        return {
          provider,
          id: model,
          name: model === 'model-a' ? 'Model A' : 'Model B',
          inputModalities: ['text'],
          context: { contextWindow: 128000 },
          ...(model === 'model-a'
            ? {
                reasoning: {
                  efforts: [
                    { id: 'low', name: 'Low' },
                    { id: 'high', name: 'High', description: 'More reasoning' }
                  ],
                  defaultEffort: 'low'
                }
              }
            : {})
        };
      },
      async resolveCallConfig(config) {
        calls.push(['llm.resolveCallConfig', config]);
        return {
          ...config,
          ...(config.reasoningEffort === undefined ? { reasoningEffort: 'low' } : {})
        };
      }
    },
    sessionPersistence: {
      async list(options) { calls.push(['sessionPersistence.list', options]); return { entries: [] }; },
      async inspect(id) { calls.push(['sessionPersistence.inspect', id]); return { id, events: [] }; }
    }
  };
  return {
    calls,
    listeners,
    agent,
    handle,
    ctx: { get(name) { return services[name]; } }
  };
}

test('create uses DSH default model and installs the official model-selection hooks', async () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  const handle = await driver.create({ cwd: '/workspace', sessionId: 'session-new' });
  assert.equal(handle, fx.handle);

  const create = fx.calls.find(([name]) => name === 'agents.create');
  assert.ok(create);
  const options = create[1];
  assert.equal(options.sessionId, 'session-new');
  assert.equal(options.meta.cwd, '/workspace');
  assert.deepEqual(options.agentOptions, { provider: 'deepseek', model: 'deepseek-test' });
  assert.equal(typeof options.setup, 'function');
  assert.deepEqual(fx.listeners.sort(), ['agent/request', 'system-prompt/assemble'].sort());
});

test('resume restores latest request/header before consulting machine current default', async () => {
  const fx = fixture({
    loggedConfig: { provider: 'persisted', model: 'old-model', reasoningEffort: 'max' }
  });
  const driver = new DshAgentDriver(fx.ctx);
  await driver.resume('session-old');

  const resume = fx.calls.find(([name]) => name === 'agents.resume');
  assert.equal(resume[1].resumeSessionId, 'session-old');
  assert.equal(typeof resume[1].setup, 'function');
  assert.deepEqual(driver.currentModel(fx.agent), {
    provider: 'persisted',
    model: 'old-model',
    reasoningEffort: 'max'
  });
  assert.equal(
    fx.calls.some(([name]) => name === 'defaultModel.currentSelection'),
    false,
    'persisted request/header must win over the current machine default'
  );
});

test('blank resumed session falls back to live DSH default only when read', async () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  await driver.resume('blank-session');
  assert.equal(fx.calls.some(([name]) => name === 'defaultModel.currentSelection'), false);
  assert.deepEqual(driver.currentModel(fx.agent), {
    provider: 'deepseek',
    model: 'deepseek-test',
    reasoningEffort: 'high'
  });
});

test('model directory uses public LLM registry and isolates provider failures', async () => {
  const fx = fixture();
  const directory = await new DshAgentDriver(fx.ctx).modelDirectory();
  assert.equal(directory.groups.length, 1);
  assert.equal(directory.groups[0].provider, 'deepseek');
  assert.equal(directory.groups[0].models[0].reasoning.defaultEffort, 'low');
  assert.deepEqual(directory.groups[0].models[0].inputModalities, ['text']);
  assert.equal(directory.groups[0].models[0].contextWindow, 128000);
  assert.deepEqual(directory.failures, [{ provider: 'broken', message: 'catalog unavailable' }]);
});

test('model switch is validated/defaulted by DSH resolveCallConfig before selection changes', async () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  await driver.resume('blank-session');
  const selected = await driver.selectModel(fx.agent, { provider: 'deepseek', model: 'model-a' });
  assert.deepEqual(selected, { provider: 'deepseek', model: 'model-a', reasoningEffort: 'low' });
  assert.deepEqual(driver.currentModel(fx.agent), selected);
  assert.deepEqual(fx.calls.find(([name]) => name === 'llm.resolveCallConfig'), [
    'llm.resolveCallConfig',
    { provider: 'deepseek', model: 'model-a' }
  ]);
});

test('followup and steering create official DSH user messages and delegate to Agent', () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  driver.followup(fx.agent, 'hello');
  driver.steer(fx.agent, 'change direction');

  const followup = fx.calls.find(([name]) => name === 'followup')[1];
  assert.equal(followup.role, 'user');
  assert.deepEqual(followup.source, { kind: 'user' });
  assert.deepEqual(followup.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(typeof followup.id, 'string');

  const steering = fx.calls.find(([name]) => name === 'steer')[1];
  assert.deepEqual(steering.content, [{ type: 'text', text: 'change direction' }]);
});

test('interrupt delegates user cancellation to DSH and does not invent policy', () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  driver.interrupt(fx.agent, { keepInbox: true });
  assert.deepEqual(fx.calls.find(([name]) => name === 'cancel'), [
    'cancel',
    { kind: 'user' },
    { keepInbox: true }
  ]);
});

test('live/session lookup methods delegate to official registries', async () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  assert.equal(driver.getLive('session-live'), fx.agent);
  assert.deepEqual(driver.listLive(), [fx.agent]);
  assert.deepEqual(driver.listRootAgents(), [fx.agent]);
  assert.deepEqual(await driver.listSessions({ limit: 20 }), { entries: [] });
  assert.deepEqual(await driver.inspectSession('session-old'), { id: 'session-old', events: [] });

  assert.ok(fx.calls.some((call) => call[0] === 'sessionPersistence.list'));
  assert.ok(fx.calls.some((call) => call[0] === 'sessionPersistence.inspect'));
});

test('missing DSH service is a hard compatibility error, not a shadow implementation', async () => {
  const driver = new DshAgentDriver({ get() { return undefined; } });
  await assert.rejects(() => driver.create({ sessionId: 'session-x' }), /DSHX requires DSH service: agents/);
});
