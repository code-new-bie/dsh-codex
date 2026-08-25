import assert from 'node:assert/strict';
import test from 'node:test';
import { DshApprovalBridge } from '../src/dsh/approval-bridge.mjs';

function fixture({ classify, brokerResult = { decision: 'accept' }, brokerError = null } = {}) {
  let listener;
  let disposed = false;
  const requests = [];
  const diagnostics = [];
  const agent = {
    id: 'session-1',
    ctx: {
      on(name, fn) {
        assert.equal(name, 'approval/request');
        listener = fn;
        return () => { disposed = true; listener = undefined; };
      }
    }
  };
  const broker = {
    async request(method, params, options) {
      requests.push({ method, params, options });
      if (brokerError) throw brokerError;
      return brokerResult;
    }
  };
  const bridge = new DshApprovalBridge({
    agent,
    broker,
    classify: classify ?? (() => ({
      kind: 'command',
      threadId: 'session-1',
      turnId: 'dsh-turn-1',
      itemId: 'dsh-tool-call-1',
      command: 'npm test',
      cwd: '/workspace'
    })),
    diagnostics: (message) => diagnostics.push(message)
  });
  return {
    bridge,
    requests,
    diagnostics,
    invoke(req, next = async () => 'unavailable') { return listener(req, next); },
    get disposed() { return disposed; }
  };
}

test('command approval is rendered through Codex command approval and maps accept to allowed-once', async () => {
  const fx = fixture();
  const outcome = await fx.invoke({ toolName: 'bash', callId: 'call-1', reason: 'needs wider write access' });
  assert.equal(outcome, 'allowed-once');
  assert.equal(fx.requests.length, 1);
  assert.equal(fx.requests[0].method, 'item/commandExecution/requestApproval');
  assert.equal(fx.requests[0].params.command, 'npm test');
  assert.equal(fx.requests[0].params.cwd, '/workspace');
  assert.equal(fx.requests[0].params.reason, 'needs wider write access');
});

test('file approval uses Codex file-change approval only when classifier proves the semantics', async () => {
  const fx = fixture({
    classify: () => ({ kind: 'fileChange', threadId: 'session-1', turnId: 'dsh-turn-2', itemId: 'file-1' }),
    brokerResult: { decision: 'decline' }
  });
  assert.equal(await fx.invoke({ toolName: 'edit', callId: 'call-2' }), 'rejected');
  assert.equal(fx.requests[0].method, 'item/fileChange/requestApproval');
  assert.equal(fx.requests[0].params.grantRoot, null);
});

test('unknown DSH tool approval delegates instead of being mislabeled as shell/file', async () => {
  const fx = fixture({ classify: () => null });
  let delegated = 0;
  const outcome = await fx.invoke(
    { toolName: 'plugin-owned-tool', callId: 'call-x' },
    async () => { delegated += 1; return 'rejected'; }
  );
  assert.equal(outcome, 'rejected');
  assert.equal(delegated, 1);
  assert.equal(fx.requests.length, 0);
});

test('Codex acceptForSession fails closed because DSH exposes no equivalent grant', async () => {
  const fx = fixture({ brokerResult: { decision: 'acceptForSession' } });
  const outcome = await fx.invoke({ toolName: 'bash', callId: 'call-1' });
  assert.equal(outcome, 'unavailable');
  assert.match(fx.diagnostics[0], /no session-wide approval grant/);
});

test('transport errors fail closed as unavailable', async () => {
  const fx = fixture({ brokerError: new Error('UI disconnected') });
  const outcome = await fx.invoke({ toolName: 'bash', callId: 'call-1' });
  assert.equal(outcome, 'unavailable');
  assert.equal(fx.diagnostics[0], 'UI disconnected');
});

test('aborted DSH request settles cancelled, never granted', async () => {
  const controller = new AbortController();
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const fx = fixture({ brokerError: abort });
  controller.abort();
  const outcome = await fx.invoke({ toolName: 'bash', callId: 'call-1', signal: controller.signal });
  assert.equal(outcome, 'cancelled');
});

test('disposing bridge removes only its presentation answerer', () => {
  const fx = fixture();
  fx.bridge.dispose();
  assert.equal(fx.disposed, true);
});
