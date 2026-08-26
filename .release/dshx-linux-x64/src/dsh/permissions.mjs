function requireService(ctx, name) {
  const service = ctx.get(name);
  if (service === undefined) throw new Error(`DSHX requires DSH service: ${name}`);
  return service;
}

function codexApprovalPolicy(policy) {
  if (policy === 'ask') return 'on-request';
  if (policy === 'never') return 'never';
  throw new Error(`Unsupported DSH approval policy: ${String(policy)}`);
}

/**
 * Project official DSH permission state into Codex-facing presentation data.
 *
 * DSH sandbox modes govern filesystem effects only; Codex legacy sandbox
 * shapes also encode network policy. To avoid claiming Codex-native sandbox
 * semantics that DSH does not own, confined DSH modes are advertised as an
 * external sandbox. `legacyNetworkAccess` describes only the legacy Codex
 * field and never changes DSH enforcement.
 */
export class DshPermissionView {
  constructor(ctx, { legacyNetworkAccess = 'enabled' } = {}) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshPermissionView requires a Cordis Context');
    if (!['enabled', 'restricted'].includes(legacyNetworkAccess)) {
      throw new Error('legacyNetworkAccess must be "enabled" or "restricted"');
    }
    this.ctx = ctx;
    this.legacyNetworkAccess = legacyNetworkAccess;
  }

  current(agent) {
    if (!agent?.session) throw new Error('DshPermissionView.current requires a live DSH Agent');
    const presets = requireService(this.ctx, 'permissionPresets');
    const sandboxPolicy = requireService(this.ctx, 'sandboxPolicy');
    const approval = requireService(this.ctx, 'approval');
    const session = agent.session;

    const preset = presets.current(session.events);
    const options = [
      ...presets.names.map((name) => presets.optionOf(name)),
      ...(preset === 'custom' ? [presets.optionOf('custom')] : [])
    ];
    const resolvedSandbox = sandboxPolicy.resolve({ session });
    const approvalPolicy = approval.overrideOf(session) ?? approval.config?.policy ?? 'ask';

    let sandbox;
    if (resolvedSandbox.mode === 'danger-full-access') {
      sandbox = { type: 'dangerFullAccess' };
    } else if (resolvedSandbox.mode === 'read-only' || resolvedSandbox.mode === 'workspace-write') {
      sandbox = { type: 'externalSandbox', networkAccess: this.legacyNetworkAccess };
    } else {
      throw new Error(`Unsupported DSH sandbox mode: ${String(resolvedSandbox.mode)}`);
    }

    return {
      preset,
      options,
      dsh: {
        sandboxMode: resolvedSandbox.mode,
        workspaceRoot: resolvedSandbox.workspaceRoot,
        approvalPolicy
      },
      codex: {
        approvalPolicy: codexApprovalPolicy(approvalPolicy),
        approvalsReviewer: 'user',
        sandbox
      }
    };
  }

  set(agent, presetName) {
    if (!agent?.session) throw new Error('DshPermissionView.set requires a live DSH Agent');
    const presets = requireService(this.ctx, 'permissionPresets');
    presets.set(agent.session, presetName);
  }
}

export function mapDshApprovalOutcomeToCodexDecision(outcome) {
  switch (outcome) {
    case 'allowed-once':
      return 'accept';
    case 'rejected':
    case 'unavailable':
      return 'decline';
    case 'cancelled':
      return 'cancel';
    default:
      throw new Error(`Unknown DSH approval outcome: ${String(outcome)}`);
  }
}

export function mapCodexDecisionToDshApprovalOutcome(decision) {
  switch (decision) {
    case 'accept':
      return 'allowed-once';
    case 'decline':
      return 'rejected';
    case 'cancel':
      return 'cancelled';
    case 'acceptForSession':
      throw new Error('DSH has no session-wide approval grant; DSHX must not offer acceptForSession');
    default:
      throw new Error('Codex approval decision has no faithful DSH one-shot mapping');
  }
}
