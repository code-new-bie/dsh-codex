import assert from 'node:assert/strict';
import test from 'node:test';
import { DshAgentDriver } from '../src/dsh/agent-driver.mjs';

function fixture() {
  const calls = [];
  const listeners = [];
  const agent = {
    id: 'session-live',
    followup(message) { calls.push(['followup', message]); },
    steer(message) { calls.push(['steer', message]); },
    cancel(cause, options) { calls.push(['cancel', cause, options]); },
    whenIdle() { calls.push(['whenIdle']); return Promise.resolve(); }
  };
  const handle = { agent, dispose: async () => {} };
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
        options.setup?.({
          on(name) {
            listeners.push(name);
            return () => {};
          }
        });
        return handle;
      },
      async resume(options) { calls.push(['agents.resume', options]); return handle; },
      get(id) { calls.push(['agents.get', id]); return agent; },
      list() { calls.push(['agents.list']); return [agent]; },
      roots() { calls.push(['agents.roots']); return [agent]; }
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

test('create uses DSH default model and official agents.create', async () => {
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

test('resume delegates persisted reconstruction without applying current default model', async () => {
  const fx = fixture();
  const driver = new DshAgentDriver(fx.ctx);
  await driver.resume('session-old');

  const resume = fx.calls.find(([name]) => name === 'agents.resume');
  assert.deepEqual(resume[1], { resumeSessionId: 'session-old' });
  assert.equal(
    fx.calls.some(([name]) => name === 'defaultModel.currentSelection'),
    false,
    'DSHX must not overwrite a resumed Session with the machine current default model'
  );
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
