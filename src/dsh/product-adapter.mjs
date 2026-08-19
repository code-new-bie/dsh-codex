import path from 'node:path';
import { DshAppServerAdapter } from './app-server-adapter.mjs';
import { dshSkillsListEntry } from './skills.mjs';

function textInput(params) {
  const inputs = Array.isArray(params?.input) ? params.input : [];
  const unsupported = inputs.filter((item) => item?.type !== 'text');
  if (unsupported.length > 0) {
    throw new Error(`DSHX steer currently supports Codex text items only; got ${unsupported.map((item) => item?.type).join(', ')}`);
  }
  return inputs.map((item) => item.text ?? '').join('\n').trim();
}

function dshPermissionPreset(ctx, codexId) {
  const presets = ctx.get('permissionPresets');
  if (!presets) throw new Error('DSHX requires DSH service: permissionPresets');
  const mapped = codexId === ':workspace'
    ? 'workspace-write'
    : codexId === ':danger-full-access'
      ? 'danger-full-access'
      : codexId === ':read-only'
        ? 'read-only'
        : codexId;
  if (!presets.names.includes(mapped)) {
    throw new Error(`DSH has no permission preset corresponding to Codex profile ${JSON.stringify(codexId)}`);
  }
  return mapped;
}

function codexPermissionProfileId(preset) {
  if (preset === 'workspace-write') return ':workspace';
  if (preset === 'danger-full-access') return ':danger-full-access';
  if (preset === 'read-only') return ':read-only';
  if (preset === 'custom' || preset == null) return null;
  return preset;
}

function hasSupportedThreadSetting(params) {
  return params.model != null
    || params.effort != null
    || params.permissions != null
    || params.approvalPolicy != null;
}

/**
 * Product-level protocol tail on top of the stable DSH public API adapter.
 * Keep feature-specific compatibility decisions here instead of widening the
 * runtime-owning base: every method still delegates to official DSH services.
 */
export class DshxProductAdapter extends DshAppServerAdapter {
  async dispatch(method, params) {
    switch (method) {
      case 'skills/list':
        return this.skillsList(params);
      case 'thread/settings/update':
        return this.threadSettingsUpdate(params);
      case 'turn/steer':
        return this.turnSteer(params);
      default:
        return super.dispatch(method, params);
    }
  }

  threadResponse(agent, options = {}) {
    const response = super.threadResponse(agent, options);
    const permission = this.permissions.current(agent);
    const id = codexPermissionProfileId(permission.preset);
    return {
      ...response,
      activePermissionProfile: id == null ? null : { id }
    };
  }

  async applyStartPermissions(agent, params = {}) {
    if (params.permissions == null) return super.applyStartPermissions(agent, params);
    if (params.sandbox != null) {
      throw new Error('Codex thread/start permissions and sandbox cannot both be selected for DSHX');
    }
    const preset = dshPermissionPreset(this.ctx, String(params.permissions));
    this.permissions.set(agent, preset);
    const current = this.permissions.current(agent);
    if (params.approvalPolicy != null && current.codex.approvalPolicy !== params.approvalPolicy) {
      throw new Error(
        `DSH preset ${preset} does not match requested Codex approval policy ${JSON.stringify(params.approvalPolicy)}`
      );
    }
    return current;
  }

  async skillsList(params = {}) {
    if (params.forceReload === true) {
      throw new Error(
        'DSHX cannot honor Codex forceReload: DSH skill cache invalidation is provider-owned; retry after the DSH provider emits skills/change'
      );
    }
    const cwds = Array.isArray(params.cwds) && params.cwds.length > 0
      ? params.cwds.map((cwd) => path.resolve(cwd))
      : [this.cwd];
    const data = await Promise.all(cwds.map((cwd) => dshSkillsListEntry({
      ctx: this.ctx,
      cwd,
      diagnostics: this.diagnostics
    })));
    return { result: { data } };
  }

  async threadSettingsUpdate(params = {}) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${threadId}`);
    const agent = controller.agent;

    if (params.cwd != null) {
      const currentCwd = path.resolve(agent.session.header?.cwd ?? this.cwd);
      if (path.resolve(params.cwd) !== currentCwd) {
        throw new Error('DSHX does not retarget a live DSH session cwd from the TUI');
      }
    }
    if (params.sandboxPolicy != null) {
      throw new Error('DSHX changes permissions through DSH named permission presets, not Codex legacy sandboxPolicy');
    }
    if (params.serviceTier !== undefined) {
      throw new Error('DSH has no public thread service-tier setter for DSHX to project');
    }
    if (params.summary != null) {
      throw new Error('DSH has no equivalent public reasoning-summary thread setting');
    }
    if (params.personality != null) {
      throw new Error('DSH has no equivalent public personality thread setting');
    }
    if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user') {
      throw new Error('DSH approval review is user-owned; DSHX cannot select a Codex-specific reviewer');
    }

    const supported = hasSupportedThreadSetting(params);
    if (params.collaborationMode != null && !supported) {
      throw new Error('DSH has no equivalent public collaboration-mode thread setting');
    }

    if (params.permissions != null || params.approvalPolicy != null) {
      await this.applyStartPermissions(agent, {
        permissions: params.permissions,
        approvalPolicy: params.approvalPolicy
      });
    }
    if (params.model != null || params.effort != null) {
      await this.applyModelOverride(agent, {
        model: params.model,
        effort: params.effort
      });
    }

    return { result: {} };
  }

  turnSteer(params = {}) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${threadId}`);
    const location = controller.currentLocation();
    if (!location) throw new Error(`Thread has no active DSH turn to steer: ${threadId}`);
    if (typeof params.expectedTurnId !== 'string' || params.expectedTurnId !== location.turnId) {
      throw new Error(
        `DSHX steer expectedTurnId ${JSON.stringify(params.expectedTurnId)} does not match active DSH turn ${location.turnId}`
      );
    }
    controller.steer(textInput(params));
    return { result: { turnId: location.turnId } };
  }
}
