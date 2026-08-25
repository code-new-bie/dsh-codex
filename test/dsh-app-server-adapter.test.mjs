import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxPresentationAdapter } from '../src/dsh/presentation-adapter.mjs';
import { decodeDshModel } from '../src/dsh/codex-shapes.mjs';

function fixture() {
  const sent = [];
  const calls = [];
  const sessions = new Map();
  const live = new Map();
  let questionProvider;
  let clock = 1_700_000_000_000;

  const presetTable = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Workspace' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Danger' }
  };

  const services = {};
  // The unified presentation adapter registers release-layer agent lifecycle
  // listeners during ensureReady, so the fake context must accept `on`.
  const rootCtx = {
    get(name) { return services[name]; },
    on() { return () => {}; }
  };

  function requestHeader(session) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index];
      if (event.type === 'request/header') return event.data.header;
    }
    return undefined;
  }

  function makeSession(id, cwd = '/workspace', seed = []) {
    const session = {
      id,
      header: { id, createdAt: clock++, cwd },
      events: [...seed],
      permissionPreset: 'workspace-write',
      requestHeader() { return requestHeader(session); }
    };
    sessions.set(String(id), session);
    return session;
  }

  function makeAgent(session) {
    const listeners = new Map();
    const agent = {
      id: session.id,
      session,
      ctx: {
        agent: undefined,
        get(name) { return services[name]; },
        on(name, listener) {
          const bucket = listeners.get(name) ?? [];
          bucket.push(listener);
          listeners.set(name, bucket);
          return () => {
            const current = listeners.get(name) ?? [];
            const index = current.indexOf(listener);
            if (index >= 0) current.splice(index, 1);
          };
        }
      },
      followup(message) {
        calls.push(['followup', String(agent.id), message]);
        const turn = 1 + session.events.filter((event) => event.type === 'turn/start').length;
        append(agent, 'turn/start', { turn });
        append(agent, 'user/message', message);
      },
      steer(message) { calls.push(['steer', String(agent.id), message]); },
      cancel(cause, options) { calls.push(['cancel', String(agent.id), cause, options]); },
      whenIdle() { return Promise.resolve(); },
      _listeners: listeners
    };
    agent.ctx.agent = agent;
    return agent;
  }

  function append(agent, type, data) {
    const event = { type, seq: agent.session.events.length, time: clock++, data };
    agent.session.events.push(event);
    for (const listener of agent._listeners.get('session/event') ?? []) listener(agent.session, event);
    return event;
  }

  async function approval(agent, req) {
    const listeners = agent._listeners.get('approval/request') ?? [];
    let index = 0;
    const next = async () => {
      const listener = listeners[index++];
      return listener ? listener(req, next) : 'unavailable';
    };
    return next();
  }

  services.loader = { async await() { calls.push(['loader.await']); } };
  services.agentDefaultModel = {
    currentSelection() { return { provider: 'deepseek', model: 'model-a', reasoningEffort: 'low' }; }
  };
  services.llm = {
    listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }]; },
    async listModels(provider) { return [{ provider, id: 'model-a', name: 'Model A', description: 'Primary' }]; },
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: 'Model A',
        inputModalities: ['text'],
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
          defaultEffort: 'low'
        }
      };
    },
    async resolveCallConfig(config) {
      calls.push(['resolveCallConfig', config]);
      if (config.provider !== 'deepseek' || config.model !== 'model-a') throw new Error('unknown route');
      return { ...config, reasoningEffort: config.reasoningEffort ?? 'low' };
    }
  };
  services.tools = {
    get(name, agent) {
      assert.ok(agent);
      if (name === 'shell') {
        return {
          presentCall: () => ({ card: 'terminal', title: 'echo ok', cwd: agent.session.header.cwd }),
          presentResult: () => ({ card: 'terminal', output: 'ok\n', exitCode: 0 })
        };
      }
      return undefined;
    }
  };
  services.permissionPresets = {
    names: Object.keys(presetTable),
    current(events) {
      const session = [...sessions.values()].find((candidate) => candidate.events === events);
      return session?.permissionPreset ?? 'workspace-write';
    },
    optionOf(name) {
      if (name === 'custom') return { value: 'custom', name: 'Custom' };
      const preset = presetTable[name];
      return { value: name, name: preset.name, description: preset.description };
    },
    resolve(name) {
      const preset = presetTable[name];
      if (!preset) throw new Error('unknown preset');
      return preset;
    },
    set(session, name) {
      if (!presetTable[name]) throw new Error('unknown preset');
      calls.push(['permissionPresets.set', String(session.id), name]);
      session.permissionPreset = name;
    }
  };
  services.sandboxPolicy = {
    resolve({ session }) {
      const preset = presetTable[session.permissionPreset];
      return { mode: preset.sandbox, workspaceRoot: session.header.cwd };
    }
  };
  services.approval = {
    config: { policy: 'ask' },
    overrideOf(session) { return presetTable[session.permissionPreset].approval; }
  };
  services.userQuestions = {
    registerProvider(provider) {
      assert.equal(questionProvider, undefined);
      questionProvider = provider;
      return () => { questionProvider = undefined; };
    }
  };
  services.sessionPersistence = {
    async list(signal) {
      calls.push(['sessionPersistence.list', signal]);
      return [...sessions.values()].map((session) => session.header);
    },
    async inspect(id) {
      const session = sessions.get(String(id));
      if (!session) return undefined;
      return { meta: session.header, events: session.events };
    }
  };
  services.agents = {
    async create(options) {
      calls.push(['agents.create', options]);
      const session = makeSession(String(options.sessionId), options.meta?.cwd);
      const agent = makeAgent(session);
      live.set(String(agent.id), agent);
      await options.setup?.(agent.ctx);
      return {
        agent,
        async dispose() { calls.push(['handle.dispose', String(agent.id)]); live.delete(String(agent.id)); }
      };
    },
    async resume(options) {
      calls.push(['agents.resume', options]);
      const session = sessions.get(String(options.resumeSessionId));
      if (!session) throw new Error('session not found');
      const agent = makeAgent(session);
      live.set(String(agent.id), agent);
      await options.setup?.(agent.ctx);
      return {
        agent,
        async dispose() { calls.push(['handle.dispose', String(agent.id)]); live.delete(String(agent.id)); }
      };
    },
    get(id) { return live.get(String(id)); },
    list() { return [...live.values()]; },
    roots() { return [...live.values()]; }
  };

  const adapter = new DshxPresentationAdapter({
    ctx: rootCtx,
    send: (message) => sent.push(message),
    cwd: '/workspace',
    home: '/home/test/.dshx',
    version: 'test'
  });

  return {
    adapter,
    sent,
    calls,
    sessions,
    live,
    append,
    approval,
    makeSession,
    async ask(request) {
      assert.ok(questionProvider, 'adapter should register the DSH userQuestions provider');
      return questionProvider.ask(request);
    }
  };
}

async function request(adapter, id, method, params = {}) {
  const handled = await adapter.handle({ id, method, params });
  assert.ok(handled?.response);
  if (handled.response.error) throw new Error(handled.response.error.message);
  return handled;
}

test('bootstrap reads public DSH model catalog and exposes opaque provider-aware ids', async () => {
  const fx = fixture();
  const init = await request(fx.adapter, 1, 'initialize');
  assert.equal(init.response.result.platformOs.length > 0, true);

  const models = await request(fx.adapter, 2, 'model/list');
  assert.equal(models.response.result.data.length, 1);
  assert.deepEqual(decodeDshModel(models.response.result.data[0].model), {
    provider: 'deepseek', model: 'model-a'
  });
});

test('thread/start delegates creation and emits thread/started only after RPC response point', async () => {
  const fx = fixture();
  const started = await request(fx.adapter, 1, 'thread/start', { cwd: '/workspace' });
  const result = started.response.result;
  assert.equal(result.modelProvider, 'deepseek');
  assert.equal(result.sandbox.type, 'externalSandbox');
  assert.ok(fx.calls.some(([name]) => name === 'agents.create'));
  assert.deepEqual(fx.sent, []);

  started.afterResponse();
  assert.equal(fx.sent[0].method, 'thread/started');
  assert.equal(fx.sent[0].params.thread.id, result.thread.id);
});

test('turn/start uses Agent.followup and DSH-committed turn identity', async () => {
  const fx = fixture();
  const created = await request(fx.adapter, 1, 'thread/start', {});
  created.afterResponse();
  const threadId = created.response.result.thread.id;
  fx.sent.length = 0;

  const turn = await request(fx.adapter, 2, 'turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hello', text_elements: [] }]
  });
  assert.equal(turn.response.result.turn.id, 'dsh-turn-1');
  const followup = fx.calls.find(([name]) => name === 'followup');
  assert.equal(followup[2].source.kind, 'user');
  assert.deepEqual(fx.sent, [], 'turn notification stays buffered until transport sends response');
  turn.afterResponse();
  assert.equal(fx.sent[0].method, 'turn/started');
});

test('DSH approval/request round-trips through the matching presenter cell and stays one-shot', async () => {
  const fx = fixture();
  const created = await request(fx.adapter, 1, 'thread/start', {});
  const threadId = created.response.result.thread.id;
  const agent = fx.live.get(threadId);
  const turn = await request(fx.adapter, 2, 'turn/start', {
    threadId,
    input: [{ type: 'text', text: 'run', text_elements: [] }]
  });
  turn.afterResponse();
  fx.sent.length = 0;

  fx.append(agent, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{}' });
  assert.equal(fx.sent[0].params.item.type, 'commandExecution');
  const decisionPromise = fx.approval(agent, {
    agent,
    toolName: 'shell',
    callId: 'call-1',
    reason: 'needs permission'
  });
  await Promise.resolve();
  const uiRequest = fx.sent.find((message) => message.method === 'item/commandExecution/requestApproval');
  assert.ok(uiRequest);
  await fx.adapter.handle({ id: uiRequest.id, result: { decision: 'accept' } });
  assert.equal(await decisionPromise, 'allowed-once');
});

test('DSH userQuestions uses a synthetic presentation item because the public request has no call id', async () => {
  const fx = fixture();
  const created = await request(fx.adapter, 1, 'thread/start', {});
  const threadId = created.response.result.thread.id;
  const agent = fx.live.get(threadId);
  const turn = await request(fx.adapter, 2, 'turn/start', {
    threadId,
    input: [{ type: 'text', text: 'ask me', text_elements: [] }]
  });
  turn.afterResponse();
  fx.sent.length = 0;

  const answerPromise = fx.ask({
    agent,
    questions: [{ id: 'q1', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }]
  });
  await Promise.resolve();
  const started = fx.sent.find((message) => message.method === 'item/started');
  const uiRequest = fx.sent.find((message) => message.method === 'item/tool/requestUserInput');
  assert.equal(started.params.item.namespace, 'dshx');
  assert.ok(uiRequest);
  await fx.adapter.handle({ id: uiRequest.id, result: { answers: { q1: { answers: ['A'] } } } });
  assert.deepEqual(await answerPromise, { answers: [{ id: 'q1', selected: ['A'] }] });
  assert.ok(fx.sent.some((message) => message.method === 'item/completed'));
});

test('thread/resume restores DSH request-header model and authoritative persisted transcript', async () => {
  const fx = fixture();
  const session = fx.makeSession('persisted', '/project', [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: 1_700_000_000_010,
      data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix it' }] }
    },
    {
      type: 'request/header', seq: 2, time: 1_700_000_000_020,
      data: { header: { config: { provider: 'deepseek', model: 'model-a', reasoningEffort: 'high' } }, reason: 'initial' }
    },
    {
      type: 'assistant/message', seq: 3, time: 1_700_000_000_030,
      data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'fixed' }] } }
    },
    { type: 'turn/end', seq: 4, time: 1_700_000_000_040, data: { turn: 1, reason: { kind: 'completed' } } }
  ]);
  session.permissionPreset = 'workspace-write';

  const resumed = await request(fx.adapter, 1, 'thread/resume', { threadId: 'persisted' });
  assert.deepEqual(decodeDshModel(resumed.response.result.model), { provider: 'deepseek', model: 'model-a' });
  assert.equal(resumed.response.result.reasoningEffort, 'high');
  assert.equal(resumed.response.result.thread.turns.length, 1);
  assert.deepEqual(resumed.response.result.thread.turns[0].items.map((item) => item.type), ['userMessage', 'agentMessage']);
});

test('thread/list reads DSH persistence instead of maintaining a DSHX session database', async () => {
  const fx = fixture();
  fx.makeSession('s1', '/a', [{
    type: 'user/message', seq: 0, time: 1_700_000_000_000,
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Alpha task' }] }
  }]);
  fx.makeSession('s2', '/b', [{
    type: 'user/message', seq: 0, time: 1_700_000_000_100,
    data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'Beta task' }] }
  }]);

  const listed = await request(fx.adapter, 1, 'thread/list', { cwd: '/b' });
  assert.deepEqual(listed.response.result.data.map((thread) => thread.id), ['s2']);
  assert.ok(fx.calls.some(([name]) => name === 'sessionPersistence.list'));
});
