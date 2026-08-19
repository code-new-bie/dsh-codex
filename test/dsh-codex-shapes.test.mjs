import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexModelsFromDsh,
  decodeDshModel,
  dshThreadFromSnapshot,
  dshTurnsFromSession,
  encodeDshModel,
  normalizeCodexEffort
} from '../src/dsh/codex-shapes.mjs';

test('model picker encodes provider identity without hard-coding provider semantics', () => {
  const directory = {
    groups: [
      {
        provider: 'p1',
        name: 'Provider One',
        models: [{
          id: 'shared',
          name: 'Shared Model',
          inputModalities: ['text', 'image'],
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'low'
          }
        }]
      },
      {
        provider: 'p2',
        name: 'Provider Two',
        models: [{ id: 'shared', name: 'Shared Model', inputModalities: ['text'] }]
      }
    ]
  };
  const models = codexModelsFromDsh(directory, { provider: 'p2', model: 'shared' });
  assert.equal(models.length, 2);
  assert.notEqual(models[0].model, models[1].model);
  assert.deepEqual(decodeDshModel(models[0].model), { provider: 'p1', model: 'shared' });
  assert.deepEqual(decodeDshModel(models[1].model), { provider: 'p2', model: 'shared' });
  assert.match(models[0].displayName, /Provider One/);
  assert.equal(models[1].isDefault, true);
  assert.equal(models[0].defaultReasoningEffort, 'low');
  assert.equal(models[1].defaultReasoningEffort, 'dsh-default');
  assert.equal(normalizeCodexEffort('dsh-default'), undefined);
});

test('opaque DSH model ids round-trip and reject unowned values', () => {
  const encoded = encodeDshModel({ provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(decodeDshModel(encoded), { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(decodeDshModel('gpt-5'), undefined);
});

test('persisted SessionHeader and request header project to a not-loaded Codex thread', () => {
  const thread = dshThreadFromSnapshot({
    meta: { id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/work' },
    events: [
      {
        type: 'user/message',
        time: 1_700_000_000_100,
        data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the parser' }] }
      },
      {
        type: 'request/header',
        time: 1_700_000_000_200,
        data: { header: { config: { provider: 'deepseek', model: 'model-a' } }, reason: 'initial' }
      }
    ]
  });
  assert.equal(thread.id, 'session-1');
  assert.equal(thread.preview, 'Fix the parser');
  assert.equal(thread.modelProvider, 'deepseek');
  assert.deepEqual(thread.status, { type: 'notLoaded' });
  assert.equal(thread.cwd, '/work');
});

test('history projection includes only direct human input and stable assistant/tool items', () => {
  const definitions = {
    shell: {
      presentCall: () => ({ card: 'terminal', title: 'echo ok', cwd: '/work' }),
      presentResult: () => ({ card: 'terminal', output: 'ok\n', exitCode: 0 })
    }
  };
  const agent = {
    id: 'session-1',
    ctx: {
      get(name) {
        if (name === 'tools') return { get(toolName, scope) { assert.equal(scope, agent); return definitions[toolName]; } };
      }
    },
    session: {
      header: { id: 'session-1', createdAt: 1_700_000_000_000, cwd: '/work' },
      events: [
        { type: 'turn/start', time: 1_700_000_000_000, data: { turn: 1 } },
        {
          type: 'user/message',
          time: 1_700_000_000_010,
          data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] }
        },
        {
          type: 'user/message',
          time: 1_700_000_000_011,
          data: { id: 'ctx1', role: 'user', source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'internal context' }] }
        },
        {
          type: 'tool/call',
          time: 1_700_000_000_020,
          data: { turn: 1, step: 1, callId: 'c1', name: 'shell', arguments: '{}' }
        },
        {
          type: 'tool/result',
          time: 1_700_000_000_030,
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { kind: 'tool', callId: 'c1' },
              content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }]
            }
          }
        },
        {
          type: 'assistant/message',
          time: 1_700_000_000_040,
          data: {
            turn: 1,
            step: 1,
            message: { id: 'a1', content: [{ type: 'text', text: 'done' }] }
          }
        },
        { type: 'turn/end', time: 1_700_000_000_050, data: { turn: 1, reason: { kind: 'completed' } } }
      ]
    }
  };
  const turns = dshTurnsFromSession({ ctx: agent.ctx, agent });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'completed');
  assert.deepEqual(turns[0].items.map((item) => item.type), ['userMessage', 'commandExecution', 'agentMessage']);
  assert.equal(turns[0].items[0].content[0].text, 'run it');
  assert.equal(turns[0].items[1].aggregatedOutput, 'ok\n');
  assert.equal(turns[0].items[2].text, 'done');
});
