import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DshAgentDriver } from './agent-driver.mjs';
import { DshApprovalBridge } from './approval-bridge.mjs';
import {
  codexModelsFromDsh,
  decodeDshModel,
  dshThreadFromSnapshot,
  dshTurnsFromSession,
  encodeDshModel,
  normalizeCodexEffort,
  normalizeSessionHeaders
} from './codex-shapes.mjs';
import { DshPermissionView } from './permissions.mjs';
import { DshThreadController } from './thread-controller.mjs';
import { DshUserQuestionBridge } from './user-question-bridge.mjs';
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

function textInput(params) {
  const inputs = Array.isArray(params?.input) ? params.input : [];
  const unsupported = inputs.filter((item) => item?.type !== 'text');
  if (unsupported.length > 0) {
    throw new Error(`DSHX turn input currently supports Codex text items only; got ${unsupported.map((item) => item?.type).join(', ')}`);
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

/**
 * Presentation adapter from pinned Codex app-server JSON-RPC to official DSH
 * public services. It owns no Agent loop, provider routing, tool dispatch,
 * persistence, sandbox enforcement, approval policy or user-question semantics.
 */
export class DshAppServerAdapter {
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

  async ensureReady() {
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

  async dispatch(method, params) {
    switch (method) {
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
      case 'skills/list':
        // DSH skills remain upstream-owned. Until their public catalog is
        // mapped, claiming none is safer than synthesizing Codex skill paths.
        return { result: { data: [] } };
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
      case 'thread/unsubscribe':
        return this.threadUnsubscribe(params);
      case 'turn/start':
        return this.turnStart(params);
      case 'turn/interrupt':
        return this.turnInterrupt(params);
      default: {
        const error = new Error(`Method not found: ${method}`);
        error.code = METHOD_NOT_FOUND;
        throw error;
      }
    }
  }

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

  async threadList(params) {
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
    const data = [...this.controllers.values()].map((controller) => fullThreadSnapshot(controller.agent, {
      includeTurns: false,
      cliVersion: this.version
    }));
    return { result: { data } };
  }

  async applyStartPermissions(agent, params) {
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

  threadResponse(agent, { includeTurns = false } = {}) {
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

  async threadResume(params) {
    if (!params.threadId) throw new Error('thread/resume requires threadId');
    let controller = this.controllers.get(String(params.threadId));
    if (!controller) {
      const live = this.driver.getLive(String(params.threadId));
      const handle = live
        ? { agent: live, dispose: async () => {} }
        : await this.driver.resume(String(params.threadId));
      controller = this.installController(handle);
    }
    const agent = controller.agent;
    if (params.cwd != null && path.resolve(params.cwd) !== path.resolve(agent.session.header?.cwd ?? this.cwd)) {
      throw new Error('DSHX does not override a persisted DSH session cwd during resume');
    }
    await this.applyModelOverride(agent, params);
    await this.applyStartPermissions(agent, params);
    return { result: this.threadResponse(agent, { includeTurns: true }) };
  }

  async threadRead(params) {
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

    const started = await controller.startTurn(textInput(params));
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.userQuestions?.dispose();
    this.userQuestions = null;
    this.broker.close();
    const ids = [...this.controllers.keys()];
    for (const id of ids) await this.threadUnsubscribe({ threadId: id });
  }
}
