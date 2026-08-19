import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexCollaborationMode,
  codexPlanTarget,
  effectiveDshPlanState,
  threadSettingsUpdatedNotification
} from '../src/dsh/plan-presentation.mjs';

test('Codex plan/default modes map only to the DSH boolean plan target', () => {
  assert.equal(codexPlanTarget({ mode: 'plan', settings: {} }), true);
  assert.equal(codexPlanTarget({ mode: 'default', settings: {} }), false);
  assert.throws(() => codexPlanTarget({ mode: 'review', settings: {} }), /cannot map Codex collaboration mode/);
  assert.throws(() => codexPlanTarget(null), /must be a Codex collaboration mode object/);
});

test('pending DSH plan selection is the effective UI state until committed', () => {
  assert.equal(effectiveDshPlanState({ active: false, pending: true }), true);
  assert.equal(effectiveDshPlanState({ active: true, pending: false }), false);
  assert.equal(effectiveDshPlanState({ active: true }), true);
  assert.equal(effectiveDshPlanState({ active: false }), false);
});

test('Codex collaboration presentation never copies developer instructions into DSH state', () => {
  assert.deepEqual(codexCollaborationMode({
    model: 'dshx:model',
    reasoningEffort: 'high',
    active: true
  }), {
    mode: 'plan',
    settings: {
      model: 'dshx:model',
      reasoning_effort: 'high',
      developer_instructions: null
    }
  });
});

test('thread settings notification projects DSH plan state into pinned Codex wire shape', () => {
  const notification = threadSettingsUpdatedNotification({
    threadId: 'session-1',
    response: {
      cwd: '/workspace',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      activePermissionProfile: { id: ':workspace', extends: null },
      model: 'dshx:model',
      modelProvider: 'deepseek',
      serviceTier: null,
      reasoningEffort: null,
      multiAgentMode: 'explicitRequestOnly'
    },
    planState: { active: false, pending: true }
  });

  assert.equal(notification.method, 'thread/settings/updated');
  assert.equal(notification.params.threadId, 'session-1');
  assert.equal(notification.params.threadSettings.collaborationMode.mode, 'plan');
  assert.deepEqual(notification.params.threadSettings.collaborationMode.settings, {
    model: 'dshx:model',
    reasoning_effort: null,
    developer_instructions: null
  });
  assert.equal(notification.params.threadSettings.activePermissionProfile.id, ':workspace');
  assert.equal(notification.params.threadSettings.summary, null);
  assert.equal(notification.params.threadSettings.personality, null);
});
