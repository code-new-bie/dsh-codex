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

test('default fork uses the latest completed DSH turn prefix', () => {
  const seed = dshForkSeed(events);
  assert.deepEqual(seed.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(seed[0], events[0]);
  assert.equal(seed.at(-1), events.at(-1));
});

test('lastTurnId includes the selected completed DSH turn and trailing standalone events', () => {
  const withTitle = [
    ...events.slice(0, 4),
    { seq: 4.5, type: 'session/title', data: { title: 'after turn one' } },
    ...events.slice(4)
  ];
  assert.deepEqual(
    dshForkSeed(withTitle, { lastTurnId: 'dsh-turn-1' }).map((event) => event.seq),
    [1, 2, 3, 4, 4.5]
  );
});

test('beforeTurnId excludes the selected turn and everything after it', () => {
  assert.deepEqual(
    dshForkSeed(events, { beforeTurnId: 'dsh-turn-2' }).map((event) => event.seq),
    [1, 2, 3, 4]
  );
});

test('default fork excludes a later active turn instead of copying an open execution prefix', () => {
  const active = [
    ...events,
    { seq: 8, type: 'session/title', data: { title: 'latest completed title' } },
    { seq: 9, type: 'turn/start', data: { turn: 3 } },
    { seq: 10, type: 'user/message', data: { id: 'u3' } }
  ];
  assert.deepEqual(dshForkSeed(active).map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(
    () => dshForkSeed(active, { lastTurnId: 'dsh-turn-3' }),
    /no completed dsh-turn-3/
  );
});

test('fork refuses ambiguous, invalid, missing, or completion-less boundaries', () => {
  assert.throws(
    () => dshForkSeed(events, { lastTurnId: 'dsh-turn-1', beforeTurnId: 'dsh-turn-2' }),
    /mutually exclusive/
  );
  assert.throws(() => dshForkSeed(events, { lastTurnId: 'turn-1' }), /cannot map Codex turn id/);
  assert.throws(() => dshForkSeed(events, { lastTurnId: 'dsh-turn-99' }), /no completed/);
  assert.throws(
    () => dshForkSeed([{ seq: 1, type: 'turn/start', data: { turn: 1 } }]),
    /no completed turn to fork from/
  );
});
