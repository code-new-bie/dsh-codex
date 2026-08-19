import path from 'node:path';
import { DshAppServerAdapter } from './app-server-adapter.mjs';
import { executeDshCommand } from './commands.mjs';
import { dshThreadItemsPage, dshThreadTurnsPage } from './history-pages.mjs';
import { DshHostApi } from './host-api.mjs';
import { codexForkAtSeq } from './session-fork.mjs';
import { dshSkillsListEntry } from './skills.mjs';
import { persistedTokenUsageNotification } from './token-usage.mjs';

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
      case 'account/usage/read':
        return this.accountUsageRead(params);
      case 'skills/list':
        return this.skillsList(params);
      case 'thread/compact/start':
        return this.threadCompactStart(params);
      case 'thread/fork':
        return this.threadFork(params);
      case 'thread/turns/list':
        return this.threadTurnsList(params);
      case 'thread/items/list':
        return this.threadItemsList(params);
      case 'thread/settings/update':
        return this.threadSettingsUpdate(params);
      case 'thread/unsubscribe':
        return this.threadUnsubscribeWithStatus(params);
      case 'turn/interrupt':
        return this.turnInterruptProduct(params);
      case 'turn/steer':
        return this.turnSteer(params);
      default:
        return super.dispatch(method, params);
    }
  }

  accountUsageRead(_params = {}) {
    // Codex's account/usage/read is a billing API (credits/USD estimates), not
    // a generic token counter. DSH token/context accounting is surfaced through
    // thread/tokenUsage/updated instead. Returning threadUsage:null tells the
    // Codex UI that billing usage is unavailable without inventing zero cost.
    return {
      result: {
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null
        },
        dailyUsageBuckets: null,
        threadUsage: null
      }
    };
  }

  manualCompactions() {
    return this._manualCompactions ??= new Map();
  }

  hostApi() {
    return this._hostApi ??= new DshHostApi(this.ctx, { cwd: this.cwd });
  }

  warnThread(threadId, message) {
    this.send({ method: 'warning', params: { threadId, message } });
  }

  threadResponse(agent, options = {}) {
    const response = super.threadResponse(agent, options);
    const permission = this.permissions.current(agent);
    const id = codexPermissionProfileId(permission.preset);
    return {
      ...response,
      runtimeWorkspaceRoots: [],
      activePermissionProfile: id == null ? null : { id, extends: null },
      multiAgentMode: 'explicitRequestOnly',
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null
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
    // Pinned Codex uses forceReload=true for its ordinary asynchronous startup
    // catalog refresh. DSH provider invalidation is not a presentation-owned
    // operation, so DSHX treats this bit as a request for a fresh authoritative
    // registry snapshot rather than pretending to flush provider caches.
    if (params.forceReload === true) {
      this.diagnostics('Codex requested skills forceReload; DSHX is reading the current DSH registry snapshot without overriding provider-owned cache policy');
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

  threadCompactStart(params = {}) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${threadId}`);
    const active = this.manualCompactions();
    if (active.has(threadId)) {
      throw new Error('Compaction is unavailable because this thread already has an active manual compaction');
    }
    const abortController = new AbortController();
    active.set(threadId, abortController);
    return {
      result: {},
      afterResponse: () => {
        void this.runManualCompaction({ threadId, controller, abortController });
      }
    };
  }

  async runManualCompaction({ threadId, controller, abortController }) {
    try {
      const execution = await executeDshCommand({
        ctx: controller.agent.ctx ?? this.ctx,
        agent: controller.agent,
        line: '/compact',
        signal: abortController.signal
      });
      // A successful real compaction is rendered from DSH's durable
      // compaction/* events. A no-op has no such event, so surface the official
      // command text instead of leaving the user without feedback.
      if (execution.result?.sourceEventSeq == null && execution.result?.text) {
        this.warnThread(threadId, execution.result.text);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        this.warnThread(threadId, 'Compaction cancelled.');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.warnThread(threadId, message);
        this.diagnostics(`manual compaction failed for ${threadId}: ${message}`);
      }
    } finally {
      if (this.manualCompactions().get(threadId) === abortController) {
        this.manualCompactions().delete(threadId);
      }
    }
  }

  turnInterruptProduct(params = {}) {
    const threadId = String(params.threadId ?? '');
    if (String(params.turnId ?? '').startsWith('dsh-maintenance-compaction-')) {
      const active = this.manualCompactions().get(threadId);
      if (active) {
        active.abort(new Error('user cancelled DSH compaction'));
        return { result: {} };
      }
    }
    return super.turnInterrupt(params);
  }

  async threadResume(params = {}) {
    if (!params.threadId) throw new Error('thread/resume requires threadId');
    const threadId = String(params.threadId);
    let controller = this.controllers.get(threadId);
    if (!controller) {
      const live = this.driver.getLive(threadId);
      const handle = live
        ? { agent: live, dispose: async () => {} }
        : await this.driver.resume(threadId);
      controller = this.installController(handle);
    }
    const agent = controller.agent;
    if (params.cwd != null && path.resolve(params.cwd) !== path.resolve(agent.session.header?.cwd ?? this.cwd)) {
      throw new Error('DSHX does not override a persisted DSH session cwd during resume');
    }
    await this.applyModelOverride(agent, params);
    await this.applyStartPermissions(agent, params);
    const result = this.threadResponse(agent, {
      includeTurns: params.excludeTurns !== true
    });
    const replay = persistedTokenUsageNotification({
      ctx: this.ctx,
      session: agent.session,
      threadId
    });
    return {
      result,
      afterResponse: replay ? () => this.send(replay) : undefined
    };
  }

  async forkSourceEvents(sourceId) {
    const live = this.controllers.get(sourceId)?.agent ?? this.driver.getLive(sourceId);
    if (live?.session) return live.session.events ?? [];
    const inspected = await this.driver.inspectSession(sourceId);
    if (!inspected) throw new Error(`Unknown DSH session: ${sourceId}`);
    return inspected.events ?? [];
  }

  async threadFork(params = {}) {
    const sourceId = String(params.threadId ?? '');
    if (!sourceId) throw new Error('thread/fork requires threadId');
    if (params.path != null) throw new Error('DSHX forks DSH sessions by threadId, not Codex rollout paths');
    if (params.deferGoalContinuation === true) {
      throw new Error('DSH has no Codex thread-goal continuation state for DSHX to defer');
    }
    if (params.ephemeral === true) {
      throw new Error('DSHX does not expose ephemeral Codex forks over durable DSH sessions');
    }

    const events = await this.forkSourceEvents(sourceId);
    const atSeq = codexForkAtSeq(events, {
      lastTurnId: params.lastTurnId,
      beforeTurnId: params.beforeTurnId
    });
    const forked = await this.hostApi().forkSession({ sessionId: sourceId, atSeq });
    const childId = String(forked?.sessionId ?? '');
    if (!childId) throw new Error('DSH Host fork returned no child session id');

    // DSH Host publishes the child Agent transactionally. DSHX attaches only a
    // presentation controller and does not own the AgentHandle or inherited
    // model/lineage/workspace semantics.
    const childAgent = this.driver.getLive(childId);
    if (!childAgent) throw new Error(`DSH Host fork did not publish child Agent ${childId}`);
    const controller = this.installController({ agent: childAgent, dispose: async () => {} });
    const result = this.threadResponse(controller.agent, {
      includeTurns: params.excludeTurns !== true
    });
    return {
      result,
      afterResponse: () => this.send({ method: 'thread/started', params: { thread: result.thread } })
    };
  }

  historyController(threadId) {
    const controller = this.controllers.get(String(threadId ?? ''));
    if (!controller) {
      throw new Error(`Thread must be resumed before paginated DSH history is rendered: ${String(threadId ?? '')}`);
    }
    return controller;
  }

  threadTurnsList(params = {}) {
    const controller = this.historyController(params.threadId);
    return {
      result: dshThreadTurnsPage({
        controller,
        params,
        diagnostics: this.diagnostics
      })
    };
  }

  threadItemsList(params = {}) {
    const controller = this.historyController(params.threadId);
    return {
      result: dshThreadItemsPage({
        controller,
        params,
        diagnostics: this.diagnostics
      })
    };
  }

  async threadUnsubscribeWithStatus(params = {}) {
    const threadId = String(params.threadId ?? '');
    this.manualCompactions().get(threadId)?.abort(new Error('thread unsubscribed'));
    const subscribed = this.controllers.has(threadId);
    const loaded = Boolean(this.driver.getLive(threadId));
    await super.threadUnsubscribe(params);
    return {
      result: {
        status: subscribed ? 'unsubscribed' : loaded ? 'notSubscribed' : 'notLoaded'
      }
    };
  }

  async saveDefaultModelSelection(selection) {
    const defaults = this.ctx.get('agentDefaultModel');
    if (!defaults?.saveSelection) {
      this.diagnostics('DSH agentDefaultModel service has no saveSelection(); current session selection remains valid but deployment default was not persisted');
      return;
    }
    await defaults.saveSelection({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort == null ? {} : { reasoningEffort: selection.reasoningEffort })
    });
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
      const selection = await this.applyModelOverride(agent, {
        model: params.model,
        effort: params.effort
      });
      await this.saveDefaultModelSelection(selection);
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

  async close() {
    for (const controller of this.manualCompactions().values()) {
      controller.abort(new Error('DSHX adapter closing'));
    }
    this.manualCompactions().clear();
    await super.close();
  }
}
