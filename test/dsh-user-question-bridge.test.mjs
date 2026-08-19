import assert from 'node:assert/strict';
import test from 'node:test';
import { DshUserQuestionBridge } from '../src/dsh/user-question-bridge.mjs';

function fixture({ response, locate } = {}) {
  let provider;
  let disposed = false;
  const requests = [];
  const completions = [];
  const diagnostics = [];
  const userQuestions = {
    registerProvider(next) {
      provider = next;
      return () => { disposed = true; provider = undefined; };
    }
  };
  const broker = {
    async request(method, params, options) {
      requests.push({ method, params, options });
      if (response instanceof Error) throw response;
      return response ?? { answers: {} };
    }
  };
  const bridge = new DshUserQuestionBridge({
    ctx: { get(name) { return name === 'userQuestions' ? userQuestions : undefined; } },
    broker,
    locate: locate ?? (() => ({ threadId: 'session-1', turnId: 'dsh-turn-1', itemId: 'ask-ui-1' })),
    complete: (location, outcome) => completions.push({ location, outcome }),
    diagnostics: (message) => diagnostics.push(message)
  });
  return {
    bridge,
    requests,
    completions,
    diagnostics,
    ask(request) { return provider.ask(request); },
    get disposed() { return disposed; }
  };
}

test('single-select question maps to Codex request and structured DSH answer', async () => {
  const fx = fixture({
    response: { answers: { q1: { answers: ['PostgreSQL'] } } }
  });
  const result = await fx.ask({
    questions: [{
      id: 'q1',
      header: 'Database',
      question: 'Which database?',
      options: [
        { label: 'PostgreSQL', description: 'Production database' },
        { label: 'SQLite' }
      ]
    }]
  });

  assert.equal(fx.requests[0].method, 'item/tool/requestUserInput');
  assert.deepEqual(fx.requests[0].params.questions[0], {
    id: 'q1',
    header: 'Database',
    question: 'Which database?',
    isOther: true,
    isSecret: false,
    options: [
      { label: 'PostgreSQL', description: 'Production database' },
      { label: 'SQLite', description: '' }
    ]
  });
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['PostgreSQL'] }] });
  assert.equal(fx.completions[0].outcome.status, 'completed');
});

test('free-text answer is returned as DSH custom text', async () => {
  const fx = fixture({ response: { answers: { q1: { answers: ['Use the internal cluster'] } } } });
  const result = await fx.ask({
    questions: [{ id: 'q1', question: 'Where should this deploy?' }]
  });
  assert.equal(fx.requests[0].params.questions[0].options, null);
  assert.deepEqual(result, {
    answers: [{ id: 'q1', selected: [], custom: 'Use the internal cluster' }]
  });
});

test('detail is preserved in display text without changing answer encoding', async () => {
  const fx = fixture({ response: { answers: { review: { answers: ['Approve'] } } } });
  await fx.ask({
    questions: [{
      id: 'review',
      question: 'Approve this plan?',
      detail: '1. Inspect\n2. Edit\n3. Test',
      options: [{ label: 'Approve' }, { label: 'Reject' }],
      intent: { kind: 'plan-review', approve: 'Approve' }
    }]
  });
  assert.match(fx.requests[0].params.questions[0].question, /1\. Inspect/);
});

test('multi-select is explicit unsupported instead of silently degrading to single-select', async () => {
  const fx = fixture();
  await assert.rejects(
    () => fx.ask({
      questions: [{
        id: 'many',
        question: 'Choose several',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }]
      }]
    }),
    /does not yet represent DSH multi-select questions faithfully/
  );
  assert.equal(fx.requests.length, 0);
});

test('missing presentation location is an explicit compatibility failure', async () => {
  const fx = fixture({ locate: () => null });
  await assert.rejects(
    () => fx.ask({ questions: [{ id: 'q', question: 'Question?' }] }),
    /could not open a Codex presentation item/
  );
});

test('request failure closes the synthetic interaction as failed', async () => {
  const fx = fixture({ response: new Error('transport lost') });
  await assert.rejects(() => fx.ask({ questions: [{ id: 'q', question: 'Question?' }] }), /transport lost/);
  assert.equal(fx.completions[0].outcome.status, 'failed');
});

test('bridge disposal unregisters only the UI provider', () => {
  const fx = fixture();
  fx.bridge.dispose();
  assert.equal(fx.disposed, true);
});
