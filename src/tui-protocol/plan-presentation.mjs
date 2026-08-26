export function codexPlanTarget(collaborationMode) {
  if (!collaborationMode || typeof collaborationMode !== 'object' || Array.isArray(collaborationMode)) {
    throw new Error('DSHX collaborationMode must be a Codex collaboration mode object');
  }
  if (collaborationMode.mode === 'plan') return true;
  if (collaborationMode.mode === 'default') return false;
  throw new Error(`DSHX cannot map Codex collaboration mode ${JSON.stringify(collaborationMode.mode)} to DSH plan mode`);
}

export function effectiveDshPlanState(state) {
  if (typeof state?.pending === 'boolean') return state.pending;
  return Boolean(state?.active);
}

export function codexCollaborationMode({ model, reasoningEffort, active }) {
  return {
    mode: active ? 'plan' : 'default',
    settings: {
      model,
      reasoning_effort: reasoningEffort ?? null,
      // DSH owns plan guidance. Never copy Codex developer instructions into
      // the Harness request just to satisfy a presentation protocol shape.
      developer_instructions: null
    }
  };
}

export function threadSettingsUpdatedNotification({ threadId, response, planState }) {
  const active = effectiveDshPlanState(planState);
  return {
    method: 'thread/settings/updated',
    params: {
      threadId,
      threadSettings: {
        cwd: response.cwd,
        approvalPolicy: response.approvalPolicy,
        approvalsReviewer: response.approvalsReviewer,
        sandboxPolicy: response.sandbox,
        activePermissionProfile: response.activePermissionProfile ?? null,
        model: response.model,
        modelProvider: response.modelProvider,
        serviceTier: response.serviceTier ?? null,
        effort: response.reasoningEffort ?? null,
        summary: null,
        collaborationMode: codexCollaborationMode({
          model: response.model,
          reasoningEffort: response.reasoningEffort,
          active
        }),
        multiAgentMode: response.multiAgentMode ?? 'explicitRequestOnly',
        personality: null
      }
    }
  };
}
