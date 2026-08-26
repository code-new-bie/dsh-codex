import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DshAgentDriver } from '../dsh/agent-driver.mjs';
import { DshApprovalBridge } from '../dsh/approval-bridge.mjs';
import {
  codexModelsFromDsh,
  decodeDshModel,
  dshThreadFromSnapshot,
  dshTurnsFromSession,
  encodeDshModel,
  normalizeCodexEffort,
  normalizeSessionHeaders
} from './shapes.mjs';
import { executeDshCommand } from '../dsh/commands.mjs';
import { dshThreadItemsPage, dshThreadTurnsPage } from '../dsh/history-pages.mjs';
import { DshHostApi } from '../dsh/host-api.mjs';
import { codexPlanTarget, threadSettingsUpdatedNotification } from '../dsh/plan-presentation.mjs';
import { DshPermissionView } from '../dsh/permissions.mjs';
import { codexForkAtSeq } from '../dsh/session-fork.mjs';
import { dshSkillsListEntry } from '../dsh/skills.mjs';
import { foldDshSessionTitle, threadNameUpdatedNotification } from '../dsh/thread-title.mjs';
import { DshThreadController } from '../dsh/thread-controller.mjs';
import { codexInputToDshContent, dshContentText } from '../dsh/user-input.mjs';
import { DshUserQuestionBridge } from '../dsh/user-question-bridge.mjs';
import { DshUserShellBridge } from '../dsh/user-shell.mjs';
import { persistedTokenUsageNotification } from '../dsh/token-usage.mjs';
import { DshWorkspaceCommandBridge } from '../dsh/workspace-command.mjs';
import { UiRequestBroker } from '../protocol/request-broker.mjs';

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function platformFamily() {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

function platformOs() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

function codexApprovalToDsh(value) {
  if (value == null) return undefined;
  if (value === 'on-request') return 'ask';
  if (value === 'never') return 'never';
  throw new Error(`DSHX cannot map Codex approval policy ${JSON.stringify(value)} to DSH`);
}

// Base turn input validation. Distinct from the steer variant below because
// the two historically reported different unsupported-input messages.
function turnTextInput(params) {
  const inputs = Array.isArray(params?.input) ? params.input : [];
  const unsupported = inputs.filter((item) => item?.type !== 'text');
  if (unsupported.length > 0) {
    throw new Error(`DSHX turn input currently supports Codex text items only; got ${unsupported.map((item) => item?.type).join(', ')}`);
  }
  return inputs.map((item) => item.text ?? '').join('\n').trim();
}

function steerTextInput(params) {
  const inputs = Array.isArray(params?.input) ? params.input : [];
  const unsupported = inputs.filter((item) => item?.type !== 'text');
  if (unsupported.length > 0) {
    throw new Error(`DSHX steer currently supports Codex text items only; got ${unsupported.map((item) => item?.type).join(', ')}`);
  }
  return inputs.map((item) => item.text ?? '').join('\n').trim();
}

function pagination(value, total, defaultLimit = 50) {
  const cursor = value?.cursor == null ? 0 : Number(value.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid pagination cursor');
  const requested = value?.limit == null ? defaultLimit : Number(value.limit);
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('limit must be a positive integer');
  const end = Math.min(total, cursor + requested);
  return { start: cursor, end, nextCursor: end < total ? String(end) : null };
}

function sandboxMatchesCurrent(sandbox, permission) {
  if (sandbox == null) return true;
  if (sandbox.type === 'dangerFullAccess') return permission.dsh.sandboxMode === 'danger-full-access';
  if (sandbox.type === 'externalSandbox') {
    return permission.dsh.sandboxMode === 'read-only' || permission.dsh.sandboxMode === 'workspace-write';
  }
  return false;
}

function fullThreadSnapshot(agent, { includeTurns = false, cliVersion = 'dshx' } = {}) {
  const turns = includeTurns ? dshTurnsFromSession({ ctx: agent.ctx, agent }) : [];
  return dshThreadFromSnapshot({
    meta: agent.session.header,
    events: agent.session.events,
    model: agent.session.requestHeader?.()?.config,
    turns,
    loaded: true,
    cliVersion
  });
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

function snapshotTitle(snapshot) {
  return typeof snapshot?.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null;
}

function isDshSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent';
}

/**
 * Single presentation adapter from pinned Codex app-server JSON-RPC to
 * official DSH public services.
 *
 * This class is the linearization of the former three-layer inheritance chain
 * (app-server-adapter -> product-adapter -> release-adapter). Method bodies
 * are kept verbatim per layer; `_<method>Base` / `_<method>ProductLayer`
 * helpers preserve the exact call order the old `super.*` chain executed, so
 * behavior is unchanged while "which dispatch actually runs" no longer spans
 * three files. It owns no Agent loop, provider routing, tool dispatch,
 * persistence, sandbox enforcement, approval policy or user-question semantics.
 */
export class DshxPresentationAdapter {
  constructor({
    ctx,
    send,
    cwd = process.cwd(),
    home = path.join(os.homedir(), '.dshx'),
    version = '0.1.0-dev',
    diagnostics = () => {}
  }) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshAppServerAdapter requires a Cordis Context');
    if (typeof send !== 'function') throw new Error('DshAppServerAdapter requires send(message)');
    this.ctx = ctx;
    this.send = send;
    this.cwd = path.resolve(cwd);
    this.home = path.resolve(home);
    this.version = version;
    this.diagnostics = diagnostics;
    this.driver = new DshAgentDriver(ctx);
    this.permissions = new DshPermissionView(ctx);
    this.broker = new UiRequestBroker({ send });
    this.controllers = new Map();
    this.approvals = new Map();
    this.syntheticInteractions = new Map();
    this.readyPromise = null;
    this.userQuestions = null;
    this.closed = false;
  }

  // ── readiness ────────────────────────────────────────────────────────────

  async ensureReady() {
    await this.ensureReadyBase();
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

  async ensureReadyBase() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const loader = this.ctx.get('loader');
      if (loader?.await) await loader.await();
      if (!this.userQuestions && this.ctx.get('userQuestions')) {
        this.userQuestions = new DshUserQuestionBridge({
          ctx: this.ctx,
          broker: this.broker,
          locate: (request) => this.openSyntheticInteraction(request),
          complete: (location, outcome) => this.completeSyntheticInteraction(location, outcome),
          diagnostics: this.diagnostics
        });
      }
    })();
    return this.readyPromise;
  }

  // ── protocol entry ───────────────────────────────────────────────────────

  async handle(message) {
    if (this.broker.handleResponse(message)) return null;
    if (!message || message.id === undefined || typeof message.method !== 'string') {
      if (message?.id === undefined && typeof message?.method === 'string') return null;
      return { response: this.error(message?.id ?? null, INVALID_REQUEST, 'Invalid Request') };
    }
    try {
      await this.ensureReady();
      const dispatched = await this.dispatch(message.method, message.params ?? {});
      return {
        response: { id: message.id, result: dispatched?.result },
        afterResponse: dispatched?.afterResponse
      };
    } catch (error) {
      const code = error?.code === METHOD_NOT_FOUND ? METHOD_NOT_FOUND
        : error?.code === INVALID_PARAMS ? INVALID_PARAMS
          : INTERNAL_ERROR;
      return {
        response: this.error(message.id, code, error instanceof Error ? error.message : String(error))
      };
    }
  }

  /**
   * Merged dispatch table. Case order mirrors the former inheritance
   * linearization: release-layer routing first, then product-layer routing,
   * then the base protocol surface. The base layer's dead `skills/list` stub
   * (empty data) is gone — the product layer's DSH-backed skillsList owns it.
   */
  async dispatch(method, params) {
    switch (method) {
      // release-layer routing
      case 'command/exec':
        return this.commandExec(params);
      case 'config/batchWrite':
        return this.configBatchWrite(params);
      case 'thread/name/set':
        return this.threadNameSet(params);
      case 'thread/shellCommand':
        return this.threadShellCommand(params);
      case 'thread/fork':
        return this.threadForkPresentation(params);
      case 'thread/settings/update':
        return this.threadSettingsUpdatePresentation(params);
      case 'thread/compact/start':
        this.directController(params?.threadId, 'direct compaction');
        return this.threadCompactStart(params);
      case 'turn/start':
      case 'turn/steer':
        return this.richUserTurn(method, params);
      case 'turn/interrupt': {
        if (this.userShell().interrupt(params?.threadId, params?.turnId)) return { result: {} };
        const controller = this.controllers.get(String(params?.threadId ?? ''));
        if (controller && isDshSubagent(controller.agent)) return this.interruptSubagent(controller);
        return this.turnInterruptProduct(params);
      }
      case 'thread/unsubscribe': {
        const threadId = String(params?.threadId ?? '');
        this.userShell().abortThread(threadId, 'thread unsubscribed');
        this.planListeners().get(threadId)?.();
        this.planListeners().delete(threadId);
        this.planMutationSuppressed().delete(threadId);
        return this.threadUnsubscribeWithStatus(params);
      }
      // product-layer routing
      case 'account/usage/read':
        return this.accountUsageRead(params);
      case 'skills/list':
        return this.skillsList(params);
      case 'thread/turns/list':
        return this.threadTurnsList(params);
      case 'thread/items/list':
        return this.threadItemsList(params);
      // base-layer routing (most-derived implementations win at call time)
      case 'initialize':
        return {
          result: {
            userAgent: `dshx/${this.version}`,
            codexHome: this.home,
            platformFamily: platformFamily(),
            platformOs: platformOs()
          }
        };
      case 'account/read':
        return { result: { account: null, requiresOpenaiAuth: false } };
      case 'configRequirements/read':
        return { result: { requirements: null } };
      case 'model/list':
        return this.modelList(params);
      case 'thread/list':
        return this.threadList(params);
      case 'thread/loaded/list':
        return this.loadedThreadList();
      case 'thread/start':
        return this.threadStart(params);
      case 'thread/resume':
        return this.threadResume(params);
      case 'thread/read':
        return this.threadRead(params);
      default: {
        const error = new Error(`Method not found: ${method}`);
        error.code = METHOD_NOT_FOUND;
        throw error;
      }
    }
  }

  // ── models and listings ──────────────────────────────────────────────────

  async modelList(params) {
    const directory = await this.driver.modelDirectory();
    for (const failure of directory.failures ?? []) {
      this.diagnostics(`DSH model catalog ${failure.provider}: ${failure.message}`);
    }
    const active = this.driver.listRootAgents()[0];
    const current = active
      ? this.driver.currentModel(active)
      : this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const all = codexModelsFromDsh(directory, current);
    const visible = params.includeHidden ? all : all.filter((model) => !model.hidden);
    const page = pagination(params, visible.length);
    return { result: { data: visible.slice(page.start, page.end), nextCursor: page.nextCursor } };
  }

  async threadList(params = {}) {
    const response = await this.threadListBase(params);
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

  async threadListBase(params) {
    const headers = normalizeSessionHeaders(await this.driver.listSessions());
    const snapshots = await Promise.all(headers.map(async (header) => {
      try {
        const inspected = await this.driver.inspectSession(String(header.id));
        const meta = inspected?.meta ?? header;
        const events = inspected?.events ?? [];
        return dshThreadFromSnapshot({
          meta,
          events,
          loaded: Boolean(this.controllers.has(String(meta.id)) || this.driver.getLive(String(meta.id))),
          cliVersion: this.version
        });
      } catch (error) {
        this.diagnostics(`inspect ${String(header.id)}: ${error instanceof Error ? error.message : error}`);
        return undefined;
      }
    }));
    let threads = snapshots.filter(Boolean);
    if (params.cwd != null) {
      const wanted = new Set((Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map((entry) => path.resolve(entry)));
      threads = threads.filter((thread) => wanted.has(path.resolve(thread.cwd)));
    }
    if (params.searchTerm) {
      const needle = String(params.searchTerm).toLowerCase();
      threads = threads.filter((thread) => `${thread.name ?? ''}\n${thread.preview}`.toLowerCase().includes(needle));
    }
    if (Array.isArray(params.modelProviders) && params.modelProviders.length > 0) {
      const providers = new Set(params.modelProviders);
      threads = threads.filter((thread) => providers.has(thread.modelProvider));
    }
    threads.sort((a, b) => (params.sortDirection === 'asc' ? 1 : -1) * (a.recencyAt - b.recencyAt));
    const page = pagination(params, threads.length);
    return {
      result: {
        data: threads.slice(page.start, page.end).map((thread) => ({ ...thread, turns: [] })),
        nextCursor: page.nextCursor,
        backwardsCursor: null
      }
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

  // ── permissions ──────────────────────────────────────────────────────────

  async applyStartPermissions(agent, params = {}) {
    if (params.permissions == null) return this.applyStartPermissionsBase(agent, params);
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

  async applyStartPermissionsBase(agent, params) {
    const desiredSandbox = params.sandbox;
    const desiredApproval = codexApprovalToDsh(params.approvalPolicy);
    if (desiredSandbox == null && desiredApproval == null) return this.permissions.current(agent);

    const current = this.permissions.current(agent);
    const sandboxMode = desiredSandbox ?? current.dsh.sandboxMode;
    const approvalPolicy = desiredApproval ?? current.dsh.approvalPolicy;
    const presets = this.ctx.get('permissionPresets');
    const match = presets?.names?.find((name) => {
      const preset = presets.resolve(name);
      return preset.sandbox === sandboxMode && preset.approval === approvalPolicy;
    });
    if (!match) {
      throw new Error(`DSHX refuses to synthesize a DSH custom permission bundle (${sandboxMode}, ${approvalPolicy})`);
    }
    this.permissions.set(agent, match);
    return this.permissions.current(agent);
  }

  async applyModelOverride(agent, { model, modelProvider, effort } = {}) {
    if (model == null && effort == null) return this.driver.currentModel(agent);
    let selection;
    if (model != null) {
      selection = decodeDshModel(model);
      if (!selection && modelProvider) selection = { provider: modelProvider, model };
      if (!selection) throw new Error('DSHX accepts model switches only from its DSH-backed model catalog');
    } else {
      selection = this.driver.currentModel(agent);
    }
    const normalizedEffort = normalizeCodexEffort(effort);
    if (normalizedEffort !== undefined) selection = { ...selection, reasoningEffort: normalizedEffort };
    return this.driver.selectModel(agent, selection);
  }

  installController(handle) {
    const controller = this.installControllerBase(handle);
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

  installControllerBase(handle) {
    const threadId = String(handle.agent.id);
    const existing = this.controllers.get(threadId);
    if (existing) return existing;
    const controller = new DshThreadController({
      handle,
      driver: this.driver,
      emit: this.send,
      diagnostics: this.diagnostics
    });
    this.controllers.set(threadId, controller);
    const approval = new DshApprovalBridge({
      agent: handle.agent,
      broker: this.broker,
      classify: (req) => req.callId == null ? null : controller.toolCorrelation(req.callId),
      diagnostics: this.diagnostics
    });
    this.approvals.set(threadId, approval);
    return controller;
  }

  // ── thread responses ────────────────────────────────────────────────────

  threadResponse(agent, options = {}) {
    const response = this.threadResponseProductLayer(agent, options);
    const folded = this.driver.currentTitle(agent);
    const name = snapshotTitle(folded) ?? foldDshSessionTitle(agent.session?.events ?? []);
    return {
      ...response,
      thread: { ...response.thread, name }
    };
  }

  threadResponseProductLayer(agent, options = {}) {
    const response = this.threadResponseCore(agent, options);
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

  threadResponseCore(agent, { includeTurns = false } = {}) {
    const selection = this.driver.currentModel(agent);
    const permission = this.permissions.current(agent);
    const thread = fullThreadSnapshot(agent, { includeTurns, cliVersion: this.version });
    return {
      thread,
      model: encodeDshModel(selection),
      modelProvider: selection.provider,
      serviceTier: null,
      cwd: thread.cwd,
      instructionSources: [],
      approvalPolicy: permission.codex.approvalPolicy,
      approvalsReviewer: permission.codex.approvalsReviewer,
      sandbox: permission.codex.sandbox,
      reasoningEffort: selection.reasoningEffort ?? null
    };
  }

  // ── thread lifecycle ─────────────────────────────────────────────────────

  async threadStart(params) {
    const sessionId = crypto.randomUUID();
    const cwd = path.resolve(params.cwd ?? this.cwd);
    const handle = await this.driver.create({ cwd, sessionId });
    try {
      await this.applyModelOverride(handle.agent, params);
      await this.applyStartPermissions(handle.agent, params);
      this.installController(handle);
      const result = this.threadResponse(handle.agent);
      return {
        result,
        afterResponse: () => this.send({ method: 'thread/started', params: { thread: result.thread } })
      };
    } catch (error) {
      await handle.dispose?.();
      throw error;
    }
  }

  async threadResume(params = {}) {
    const response = await this.threadResumeProduct(params);
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

  async threadResumeProduct(params = {}) {
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

  async threadRead(params = {}) {
    const response = await this.threadReadBase(params);
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

  async threadReadBase(params) {
    if (!params.threadId) throw new Error('thread/read requires threadId');
    const live = this.driver.getLive(String(params.threadId));
    if (live) {
      return { result: { thread: fullThreadSnapshot(live, { includeTurns: Boolean(params.includeTurns), cliVersion: this.version }) } };
    }
    const inspected = await this.driver.inspectSession(String(params.threadId));
    if (!inspected) throw new Error(`Unknown DSH session: ${String(params.threadId)}`);
    return {
      result: {
        thread: dshThreadFromSnapshot({
          meta: inspected.meta,
          events: inspected.events,
          loaded: false,
          cliVersion: this.version,
          // A cold persisted session cannot faithfully use tool presenters
          // without a composed Agent. The TUI resumes before requesting rich
          // history; avoid fabricating tool semantics on a cold read.
          turns: []
        })
      }
    };
  }

  async turnStart(params) {
    const controller = this.controllers.get(String(params.threadId));
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${String(params.threadId)}`);
    if (params.cwd != null && path.resolve(params.cwd) !== path.resolve(controller.agent.session.header?.cwd ?? this.cwd)) {
      throw new Error('DSHX does not own per-turn cwd mutation; resume/start the DSH session in the desired cwd');
    }
    if (params.outputSchema != null) throw new Error('DSHX has no faithful public DSH mapping for Codex outputSchema yet');

    await this.applyModelOverride(controller.agent, { model: params.model, effort: params.effort });
    const permission = this.permissions.current(controller.agent);
    const desiredApproval = codexApprovalToDsh(params.approvalPolicy);
    if (desiredApproval != null && desiredApproval !== permission.dsh.approvalPolicy) {
      throw new Error('Turn-level approval changes must use a DSH permission preset');
    }
    if (!sandboxMatchesCurrent(params.sandboxPolicy, permission)) {
      throw new Error('Turn-level sandbox changes must use a DSH permission preset');
    }

    const started = await controller.startTurn(turnTextInput(params));
    return { result: { turn: started.turn }, afterResponse: started.release };
  }

  turnInterrupt(params) {
    const controller = this.controllers.get(String(params.threadId));
    if (!controller) return { result: {} };
    controller.interrupt({ keepInbox: true });
    return { result: {} };
  }

  async threadUnsubscribe(params) {
    const threadId = String(params.threadId ?? '');
    const controller = this.controllers.get(threadId);
    if (controller) {
      this.approvals.get(threadId)?.dispose();
      this.approvals.delete(threadId);
      this.controllers.delete(threadId);
      await controller.close();
    }
    return { result: {} };
  }

  async threadUnsubscribeWithStatus(params = {}) {
    const threadId = String(params.threadId ?? '');
    this.manualCompactions().get(threadId)?.abort(new Error('thread unsubscribed'));
    const subscribed = this.controllers.has(threadId);
    const loaded = Boolean(this.driver.getLive(threadId));
    await this.threadUnsubscribe(params);
    return {
      result: {
        status: subscribed ? 'unsubscribed' : loaded ? 'notSubscribed' : 'notLoaded'
      }
    };
  }

  // ── product-layer features ───────────────────────────────────────────────

  accountUsageRead(_params = {}) {
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

  async skillsList(params = {}) {
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
    return this.turnInterrupt(params);
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

    const childAgent = this.driver.getLive(childId);
    if (!childAgent) throw new Error(`DSH Host fork did not publish child Agent ${childId}`);
    this.driver.adoptExternalSelection(childAgent, {
      select: (selection) => this.hostApi().selectModel({ sessionId: childId, ...selection })
    });
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
    controller.steer(steerTextInput(params));
    return { result: { turnId: location.turnId } };
  }

  // ── release-layer presentation surfaces ──────────────────────────────────

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
      const effort = effortEdit.value == null ? undefined : normalizeCodexEffort(effortEdit.value);
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
    if (!controller) {
      // Formerly `super.dispatch(method, params)`: the inherited tail routed
      // turn/start to the base turnStart and turn/steer to the product
      // turnSteer validator. Route directly to those most-derived methods.
      return method === 'turn/steer' ? this.turnSteer(params) : this.turnStart(params);
    }
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
      const forwarded = { ...normalizedParams, input: [{ type: 'text', text: dshContentText(content) }] };
      return method === 'turn/steer' ? this.turnSteer(forwarded) : this.turnStart(forwarded);
    } finally {
      clear();
    }
  }

  async threadForkPresentation(params = {}) {
    const response = await this.threadFork(params);
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
    if (params.collaborationMode == null) return this.threadSettingsUpdate(params);
    if (!controller) throw new Error(`Thread is not resumed in DSHX: ${threadId}`);
    const active = codexPlanTarget(params.collaborationMode);
    const { collaborationMode: _ignored, ...ordinary } = params;

    // Let the existing DSH-backed settings adapter validate/apply every other
    // supported field. The collaboration payload's model/reasoning/instructions
    // are intentionally not treated as DSH model or prompt configuration.
    await this.threadSettingsUpdate(ordinary);

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

  // ── synthetic interactions (base) ────────────────────────────────────────

  openSyntheticInteraction(request) {
    const agentId = request?.agent?.id;
    if (!agentId) return undefined;
    const controller = this.controllers.get(String(agentId));
    const location = controller?.currentLocation();
    if (!location) return undefined;
    const itemId = `dshx-interaction-${crypto.randomUUID()}`;
    const startedAtMs = Date.now();
    const item = {
      type: 'dynamicToolCall',
      id: itemId,
      namespace: 'dshx',
      tool: 'userInteraction',
      arguments: { questionCount: request.questions?.length ?? 0 },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null
    };
    this.syntheticInteractions.set(itemId, { ...location, item, startedAtMs });
    this.send({
      method: 'item/started',
      params: { ...location, item, startedAtMs }
    });
    return { ...location, itemId };
  }

  completeSyntheticInteraction(location, outcome) {
    const state = this.syntheticInteractions.get(location.itemId);
    if (!state) return;
    this.syntheticInteractions.delete(location.itemId);
    const completedAtMs = Date.now();
    const item = {
      ...state.item,
      status: outcome.status === 'completed' ? 'completed' : 'failed',
      success: outcome.status === 'completed',
      durationMs: Math.max(0, completedAtMs - state.startedAtMs)
    };
    this.send({
      method: 'item/completed',
      params: { threadId: state.threadId, turnId: state.turnId, item, completedAtMs }
    });
  }

  error(id, code, message, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { id, error };
  }

  // ── teardown (linearized release → product → base) ──────────────────────

  async close() {
    this._userShell?.close();
    for (const dispose of this._agentPresentationDisposers ?? []) dispose?.();
    this._agentPresentationDisposers = [];
    for (const dispose of this.planListeners().values()) dispose?.();
    this.planListeners().clear();
    this.planMutationSuppressed().clear();
    for (const controller of this.manualCompactions().values()) {
      controller.abort(new Error('DSHX adapter closing'));
    }
    this.manualCompactions().clear();
    this.userQuestions?.dispose();
    this.userQuestions = null;
    this.broker.close();
    const ids = [...this.controllers.keys()];
    for (const id of ids) await this.threadUnsubscribe({ threadId: id });
  }
}

export const releaseAdapterInternals = { snapshotTitle, isDshSubagent };
