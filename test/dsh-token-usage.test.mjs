import assert from 'node:assert/strict';
import test from 'node:test';
import { codexThreadTokenUsage, tokenUsageNotification } from '../src/dsh/token-usage.mjs';

function fixture() {
  const session = {
    events: [
      {
        type: 'request/context',
        seq: 1,
        data: { provider: 'deepseek', model: 'model-a', contextWindow: 128000 }
      },
      {
        type: 'assistant/chunk',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 10,
              cacheReadTokens: 3,
              outputTokens: 5,
              reasoningTokens: 4
            }
          }
        }
      },
      {
        type: 'assistant/message',
        seq: 3,
        data: {
          turn: 1,
          step: 1,
          message: { content: [] },
          usage: {
            inputTokens: 12,
            cacheReadTokens: 4,
            cacheWriteTokens: 2,
            outputTokens: 6,
            reasoningTokens: 5
          }
        }
      },
      {
        type: 'assistant/message',
        seq: 4,
        data: {
          turn: 1,
          step: 2,
          message: { content: [] },
          usage: {
            inputTokens: 20,
            outputTokens: 7,
            reasoningTokens: 3
          }
        }
      }
    ]
  };
  const ctx = {
    get(name) {
      if (name !== 'sessionProjections') return undefined;
      return {
        snapshot(received) {
          assert.equal(received, session);
          return {
            asOfSeq: 4,
            values: {
              tokenUsage: {
                uncachedInputTokens: 32,
                outputTokens: 13,
                cacheReadTokens: 4,
                cacheWriteTokens: 2
              },
              contextPressure: {
                pressureTokens: 20,
                projectedTokens: 24,
                contextWindow: 128000
              }
            }
          };
        }
      };
    }
  };
  return { ctx, session };
}

test('Codex total uses DSH token-meter buckets without double-counting reasoning', () => {
  const { ctx, session } = fixture();
  const usage = codexThreadTokenUsage({ ctx, session });
  assert.deepEqual(usage.total, {
    totalTokens: 51,
    inputTokens: 32,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 2,
    outputTokens: 13,
    reasoningOutputTokens: 8
  });
  assert.equal(usage.total.totalTokens, 32 + 4 + 2 + 13);
  assert.equal(usage.modelContextWindow, 128000);
});

test('Codex last usage is the latest DSH call sample and final usage replaces same-step chunk', () => {
  const { ctx, session } = fixture();
  const usage = codexThreadTokenUsage({ ctx, session });
  assert.deepEqual(usage.last, {
    totalTokens: 27,
    inputTokens: 20,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 7,
    reasoningOutputTokens: 3
  });
  assert.equal(usage.total.reasoningOutputTokens, 5 + 3, 'chunk reasoning must not be double counted');
});

test('notification matches pinned Codex thread/tokenUsage/updated envelope', () => {
  const { ctx, session } = fixture();
  const notification = tokenUsageNotification({
    ctx,
    session,
    threadId: 'session-1',
    turnId: 'dsh-turn-1'
  });
  assert.equal(notification.method, 'thread/tokenUsage/updated');
  assert.equal(notification.params.threadId, 'session-1');
  assert.equal(notification.params.turnId, 'dsh-turn-1');
  assert.equal(notification.params.tokenUsage.modelContextWindow, 128000);
});

test('missing optional DSH projection omits footer update instead of inventing usage', () => {
  const session = { events: [] };
  const ctx = { get() { return undefined; } };
  assert.equal(codexThreadTokenUsage({ ctx, session }), null);
  assert.equal(tokenUsageNotification({ ctx, session, threadId: 's', turnId: 't' }), null);
});
