import assert from 'node:assert/strict';
import test from 'node:test';
import { DshSessionProjector } from '../src/dsh/session-projector.mjs';

const event = (type, data, time = 1_700_000_000_000) => ({ type, data, time });

function start(projector, turn = 1) {
  return projector.project(event('turn/start', { turn }));
}

test('projects DSH turn lifecycle without owning runtime state', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  const started = start(projector);
  assert.equal(started[0].method, 'turn/started');
  assert.equal(started[0].params.turn.id, 'dsh-turn-1');
  assert.equal(started[0].params.turn.status, 'inProgress');

  const ended = projector.project(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_700_000_001_000));
  assert.equal(ended[0].method, 'turn/completed');
  assert.equal(ended[0].params.turn.status, 'completed');
});

test('projects visible DSH text chunks into one Codex agent message item', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  start(projector);

  const first = projector.project(
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hel' } })
  );
  assert.deepEqual(first.map((entry) => entry.method), ['item/started', 'item/agentMessage/delta']);
  assert.equal(first[1].params.delta, 'hel');

  const second = projector.project(
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } })
  );
  assert.deepEqual(second.map((entry) => entry.method), ['item/agentMessage/delta']);

  const completed = projector.project(
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'hello' }] }
    })
  );
  assert.equal(completed[0].method, 'item/completed');
  assert.equal(completed[0].params.item.text, 'hello');
});

test('projects DSH reasoning chunks into a distinct native Codex reasoning item', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  start(projector);

  const first = projector.project(
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
  );
  assert.deepEqual(first.map((entry) => entry.method), ['item/started', 'item/reasoning/textDelta']);
  assert.deepEqual(first[0].params.item, {
    type: 'reasoning',
    id: 'dsh-reasoning-1-1',
    summary: [],
    content: []
  });
  assert.equal(first[1].params.contentIndex, 0);
  assert.equal(first[1].params.delta, 'think');

  const second = projector.project(
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'ing' } })
  );
  assert.deepEqual(second.map((entry) => entry.method), ['item/reasoning/textDelta']);

  const completed = projector.project(event('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answer' }
      ]
    }
  }));
  assert.deepEqual(completed.map((entry) => entry.method), [
    'item/completed',
    'item/started',
    'item/completed'
  ]);
  assert.deepEqual(completed[0].params.item, {
    type: 'reasoning',
    id: 'dsh-reasoning-1-1',
    summary: [],
    content: ['thinking']
  });
  assert.equal(completed[2].params.item.text, 'answer');
});

test('projects unknown DSH tools conservatively and correlates official tool/result message source', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  start(projector);
  const started = projector.project(
    event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'custom_tool', arguments: '{"x":1}' })
  );
  assert.equal(started[0].method, 'item/started');
  assert.equal(started[0].params.item.type, 'dynamicToolCall');
  assert.deepEqual(started[0].params.item.arguments, { x: 1 });
  assert.equal(started[0].params.item.status, 'inProgress');

  const completed = projector.project(
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false
        }]
      }
    }, 1_700_000_000_050)
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].params.item.status, 'completed');
  assert.equal(completed[0].params.item.success, true);
});

test('falls back to tool-result block call id when message source is unavailable', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  start(projector);
  projector.project(event('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-2',
    name: 'custom_tool',
    arguments: '{}'
  }));
  const completed = projector.project(event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      content: [{
        type: 'tool-result',
        toolCallId: 'call-2',
        content: [{ type: 'text', text: 'failed' }],
        isError: true
      }]
    }
  }));
  assert.equal(completed[0].params.item.status, 'failed');
  assert.equal(completed[0].params.item.success, false);
});

test('projects DSH todo snapshots into Codex plan updates', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  start(projector, 7);
  const plan = projector.project(
    event('todo/write', {
      todos: [
        { content: 'Inspect project', status: 'completed' },
        { content: 'Apply fix', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' }
      ]
    })
  );
  assert.equal(plan[0].method, 'turn/plan/updated');
  assert.deepEqual(plan[0].params.plan, [
    { step: 'Inspect project', status: 'completed' },
    { step: 'Apply fix', status: 'inProgress' },
    { step: 'Run tests', status: 'pending' }
  ]);
});

test('caches request route metadata only as disposable presentation state', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  assert.deepEqual(
    projector.project(
      event('request/header', {
        header: { config: { provider: 'deepseek', model: 'example', reasoningEffort: 'high' } },
        reason: 'initial'
      })
    ),
    []
  );
  assert.equal(projector.latestHeader.config.provider, 'deepseek');

  projector.project(event('request/context', { provider: 'deepseek', model: 'example', contextWindow: 128000 }));
  assert.equal(projector.latestContext.contextWindow, 128000);
});
