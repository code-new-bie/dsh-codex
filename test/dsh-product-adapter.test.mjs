import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DshxProductAdapter } from '../src/dsh/product-adapter.mjs';

function bareAdapter() {
  const adapter = Object.create(DshxProductAdapter.prototype);
  adapter.cwd = path.resolve('/workspace');
  adapter.diagnostics = () => {};
  adapter.controllers = new Map();
  return adapter;
}

test('skills/list reads DSH public registry and only returns faithfully path-backed user skills', async () => {
  const adapter = bareAdapter();
  const absoluteSkill = path.resolve('/workspace/.agents/skills/review/SKILL.md');
  adapter.ctx = {
    get(name) {
      if (name !== 'skills') return undefined;
      return {
        async snapshot(options) {
          assert.equal(options.cwd, path.resolve('/workspace'));
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
  };

  const result = await adapter.skillsList({ cwds: [] });
  assert.equal(result.result.data.length, 1);
  assert.deepEqual(result.result.data[0].skills, [{
    name: 'review',
    description: 'Review code',
    path: absoluteSkill,
    scope: 'repo',
    enabled: true
  }]);
});

test('skills/list refuses Codex forceReload because DSH invalidation belongs to providers', async () => {
  const adapter = bareAdapter();
  await assert.rejects(
    () => adapter.skillsList({ forceReload: true }),
    /DSH skill cache invalidation is provider-owned/
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
