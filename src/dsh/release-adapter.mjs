import path from 'node:path';
import { decodeDshModel, dshThreadFromSnapshot, normalizeCodexEffort } from './codex-shapes.mjs';
import { DshxProductAdapter } from './product-adapter.mjs';
import { codexPlanTarget, threadSettingsUpdatedNotification } from './plan-presentation.mjs';
import { foldDshSessionTitle, threadNameUpdatedNotification } from './thread-title.mjs';
import { codexInputToDshContent, dshContentText } from './user-input.mjs';
import { DshUserShellBridge } from './user-shell.mjs';
import { DshWorkspaceCommandBridge } from './workspace-command.mjs';

function snapshotTitle(snapshot) {
  return typeof snapshot?.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null;
}

function isDshSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent';
}

/**
 * Final product-facing protocol tail. Keep small metadata/UI compatibility
 * extensions here so the core DSH public adapter remains stable and auditable.
 */
export class DshxReleaseAdapter extends DshxProductAdapter {
  async ensureReady() {
    await super.ensureReady();
    if (this._agentPresentationDisposers) return;
    this._agentPresentationDisposers = [
      this.ctx.on('agent/created', ({ agent }) => {
        if (!isDshSubagent(agent)) return;
        try {
          this.send({ method: 'thread/started', params: { thread: this.liveAgentThread(agent) } });
        } catch (error) {
          this.diagnostics(`subagent thread/started projection failed for ${String(agent?.id ?? '')}: ${error instanceof Error ? error.message : error}`);
        }
      }),
      this.ctx.on('agent/status', ({ agent, status }) => {
        try {
          this.send({
            method: 'thread/status/changed',
            params: {
              threadId: String(agent.id),
              status: status === 'running' ? { type: 'active', activeFlags: [] } : { type: 'idle' }
            }
          });
        } catch (error) {
          this.diagnostics(`agent status projection failed for ${String(agent?.id ?? '')}: ${error instanceof Error ? error.message : error}`);
        }
      }),
      this.ctx.on('agent/disposed', ({ agent }) => {
        try {
          this.send({
            method: 'thread/status/changed',
            params: { threadId: String(agent.id), status: { type: 'notLoaded' } }
          });
        } catch (error) {
          this.diagnostics(`agent disposal projection failed for ${String(agent?.id ?? '')}: ${error instanceof Error ? error.message : error}`);
        }
      })
    ];
  }

  userShell() {
    return this._userShell ??= new DshUserShellBridge({
      send: this.send,
      diagnostics: this.diagnostics
    });
  }

  workspaceCommands() {
    return this._workspaceCommands ??= new DshWorkspaceCommandBridge({ driver: this.driver });
  }

  planListeners() {
    return this._planListeners ??= new Map();
  }

  planMutationSuppressed() {
    return this._planMutationSuppressed ??= new Set();
  }

  planMode(agent) {
    const service = agent?.ctx?.get?.('planMode') ?? this.ctx.get('planMode');
    if (!service?.set || !service?.get) throw new Error('DSHX requires DSH service: planMode');
    return service;
  }

  planSettingsNotification(agent) {
    const response = this.threadResponse(agent);
    return threadSettingsUpdatedNotification({
      threadId: String(agent.id),
      response,
      planState: this.planMode(agent).get(agent)
    });
  }

  liveAgentThread(agent) {
    const thread = dshThreadFromSnapshot({
      meta: agent.session.header,
      events: agent.session.events ?? [],
      model: agent.session.requestHeader?.()?.config,
      loaded: true,
      cliVersion: this.version
    });
    const title = snapshotTitle(this.driver.currentTitle(agent)) ?? foldDshSessionTitle(agent.session.events ?? []);
    return {
      ...thread,
      status: agent.status === 'running' ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      name: title,
      turns: []
    };
  }

  loadedThreadList() {
    // Pinned Codex ThreadLoadedListResponse.data is Array<string>. Keep rich
    // thread metadata on thread/list/read/started and expose only live IDs here.
    return {
      result: {
        data: this.driver.listLive().map((agent) => String(agent.id))
      }
    };
  }

  directController(threadId, operation) {
    const controller = this.controllers.get(String(threadId ?? ''));
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${String(threadId ?? '')}`);
    if (isDshSubagent(controller.agent)) {
      throw new Error(`DSHX refuses ${operation} on a DSH subagent; child runtime control remains owned by ctx.subagents`);
    }
    return controller;
  }

  async interruptSubagent(controller) {
    const parentSessionId = controller.agent.session.header?.parentSession;
    if (parentSessionId == null) throw new Error('DSH subagent is missing durable parentSession authority');
    const subagents = this.ctx.get('subagents');
    if (!subagents?.interrupt) throw new Error('DSHX requires DSH service: subagents.interrupt');
    await subagents.interrupt(String(controller.agent.id), {
      kind: 'user',
      parentSessionId: String(parentSessionId)
    });
    return { result: {} };
  }

  installController(handle) {
    const controller = super.installController(handle);
    const threadId = String(controller.agent.id);
    if (!this.planListeners().has(threadId)) {
      const dispose = controller.agent.ctx.on('session/event', (session, event) => {
        if (session !== controller.agent.session || event?.type !== 'plan/mode') return;
        if (this.planMutationSuppressed().has(threadId)) return;
        try {
          this.send(this.planSettingsNotification(controller.agent));
        } catch (error) {
          this.diagnostics(`plan settings projection failed for ${threadId}: ${error instanceof Error ? error.message : error}`);
        }
      });
      this.planListeners().set(threadId, dispose);
    }
    return controller;
  }

  async dispatch(method, params) {
    switch (method) {
      case 'command/exec':
        return this.commandExec(params);
      case 'config/batchWrite':
        return this.configBatchWrite(params);
      case 'thread/loaded/list':
        return this.loadedThreadList();
      case 'thread/fork':
        return this.threadForkPresentation(params);
      case 'thread/name/set':
        return this.threadNameSet(params);
      case 'thread/settings/update':
        return this.threadSettingsUpdatePresentation(params);
      case 'thread/shellCommand':
        return this.threadShellCommand(params);
      case 'thread/compact/start':
        this.directController(params?.threadId, 'direct compaction');
        return super.dispatch(method, params);
      case 'turn/start':
      case 'turn/steer':
        return this.richUserTurn(method, params);
      case 'turn/interrupt': {
        if (this.userShell().interrupt(params?.threadId, params?.turnId)) return { result: {} };
        const controller = this.controllers.get(String(params?.threadId ?? ''));
        if (controller && isDshSubagent(controller.agent)) return this.interruptSubagent(controller);
        return super.dispatch(method, params);
      }
      case 'thread/unsubscribe': {
        const threadId = String(params?.threadId ?? '');
        this.userShell().abortThread(threadId, 'thread unsubscribed');
        this.planListeners().get(threadId)?.();
        this.planListeners().delete(threadId);
        this.planMutationSuppressed().delete(threadId);
        return super.dispatch(method, params);
      }
      default:
        return super.dispatch(method, params);
    }
  }

  async commandExec(params = {}) {
    return { result: await this.workspaceCommands().execute(params) };
  }

  async configBatchWrite(params = {}) {
    const edits = Array.isArray(params.edits) ? params.edits : [];
    if (edits.length === 0) throw new Error('DSHX config/batchWrite requires at least one model-selection edit');

    const supported = new Set(['model', 'model_reasoning_effort']);
    for (const edit of edits) {
      if (!supported.has(edit?.keyPath)) {
        throw new Error(`DSHX config/batchWrite refuses Codex-owned setting: ${String(edit?.keyPath ?? '')}`);
      }
      if (edit?.mergeStrategy != null && edit.mergeStrategy !== 'replace') {
        throw new Error(`DSHX config/batchWrite supports replace semantics only: ${String(edit.keyPath)}`);
      }
    }

    const defaults = this.ctx.get('agentDefaultModel');
    const llm = this.ctx.get('llm');
    if (!defaults?.currentSelection || !defaults?.saveSelection) {
      throw new Error('DSHX requires DSH service: agentDefaultModel.saveSelection');
    }
    if (!llm?.resolveCallConfig) throw new Error('DSHX requires DSH service: llm.resolveCallConfig');

    const current = defaults.currentSelection();
    let requested = { provider: current.provider, model: current.model };
    if (current.reasoningEffort !== undefined) requested.reasoningEffort = current.reasoningEffort;

    const modelEdit = edits.find((edit) => edit.keyPath === 'model');
    if (modelEdit) {
      const decoded = decodeDshModel(modelEdit.value);
      if (!decoded) throw new Error('DSHX persists default models only from its DSH-backed opaque model catalog');
      requested = { ...decoded };
    }

    const effortEdit = edits.find((edit) => edit.keyPath === 'model_reasoning_effort');
    if (effortEdit) {
      const effort = normalizeCodexEffort(effortEdit.value);
      requested = { provider: requested.provider, model: requested.model };
      if (effort !== undefined) requested.reasoningEffort = effort;
    }

    const resolved = await llm.resolveCallConfig(requested);
    const persisted = { provider: resolved.provider, model: resolved.model };
    // Preserve provider-default semantics when the TUI clears its reasoning
    // setting; otherwise persist the DSH-resolved explicit effort.
    if (requested.reasoningEffort !== undefined) {
      persisted.reasoningEffort = resolved.reasoningEffort ?? requested.reasoningEffort;
    }
    await defaults.saveSelection(persisted);

    this._configRevision = (this._configRevision ?? 0) + 1;
    return {
      result: {
        status: 'ok',
        version: `dshx-${this._configRevision}`,
        // Codex requires an absolute path in ConfigWriteResponse. Persistence is
        // actually owned by DSH settings; this marker stays inside presentation home.
        filePath: path.join(this.home, 'dsh-settings'),
        overriddenMetadata: null
      }
    };
  }

  async richUserTurn(method, params = {}) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (!controller) return super.dispatch(method, params);
    if (isDshSubagent(controller.agent)) {
      throw new Error(`DSHX refuses ${method} on a DSH subagent; send/steer authority remains owned by ctx.subagents`);
    }
    const content = await codexInputToDshContent(this.ctx, params.input ?? []);
    const clear = controller.prepareUserContent(content);
    try {
      // Pinned Codex serializes an unset reasoning effort as JSON null. DSH
      // interprets absence as provider default, so never forward null as an
      // explicit provider effort.
      const normalizedParams = params.effort == null ? { ...params, effort: undefined } : params;
      // Preserve the original base/product validation path. The fallback text is
      // consumed only if no prepared rich content exists; it also keeps the
      // base adapter's expected text-only parameter shape intact.
      return await super.dispatch(method, {
        ...normalizedParams,
        input: [{ type: 'text', text: dshContentText(content) }]
      });
    } finally {
      clear();
    }
  }

  threadResponse(agent, options = {}) {
    const response = super.threadResponse(agent, options);
    const folded = this.driver.currentTitle(agent);
    const name = snapshotTitle(folded) ?? foldDshSessionTitle(agent.session?.events ?? []);
    return {
      ...response,
      thread: { ...response.thread, name }
    };
  }

  async threadResume(params = {}) {
    const response = await super.threadResume(params);
    const threadId = String(params.threadId ?? response.result.thread?.id ?? '');
    const agent = this.controllers.get(threadId)?.agent;
    const prior = response.afterResponse;
    return {
      ...response,
      afterResponse: () => {
        prior?.();
        if (agent) this.send(this.planSettingsNotification(agent));
      }
    };
  }

  async threadForkPresentation(params = {}) {
    const response = await super.threadFork(params);
    const startedThread = { ...response.result.thread, turns: [] };
    const agent = this.controllers.get(String(response.result.thread.id))?.agent;
    return {
      ...response,
      // Pinned Codex emits copied history only in the fork response. The
      // thread/started notification introduces metadata/live state and must not
      // replay those copied turns a second time before paginated hydration.
      afterResponse: () => {
        this.send({
          method: 'thread/started',
          params: { thread: startedThread }
        });
        if (agent) this.send(this.planSettingsNotification(agent));
      }
    };
  }

  async threadSettingsUpdatePresentation(params = {}) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (controller && isDshSubagent(controller.agent)) {
      throw new Error('DSHX refuses direct model/permission/plan changes on a DSH subagent; composition remains DSH-owned');
    }
    if (params.collaborationMode == null) return super.threadSettingsUpdate(params);
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${threadId}`);
    const active = codexPlanTarget(params.collaborationMode);
    const { collaborationMode: _ignored, ...ordinary } = params;

    // Let the existing DSH-backed settings adapter validate/apply every other
    // supported field. The collaboration payload's model/reasoning/instructions
    // are intentionally not treated as DSH model or prompt configuration.
    await super.threadSettingsUpdate(ordinary);

    this.planMutationSuppressed().add(threadId);
    try {
      await this.planMode(controller.agent).set(controller.agent, active);
    } finally {
      this.planMutationSuppressed().delete(threadId);
    }

    return {
      result: {},
      afterResponse: () => this.send(this.planSettingsNotification(controller.agent))
    };
  }

  async threadList(params = {}) {
    const response = await super.threadList(params);
    const data = await Promise.all(response.result.data.map(async (thread) => {
      try {
        const snapshot = await this.driver.readTitle(thread.id);
        return { ...thread, name: snapshotTitle(snapshot) ?? thread.name ?? null };
      } catch (error) {
        this.diagnostics(`title read ${thread.id}: ${error instanceof Error ? error.message : error}`);
        return thread;
      }
    }));
    return { result: { ...response.result, data } };
  }

  async threadRead(params = {}) {
    const response = await super.threadRead(params);
    const thread = response.result.thread;
    try {
      const snapshot = await this.driver.readTitle(thread.id);
      return {
        result: {
          ...response.result,
          thread: { ...thread, name: snapshotTitle(snapshot) ?? thread.name ?? null }
        }
      };
    } catch (error) {
      this.diagnostics(`title read ${thread.id}: ${error instanceof Error ? error.message : error}`);
      return response;
    }
  }

  threadShellCommand(params = {}) {
    const controller = this.directController(params.threadId, 'direct shell execution');
    return this.userShell().start(controller, params.command);
  }

  async threadNameSet(params = {}) {
    const threadId = String(params.threadId ?? '');
    if (!threadId) throw new Error('thread/name/set requires threadId');
    if (typeof params.name !== 'string') throw new Error('thread/name/set requires name');

    let temporaryHandle;
    let agent = this.controllers.get(threadId)?.agent ?? this.driver.getLive(threadId);
    if (!agent) {
      temporaryHandle = await this.driver.resume(threadId);
      agent = temporaryHandle.agent;
    }

    try {
      const snapshot = this.driver.renameTitle(agent, params.name);
      const threadName = snapshotTitle(snapshot);
      if (threadName == null) throw new Error('DSH sessionTitle.rename returned no accepted title');
      return {
        result: {},
        afterResponse: () => this.send(threadNameUpdatedNotification(threadId, threadName))
      };
    } finally {
      await temporaryHandle?.dispose?.();
    }
  }

  async close() {
    this._userShell?.close();
    for (const dispose of this._agentPresentationDisposers ?? []) dispose?.();
    this._agentPresentationDisposers = [];
    for (const dispose of this.planListeners().values()) dispose?.();
    this.planListeners().clear();
    this.planMutationSuppressed().clear();
    await super.close();
  }
}

export const releaseAdapterInternals = { snapshotTitle, isDshSubagent };