import assert from 'node:assert/strict';
import test from 'node:test';
import { dshTurnsFromSession } from '../src/tui-protocol/shapes.mjs';
import { DshxPresentationAdapter } from '../src/tui-protocol/adapter.mjs';
import { DshSessionProjector } from '../src/dsh/session-projector.mjs';

const event = (type, data, time, seq = 0) => ({ type, data, time, seq });

test('automatic DSH compaction renders as a native contextCompaction item inside its real turn', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  projector.project(event('turn/start', { turn: 1 }, 1000, 1));
  const started = projector.project(event('compaction/start', {
    compactionId: 'compact-1',
    turn: 1
  }, 1100, 2));
  assert.deepEqual(started.map((entry) => entry.method), ['item/started']);
  assert.deepEqual(started[0].params.item, { type: 'contextCompaction', id: 'dsh-compaction-compact-1' });
  assert.equal(started[0].params.turnId, 'dsh-turn-1');
  projector.project(event('compaction/summary', { compactionId: 'compact-1' }, 1200, 3));
  const ended = projector.project(event('compaction/end', {
    compactionId: 'compact-1',
    turn: 1
  }, 1300, 5));
  assert.deepEqual(ended.map((entry) => entry.method), ['item/completed']);
});

test('standalone manual DSH compaction uses a presentation-only maintenance turn', () => {
  const projector = new DshSessionProjector({ threadId: 'session-1' });
  const started = projector.project(event('compaction/start', {
    compactionId: 'manual-1',
    turn: null
  }, 2000, 10));
  assert.deepEqual(started.map((entry) => entry.method), ['turn/started', 'item/started']);
  assert.equal(started[0].params.turn.id, 'dsh-maintenance-compaction-manual-1');
  assert.equal(started[1].params.turnId, 'dsh-maintenance-compaction-manual-1');
  projector.project(event('compaction/summary', { compactionId: 'manual-1' }, 2200, 11));
  const ended = projector.project(event('compaction/end', {
    compactionId: 'manual-1',
    turn: null
  }, 2500, 13));
  assert.deepEqual(ended.map((entry) => entry.method), ['item/completed', 'turn/completed']);
  assert.equal(ended[1].params.turn.status, 'completed');
});

test('resumed human transcript keeps shadowed history and adds one compaction marker', () => {
  const agent = {
    id: 'session-1',
    ctx: { get() { return { get() { return undefined; } }; } },
    session: {
      header: { id: 'session-1', cwd: process.cwd() },
      events: [
        event('turn/start', { turn: 1 }, 1000, 1),
        event('user/message', {
          id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'old prompt' }]
        }, 1010, 2),
        event('assistant/message', {
          turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] }
        }, 1020, 3),
        event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1030, 4),
        event('compaction/start', { compactionId: 'manual-1', turn: null }, 2000, 5),
        event('compaction/summary', { compactionId: 'manual-1', summary: [] }, 2100, 6),
        event('user/message', {
          id: 'checkpoint',
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'manual-1' },
          content: [{ type: 'text', text: 'MODEL ONLY CHECKPOINT' }],
          surfaceOp: { op: 'replace', start: 2, end: 3 }
        }, 2110, 7),
        event('compaction/end', { compactionId: 'manual-1', turn: null }, 2200, 8)
      ]
    }
  };
  const turns = dshTurnsFromSession({ ctx: agent.ctx, agent });
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].items.map((item) => item.type), ['userMessage', 'agentMessage']);
  assert.equal(turns[0].items[0].content[0].text, 'old prompt');
  assert.equal(turns[0].items[1].text, 'old answer');
  assert.deepEqual(turns[1].items, [{ type: 'contextCompaction', id: 'dsh-compaction-manual-1' }]);
  assert.equal(JSON.stringify(turns).includes('MODEL ONLY CHECKPOINT'), false);
});

test('thread/compact/start delegates to the official DSH command plane and reports a no-op result', async () => {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  const warnings = [];
  adapter.send = (message) => warnings.push(message);
  adapter.diagnostics = () => {};
  const agent = { id: 'session-1' };
  adapter.controllers = new Map([['session-1', { agent }]]);
  adapter._manualCompactions = new Map();
  const commandCalls = [];
  adapter.ctx = {
    get(name) {
      if (name === 'commands') {
        return {
          async execute(receivedAgent, line, images, signal) {
            commandCalls.push([receivedAgent, line, images]);
            assert.equal(signal.aborted, false);
            return { result: { text: 'No compactable history yet.' } };
          }
        };
      }
      return undefined;
    }
  };

  const response = adapter.threadCompactStart({ threadId: 'session-1' });
  assert.deepEqual(response.result, {});
  response.afterResponse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commandCalls, [[agent, '/compact', []]]);
  assert.deepEqual(warnings, [{
    method: 'warning',
    params: { threadId: 'session-1', message: 'No compactable history yet.' }
  }]);
});

test('synthetic compaction turn interrupt aborts only the tracked official DSH operation', () => {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  const abort = new AbortController();
  adapter._manualCompactions = new Map([['session-1', abort]]);
  const result = adapter.turnInterruptProduct({
    threadId: 'session-1',
    turnId: 'dsh-maintenance-compaction-c1'
  });
  assert.deepEqual(result, { result: {} });
  assert.equal(abort.signal.aborted, true);
});
