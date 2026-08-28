import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DshxPresentationAdapter } from '../src/tui-protocol/adapter.mjs';

function bareAdapter() {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.cwd = path.resolve('/workspace');
  adapter.diagnostics = () => {};
  adapter.controllers = new Map();
  return adapter;
}

function skillRegistry(absoluteSkill, calls = []) {
  return {
    async snapshot(options) {
      calls.push(['snapshot', options]);
      return {
        complete: true,
        skills: [
          {
            name: 'review',
            description: 'Review code',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'project-agents',
            provider: 'filesystem'
          },
          {
            name: 'remote-skill',
            description: 'Remote skill',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'custom',
            provider: 'remote'
          },
          {
            name: 'model-only',
            description: 'Model only',
            invocation: { modelInvocable: true, userInvocable: false },
            source: 'runtime',
            provider: 'runtime'
          }
        ]
      };
    },
    async get(name) {
      calls.push(['get', name]);
      if (name === 'review') {
        return {
          name,
          description: 'Review code',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'project-agents',
          provider: 'filesystem',
          content: 'review',
          path: absoluteSkill
        };
      }
      if (name === 'remote-skill') {
        return {
          name,
          description: 'Remote skill',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: 'remote',
          content: 'remote'
        };
      }
      return undefined;
    }
  };
}

test('skills/list reads DSH public registry and only returns faithfully path-backed user skills', async () => {
  const adapter = bareAdapter();
  const absoluteSkill = path.resolve('/workspace/.agents/skills/review/SKILL.md');
  const calls = [];
  adapter.ctx = {
    get(name) {
      return name === 'skills' ? skillRegistry(absoluteSkill, calls) : undefined;
    }
  };

  const result = await adapter.skillsList({ cwds: [] });
  assert.equal(calls[0][0], 'snapshot');
  assert.equal(calls[0][1].cwd, path.resolve('/workspace'));
  assert.equal(result.result.data.length, 1);
  assert.deepEqual(result.result.data[0].skills, [{
    name: 'review',
    description: 'Review code',
    path: absoluteSkill,
    scope: 'repo',
    enabled: true
  }]);
});

test('skills/list accepts pinned Codex startup forceReload as a fresh DSH snapshot read', async () => {
  const adapter = bareAdapter();
  const absoluteSkill = path.resolve('/workspace/.agents/skills/review/SKILL.md');
  const calls = [];
  const diagnostics = [];
  adapter.diagnostics = (message) => diagnostics.push(message);
  adapter.ctx = {
    get(name) {
      return name === 'skills' ? skillRegistry(absoluteSkill, calls) : undefined;
    }
  };

  const result = await adapter.skillsList({ cwds: [path.resolve('/workspace')], forceReload: true });
  assert.equal(calls.filter(([kind]) => kind === 'snapshot').length, 1);
  assert.equal(result.result.data[0].skills[0].name, 'review');
  assert.match(diagnostics.join('\n'), /provider-owned cache policy/);
});

test('thread/settings/update maps Codex workspace profile to the DSH canonical preset', async () => {
  const adapter = bareAdapter();
  const applied = [];
  const agent = { session: { header: { cwd: path.resolve('/workspace') } } };
  adapter.controllers.set('session-1', { agent });
  adapter.ctx = {
    get(name) {
      if (name === 'permissionPresets') return { names: ['workspace-write', 'danger-full-access'] };
      return undefined;
    }
  };
  adapter.permissions = {
    set(receivedAgent, preset) {
      assert.equal(receivedAgent, agent);
      applied.push(preset);
    },
    current() {
      return {
        preset: 'workspace-write',
        codex: { approvalPolicy: 'on-request' },
        dsh: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }
      };
    }
  };
  adapter.applyModelOverride = async () => { throw new Error('model path should not run'); };

  const result = await adapter.threadSettingsUpdate({
    threadId: 'session-1',
    permissions: ':workspace',
    approvalPolicy: 'on-request'
  });
  assert.deepEqual(applied, ['workspace-write']);
  assert.deepEqual(result, { result: {} });
});

test('thread/settings/update delegates model/effort and persists the DSH deployment default', async () => {
  const adapter = bareAdapter();
  const agent = { session: { header: { cwd: path.resolve('/workspace') } } };
  adapter.controllers.set('session-1', { agent });
  const modelCalls = [];
  const saved = [];
  adapter.ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { async saveSelection(selection) { saved.push(selection); } };
      }
      return undefined;
    }
  };
  adapter.applyModelOverride = async (receivedAgent, update) => {
    assert.equal(receivedAgent, agent);
    modelCalls.push(update);
    return { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' };
  };
  adapter.applyStartPermissions = async () => { throw new Error('permission path should not run'); };

  const result = await adapter.threadSettingsUpdate({
    threadId: 'session-1',
    model: 'dshx:opaque-model',
    effort: 'high',
    collaborationMode: { mode: 'default', settings: {} }
  });
  assert.deepEqual(modelCalls, [{ model: 'dshx:opaque-model', effort: 'high' }]);
  assert.deepEqual(saved, [{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }]);
  assert.deepEqual(result, { result: {} });
});

test('missing DSH settings provider does not invalidate the current session model switch', async () => {
  const adapter = bareAdapter();
  const diagnostics = [];
  adapter.diagnostics = (message) => diagnostics.push(message);
  const agent = { session: { header: { cwd: path.resolve('/workspace') } } };
  adapter.controllers.set('session-1', { agent });
  adapter.ctx = { get() { return undefined; } };
  adapter.applyModelOverride = async () => ({ provider: 'deepseek', model: 'chat' });

  const result = await adapter.threadSettingsUpdate({ threadId: 'session-1', effort: 'medium' });
  assert.deepEqual(result, { result: {} });
  assert.match(diagnostics.join('\n'), /deployment default was not persisted/);
});

test('thread/settings/update refuses unsupported Codex-only settings when they are the actual requested change', async () => {
  const adapter = bareAdapter();
  adapter.controllers.set('session-1', {
    agent: { session: { header: { cwd: path.resolve('/workspace') } } }
  });
  await assert.rejects(
    () => adapter.threadSettingsUpdate({
      threadId: 'session-1',
      collaborationMode: { mode: 'plan', settings: {} }
    }),
    /no equivalent public collaboration-mode/
  );
  await assert.rejects(
    () => adapter.threadSettingsUpdate({
      threadId: 'session-1',
      personality: 'friendly'
    }),
    /no equivalent public personality/
  );
});

test('turn/steer delegates only to the exact active DSH turn', () => {
  const adapter = bareAdapter();
  const steered = [];
  adapter.controllers.set('session-1', {
    currentLocation() { return { threadId: 'session-1', turnId: 'dsh-turn-4' }; },
    steer(text) { steered.push(text); }
  });

  const result = adapter.turnSteer({
    threadId: 'session-1',
    expectedTurnId: 'dsh-turn-4',
    input: [
      { type: 'text', text: 'change direction', text_elements: [] },
      { type: 'text', text: 'keep tests', text_elements: [] }
    ]
  });
  assert.deepEqual(result, { result: { turnId: 'dsh-turn-4' } });
  assert.deepEqual(steered, ['change direction\nkeep tests']);
});

test('turn/steer rejects stale expectedTurnId instead of steering a different DSH turn', () => {
  const adapter = bareAdapter();
  let called = false;
  adapter.controllers.set('session-1', {
    currentLocation() { return { threadId: 'session-1', turnId: 'dsh-turn-5' }; },
    steer() { called = true; }
  });
  assert.throws(
    () => adapter.turnSteer({
      threadId: 'session-1',
      expectedTurnId: 'dsh-turn-4',
      input: [{ type: 'text', text: 'late', text_elements: [] }]
    }),
    /does not match active DSH turn/
  );
  assert.equal(called, false);
});
