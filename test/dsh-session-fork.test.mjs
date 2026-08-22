import assert from 'node:assert/strict';
import test from 'node:test';
import { codexForkAtSeq } from '../src/dsh/session-fork.mjs';

const events = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { id: 'u1' } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1 } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 5, type: 'session/title', data: { title: 'after turn one' } },
  { seq: 6, type: 'turn/start', data: { turn: 2 } },
  { seq: 7, type: 'user/message', data: { id: 'u2' } },
  { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }
];

test('default fork delegates boundary selection entirely to DSH Host', () => {
  assert.equal(codexForkAtSeq(events), undefined);
});

test('lastTurnId translates only to the matching durable turn/end anchor', () => {
  assert.equal(codexForkAtSeq(events, { lastTurnId: 'dsh-turn-1' }), 4);
  assert.equal(codexForkAtSeq(events, { lastTurnId: 'dsh-turn-2' }), 8);
});

test('beforeTurnId translates to the prior completed-turn anchor without slicing a seed', () => {
  assert.equal(codexForkAtSeq(events, { beforeTurnId: 'dsh-turn-2' }), 4);
  assert.throws(
    () => codexForkAtSeq(events, { beforeTurnId: 'dsh-turn-1' }),
    /cannot represent.*before the first completed turn/i
  );
});

test('fork anchor translation rejects ambiguous or nonexistent Codex turn ids', () => {
  assert.throws(
    () => codexForkAtSeq(events, { lastTurnId: 'dsh-turn-1', beforeTurnId: 'dsh-turn-2' }),
    /mutually exclusive/
  );
  assert.throws(() => codexForkAtSeq(events, { lastTurnId: 'turn-1' }), /cannot map Codex turn id/);
  assert.throws(() => codexForkAtSeq(events, { lastTurnId: 'dsh-turn-99' }), /no completed/);
  assert.throws(() => codexForkAtSeq(events, { beforeTurnId: 'dsh-turn-99' }), /has no dsh-turn-99/);
});
