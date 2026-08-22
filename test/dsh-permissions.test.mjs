import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DshPermissionView,
  mapCodexDecisionToDshApprovalOutcome,
  mapDshApprovalOutcomeToCodexDecision
} from '../src/dsh/permissions.mjs';

function fixture({ sandboxMode = 'workspace-write', approvalPolicy = 'ask', currentPreset = 'workspace-write' } = {}) {
  const calls = [];
  const session = { events: [], id: 'session-1' };
  const agent = { session };
  const specs = {
    'workspace-write': {
      sandbox: 'workspace-write',
      approval: 'ask',
      name: 'Workspace write',
      description: 'Write in workspace with approval prompts.'
    },
    'danger-full-access': {
      sandbox: 'danger-full-access',
      approval: 'never',
      name: 'Full access',
      description: 'Unconfined file access.'
    }
  };
  const services = {
    permissionPresets: {
      names: Object.keys(specs),
      current(events) { calls.push(['permissionPresets.current', events]); return currentPreset; },
      optionOf(name) {
        if (name === 'custom') return { value: 'custom', name: 'Custom' };
        return { value: name, name: specs[name].name, description: specs[name].description };
      },
      resolve(name) { return specs[name]; },
      set(target, name) { calls.push(['permissionPresets.set', target, name]); }
    },
    sandboxPolicy: {
      resolve({ session: target }) {
        calls.push(['sandboxPolicy.resolve', target]);
        return { mode: sandboxMode, workspaceRoot: '/workspace', sessionId: target.id };
      }
    },
    approval: {
      config: { policy: approvalPolicy },
      overrideOf(target) { calls.push(['approval.overrideOf', target]); return undefined; }
    }
  };
  return {
    agent,
    calls,
    ctx: { get(name) { return services[name]; } }
  };
}

test('workspace-write is presented as external sandbox, not fake Codex-native workspaceWrite', () => {
  const fx = fixture();
  const view = new DshPermissionView(fx.ctx);
  const current = view.current(fx.agent);

  assert.equal(current.preset, 'workspace-write');
  assert.equal(current.dsh.sandboxMode, 'workspace-write');
  assert.equal(current.dsh.approvalPolicy, 'ask');
  assert.deepEqual(current.codex, {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'externalSandbox', networkAccess: 'enabled' }
  });
});

test('danger-full-access has an exact Codex legacy sandbox representation', () => {
  const fx = fixture({
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    currentPreset: 'danger-full-access'
  });
  const current = new DshPermissionView(fx.ctx).current(fx.agent);
  assert.deepEqual(current.codex, {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' }
  });
});

test('custom preset is presentation-only and included only when actually current', () => {
  const fx = fixture({ sandboxMode: 'read-only', currentPreset: 'custom' });
  const current = new DshPermissionView(fx.ctx, { legacyNetworkAccess: 'restricted' }).current(fx.agent);
  assert.equal(current.preset, 'custom');
  assert.equal(current.options.at(-1).value, 'custom');
  assert.deepEqual(current.codex.sandbox, { type: 'externalSandbox', networkAccess: 'restricted' });
});

test('permission changes delegate to the official permissionPresets setter', () => {
  const fx = fixture();
  const view = new DshPermissionView(fx.ctx);
  view.set(fx.agent, 'danger-full-access');
  assert.deepEqual(fx.calls.find(([name]) => name === 'permissionPresets.set'), [
    'permissionPresets.set',
    fx.agent.session,
    'danger-full-access'
  ]);
});

test('DSH approval outcomes map only to Codex decisions with matching semantics', () => {
  assert.equal(mapDshApprovalOutcomeToCodexDecision('allowed-once'), 'accept');
  assert.equal(mapDshApprovalOutcomeToCodexDecision('rejected'), 'decline');
  assert.equal(mapDshApprovalOutcomeToCodexDecision('unavailable'), 'decline');
  assert.equal(mapDshApprovalOutcomeToCodexDecision('cancelled'), 'cancel');
});

test('Codex persistent approval is rejected because DSH exposes only allowed-once', () => {
  assert.equal(mapCodexDecisionToDshApprovalOutcome('accept'), 'allowed-once');
  assert.equal(mapCodexDecisionToDshApprovalOutcome('decline'), 'rejected');
  assert.equal(mapCodexDecisionToDshApprovalOutcome('cancel'), 'cancelled');
  assert.throws(
    () => mapCodexDecisionToDshApprovalOutcome('acceptForSession'),
    /no session-wide approval grant/
  );
});

test('missing permission service is a hard compatibility error', () => {
  const view = new DshPermissionView({ get() { return undefined; } });
  assert.throws(() => view.current({ session: { events: [] } }), /permissionPresets/);
});
