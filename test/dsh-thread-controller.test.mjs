import assert from 'node:assert/strict';
import test from 'node:test';
import { DshThreadController } from '../src/dsh/thread-controller.mjs';

function fixture() {
  const emitted = [];
  const calls = [];
  let sessionListener;
  let disposed = false;
  const session = { id: 'session-1' };
  const agent = {
    id: 'session-1',
    ctx: {
      on(name, listener) {
        assert.equal(name, 'session/event');
        sessionListener = listener;
        return () => { sessionListener = undefined; };
      }
    }
  };
  const handle = {
    agent,
    async dispose() { disposed = true; }
  };
  const driver = {
    followup(_agent, text) {
      calls.push(['followup', text]);
      queueMicrotask(() => {
        sessionListener?.(session, {
          type: 'turn/start',
          seq: 1,
          time: 1_700_000_000_000,
          data: { turn: 4 }
        });
      });
    },
    steer(_agent, text) { calls.push(['steer', text]); },
    interrupt(_agent, options) { calls.push(['interrupt', options]); },
    whenIdle() { calls.push(['whenIdle']); return Promise.resolve(); }
  };
  const controller = new DshThreadController({ handle, driver, emit: (event) => emitted.push(event) });
  return {
    controller,
    emitted,
    calls,
    emitSession(event) { sessionListener?.(session, event); },
    get disposed() { return disposed; },
    get hasListener() { return Boolean(sessionListener); }
  };
}

test('startTurn waits for DSH turn/start and releases notification after RPC response point', async () => {
  const fx = fixture();
  const started = await fx.controller.startTurn('hello');
  assert.deepEqual(fx.calls[0], ['followup', 'hello']);
  assert.equal(started.turn.id, 'dsh-turn-4');
  assert.equal(started.turn.status, 'inProgress');
  assert.deepEqual(fx.emitted, [], 'turn/started must remain buffered until transport sends response');

  started.release();
  assert.equal(fx.emitted.length, 1);
  assert.equal(fx.emitted[0].method, 'turn/started');
  assert.equal(fx.emitted[0].params.turn.id, started.turn.id);

  started.release();
  assert.equal(fx.emitted.length, 1, 'release must be idempotent');
});

test('later DSH session events stream directly through the projector', async () => {
  const fx = fixture();
  const started = await fx.controller.startTurn('hello');
  started.release();

  fx.emitSession({
    type: 'assistant/chunk',
    seq: 2,
    time: 1_700_000_000_010,
    data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } }
  });
  fx.emitSession({
    type: 'assistant/message',
    seq: 3,
    time: 1_700_000_000_020,
    data: {
      turn: 4,
      step: 1,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'test' },
        content: [{ type: 'text', text: 'hi' }]
      }
    }
  });
  fx.emitSession({
    type: 'turn/end',
    seq: 4,
    time: 1_700_000_000_030,
    data: { turn: 4, reason: { kind: 'completed' } }
  });

  assert.deepEqual(fx.emitted.map((event) => event.method), [
    'turn/started',
    'item/started',
    'item/agentMessage/delta',
    'item/completed',
    'turn/completed'
  ]);
});

test('steering, interrupt and idle are pure delegation', async () => {
  const fx = fixture();
  fx.controller.steer('new constraint');
  fx.controller.interrupt({ keepInbox: true });
  await fx.controller.whenIdle();
  assert.deepEqual(fx.calls, [
    ['steer', 'new constraint'],
    ['interrupt', { keepInbox: true }],
    ['whenIdle']
  ]);
});

test('close detaches the scoped session listener and disposes the DSH handle', async () => {
  const fx = fixture();
  assert.equal(fx.hasListener, true);
  await fx.controller.close();
  assert.equal(fx.hasListener, false);
  assert.equal(fx.disposed, true);
});
