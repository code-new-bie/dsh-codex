import assert from 'node:assert/strict';
import test from 'node:test';
import { dshThreadItemsPage, dshThreadTurnsPage } from '../src/tui-protocol/history-pages.mjs';

function controller() {
  const agent = {
    id: 'session-1',
    ctx: {
      get(name) {
        if (name === 'tools') return { get() { return undefined; } };
        return undefined;
      }
    },
    session: {
      header: { id: 'session-1', cwd: '/work' },
      events: [
        { type: 'turn/start', time: 1000, data: { turn: 1 } },
        { type: 'user/message', time: 1010, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } },
        { type: 'assistant/message', time: 1020, data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'first' }] } } },
        { type: 'turn/end', time: 1030, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'turn/start', time: 2000, data: { turn: 2 } },
        { type: 'user/message', time: 2010, data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }] } },
        { type: 'assistant/message', time: 2020, data: { turn: 2, step: 1, message: { id: 'a2', content: [{ type: 'text', text: 'second' }] } } },
        { type: 'turn/end', time: 2030, data: { turn: 2, reason: { kind: 'completed' } } }
      ]
    }
  };
  return { agent };
}

test('turn pages satisfy Codex descending hydration without owning history state', () => {
  const first = dshThreadTurnsPage({
    controller: controller(),
    params: { limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }
  });
  assert.equal(first.data.length, 1);
  assert.equal(first.data[0].id, 'dsh-turn-2');
  assert.equal(first.data[0].itemsView, 'notLoaded');
  assert.deepEqual(first.data[0].items, []);
  assert.equal(first.nextCursor, 'dshx:1');
  assert.equal(first.backwardsCursor, null);

  const second = dshThreadTurnsPage({
    controller: controller(),
    params: { cursor: first.nextCursor, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }
  });
  assert.equal(second.data[0].id, 'dsh-turn-1');
  assert.equal(second.nextCursor, null);
});

test('item pages preserve turn correlation and can filter one turn', () => {
  const page = dshThreadItemsPage({
    controller: controller(),
    params: { turnId: 'dsh-turn-2', sortDirection: 'desc', limit: 10 }
  });
  assert.deepEqual(page.data.map((entry) => entry.turnId), ['dsh-turn-2', 'dsh-turn-2']);
  assert.deepEqual(page.data.map((entry) => entry.item.type), ['agentMessage', 'userMessage']);
  assert.equal(page.nextCursor, null);
  assert.equal(page.backwardsCursor, null);
});

test('history cursors are opaque and invalid cursors fail closed', () => {
  assert.throws(
    () => dshThreadTurnsPage({ controller: controller(), params: { cursor: 'not-owned-by-dshx' } }),
    /invalid DSHX history cursor/
  );
});
