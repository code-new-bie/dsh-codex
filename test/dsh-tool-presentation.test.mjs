import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DshToolPresentationResolver } from '../src/dsh/tool-presentation.mjs';

function fixture(definitions, { cwd = process.cwd() } = {}) {
  const agent = { id: 'session-1' };
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        get(toolName, scope) {
          assert.equal(scope, agent, 'resolver must ask for the Agent-scoped visible tool');
          return definitions[toolName];
        }
      };
    }
  };
  return {
    agent,
    resolver: new DshToolPresentationResolver({
      ctx,
      agent,
      threadId: 'session-1',
      workspaceCwd: cwd
    })
  };
}

function toolResult(callId, { content = [{ type: 'text', text: 'ok' }], isError = false, meta } = {}) {
  return {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content, isError }]
    },
    ...(meta === undefined ? {} : { meta })
  };
}

test('terminal presenter maps to Codex commandExecution and result status/output', () => {
  const cwd = path.resolve('workspace');
  const { resolver } = fixture({
    shell: {
      presentCall(args) {
        assert.deepEqual(args, { cmd: 'echo hi' });
        return { card: 'terminal', title: 'echo hi', cwd: '.' };
      },
      presentResult(_args, result) {
        assert.equal(result.isError, false);
        return { card: 'terminal', output: 'hi\n', exitCode: 0 };
      }
    }
  }, { cwd });

  const started = resolver.start({
    turnId: 'dsh-turn-1',
    callId: 'call-shell',
    name: 'shell',
    rawArguments: '{"cmd":"echo hi"}',
    startedAtMs: 100
  });
  assert.equal(started.item.type, 'commandExecution');
  assert.equal(started.item.command, 'echo hi');
  assert.equal(started.item.cwd, cwd);
  assert.equal(started.item.status, 'inProgress');

  const completed = resolver.complete({
    callId: 'call-shell',
    resultData: toolResult('call-shell'),
    completedAtMs: 125
  });
  assert.equal(completed.item.type, 'commandExecution');
  assert.equal(completed.item.status, 'completed');
  assert.equal(completed.item.aggregatedOutput, 'hi\n');
  assert.equal(completed.item.exitCode, 0);
  assert.equal(completed.item.durationMs, 25);
  assert.deepEqual(resolver.correlation('call-shell'), {
    threadId: 'session-1',
    turnId: 'dsh-turn-1',
    itemId: 'dsh-tool-call-shell',
    semantic: 'command',
    kind: 'command',
    command: 'echo hi',
    cwd
  });
});

test('unambiguous DSH diff update maps to Codex fileChange', () => {
  const { resolver } = fixture({
    editor: {
      presentCall() {
        return {
          card: 'diff',
          title: 'Edit a.txt',
          diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }]
        };
      },
      presentResult() {
        return {
          card: 'diff',
          title: 'Edit a.txt',
          diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }]
        };
      }
    }
  });

  const started = resolver.start({
    turnId: 'dsh-turn-2',
    callId: 'call-edit',
    name: 'editor',
    rawArguments: '{}',
    startedAtMs: 1
  });
  assert.equal(started.item.type, 'fileChange');
  assert.equal(started.item.status, 'inProgress');
  assert.deepEqual(started.item.changes[0].kind, { type: 'update', move_path: null });
  assert.match(started.item.changes[0].diff, /--- a\/a\.txt/);

  const completed = resolver.complete({
    callId: 'call-edit',
    resultData: toolResult('call-edit'),
    completedAtMs: 2
  });
  assert.equal(completed.item.type, 'fileChange');
  assert.equal(completed.item.status, 'completed');
  assert.equal(resolver.correlation('call-edit').kind, 'fileChange');
});

test('ambiguous DSH oldText:null diff stays generic instead of fabricating add/update', () => {
  const { resolver } = fixture({
    writer: {
      presentCall() {
        return {
          card: 'diff',
          title: 'Write a.txt',
          diffs: [{ path: 'a.txt', oldText: null, newText: 'new' }]
        };
      }
    }
  });

  const started = resolver.start({
    turnId: 'dsh-turn-3',
    callId: 'call-write',
    name: 'writer',
    rawArguments: '{"file":"a.txt"}'
  });
  assert.equal(started.item.type, 'dynamicToolCall');
  assert.equal(started.state.semantic, 'generic');
  assert.equal(resolver.correlation('call-write').kind, undefined);
});

test('unknown or presenter-less tools remain generic and preserve text result content', () => {
  const { resolver } = fixture({});
  const started = resolver.start({
    turnId: 'dsh-turn-4',
    callId: 'call-custom',
    name: 'custom',
    rawArguments: '{"x":1}',
    startedAtMs: 10
  });
  assert.equal(started.item.type, 'dynamicToolCall');
  assert.deepEqual(started.item.arguments, { x: 1 });

  const completed = resolver.complete({
    callId: 'call-custom',
    resultData: toolResult('call-custom', { content: [{ type: 'text', text: 'done' }] }),
    completedAtMs: 15
  });
  assert.equal(completed.item.status, 'completed');
  assert.equal(completed.item.success, true);
  assert.deepEqual(completed.item.contentItems, [{ type: 'inputText', text: 'done' }]);
});

test('terminal signal or non-zero exit code fails the Codex command cell', () => {
  const { resolver } = fixture({
    shell: {
      presentCall: () => ({ card: 'terminal', title: 'bad' }),
      presentResult: () => ({ card: 'terminal', output: 'oops', exitCode: 2 })
    }
  });
  resolver.start({ turnId: 'dsh-turn-5', callId: 'call-bad', name: 'shell', rawArguments: '{}' });
  const completed = resolver.complete({ callId: 'call-bad', resultData: toolResult('call-bad') });
  assert.equal(completed.item.status, 'failed');
  assert.equal(completed.item.exitCode, 2);
});
