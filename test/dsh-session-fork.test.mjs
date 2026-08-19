import assert from 'node:assert/strict';
import test from 'node:test';
import { dshForkSeed } from '../src/dsh/session-fork.mjs';

const events = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { id: 'u1' } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1 } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 5, type: 'turn/start', data: { turn: 2 } },
  { seq: 6, type: 'user/message', data: { id: 'u2' } },
  { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }
];

test('full fork reuses the exact durable DSH event prefix', () => {
  const seed = dshForkSeed(events);
  assert.deepEqual(seed.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(seed[0], events[0]);
  assert.equal(seed.at(-1), events.at(-1));
});

test('lastTurnId includes the selected completed DSH turn', () => {
  assert.deepEqual(
    dshForkSeed(events, { lastTurnId: 'dsh-turn-1' }).map((event) => event.seq),
    [1, 2, 3, 4]
  );
});

test('beforeTurnId excludes the selected turn and everything after it', () => {
  assert.deepEqual(
    dshForkSeed(events, { beforeTurnId: 'dsh-turn-2' }).map((event) => event.seq),
    [1, 2, 3, 4]
  );
});

test('fork refuses ambiguous, invalid, missing, or active DSH turn boundaries', () => {
  assert.throws(
    () => dshForkSeed(events, { lastTurnId: 'dsh-turn-1', beforeTurnId: 'dsh-turn-2' }),
    /mutually exclusive/
  );
  assert.throws(() => dshForkSeed(events, { lastTurnId: 'turn-1' }), /cannot map Codex turn id/);
  assert.throws(() => dshForkSeed(events, { lastTurnId: 'dsh-turn-99' }), /no completed/);
  assert.throws(
    () => dshForkSeed([...events, { seq: 8, type: 'turn/start', data: { turn: 3 } }]),
    /active turn 3/
  );
});
