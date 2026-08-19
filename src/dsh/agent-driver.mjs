import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

function requireService(ctx, name) {
  const service = ctx.get(name);
  if (service === undefined) throw new Error(`DSHX requires DSH service: ${name}`);
  return service;
}

function userMessage(text) {
  return createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }]
  });
}

/** Thin delegation layer over official DeepSeek Harness public services. */
export class DshAgentDriver {
  constructor(ctx) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshAgentDriver requires a Cordis Context');
    this.ctx = ctx;
    this.selections = new WeakMap();
  }

  async settleComposition() {
    await this.ctx.get('loader')?.await?.();
  }

  selectionFor(agent) {
    const existing = this.selections.get(agent);
    if (existing) return existing;
    const defaultModel = requireService(this.ctx, 'agentDefaultModel');
    let picked;
    const selection = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader?.()?.config;
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort })
          };
        }
        return defaultModel.currentSelection();
      },
      set current(next) { picked = next; },
      assembled: undefined
    };
    installModelSelection(agent.ctx, selection);
    this.selections.set(agent, selection);
    return selection;
  }

  installSelection(agentCtx) {
    const agent = agentCtx.agent;
    if (!agent) throw new Error('DSHX agent setup has no scoped DSH Agent');
    this.selectionFor(agent);
  }

  async create({ cwd = process.cwd(), sessionId = `session-${randomUUID()}` } = {}) {
    await this.settleComposition();
    const agents = requireService(this.ctx, 'agents');
    const selection = requireService(this.ctx, 'agentDefaultModel').currentSelection();
    return agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => this.installSelection(agentCtx)
    });
  }

  async fork(sourceAgent, {
    sessionId = randomUUID(),
    seed = sourceAgent?.session?.events ?? []
  } = {}) {
    if (!sourceAgent?.session) throw new Error('DSHX fork requires a live DSH source agent');
    await this.settleComposition();
    const agents = requireService(this.ctx, 'agents');
    const sourceHeader = sourceAgent.session.header ?? {};
    const sourceSelection = this.currentModel(sourceAgent);
    const meta = {
      ...(sourceHeader.cwd == null ? {} : { cwd: sourceHeader.cwd }),
      parentSession: SessionId(String(sourceHeader.id ?? sourceAgent.id)),
      seedLength: seed.length,
      ...(sourceHeader.agentPreset == null ? {} : { agentPreset: sourceHeader.agentPreset })
    };
    const handle = await agents.create({
      sessionId: SessionId(sessionId),
      seed,
      meta,
      agentOptions: {
        provider: sourceSelection.provider,
        model: sourceSelection.model
      },
      setup: (agentCtx) => this.installSelection(agentCtx)
    });
    try {
      // The source may have a runtime-only picker selection newer than its last
      // request/header. Preserve that exact public DSH selection in the fork.
      await this.selectModel(handle.agent, sourceSelection);
      return handle;
    } catch (error) {
      await handle.dispose?.();
      throw error;
    }
  }

  async resume(sessionId) {
    await this.settleComposition();
    const agents = requireService(this.ctx, 'agents');
    return agents.resume({
      resumeSessionId: SessionId(sessionId),
      setup: (agentCtx) => this.installSelection(agentCtx)
    });
  }

  currentModel(agent) {
    return this.selectionFor(agent).current;
  }

  currentTitle(agent) {
    return this.ctx.get('sessionTitle')?.get?.(agent.session);
  }

  renameTitle(agent, title) {
    const service = requireService(this.ctx, 'sessionTitle');
    return service.rename(agent.session, title);
  }

  async readTitle(sessionId) {
    const query = this.ctx.get('sessionQuery');
    if (query?.readTitle) return query.readTitle(SessionId(sessionId));
    const live = this.getLive(sessionId);
    return live ? this.currentTitle(live) : undefined;
  }

  async selectModel(agent, requested) {
    const llm = requireService(this.ctx, 'llm');
    const resolved = await llm.resolveCallConfig({
      provider: requested.provider,
      model: requested.model,
      ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort })
    });
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort })
    };
    this.selectionFor(agent).current = selected;
    return selected;
  }

  async modelDirectory() {
    const llm = requireService(this.ctx, 'llm');
    const providers = llm.listProviders();
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id);
        const entries = await Promise.all(models.map(async (model) => {
          const exact = await llm.resolveModelInfo(provider.id, model.id);
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(exact.inputModalities === undefined ? {} : { inputModalities: [...exact.inputModalities] }),
            ...(exact.context === undefined ? {} : { contextWindow: exact.context.contextWindow }),
            ...(exact.reasoning === undefined ? {} : {
              reasoning: {
                efforts: exact.reasoning.efforts.map((effort) => ({
                  id: effort.id,
                  name: effort.name,
                  ...(effort.description === undefined ? {} : { description: effort.description })
                })),
                ...(exact.reasoning.defaultEffort === undefined ? {} : { defaultEffort: exact.reasoning.defaultEffort })
              }
            })
          };
        }));
        return { ok: true, group: { provider: provider.id, name: provider.name ?? provider.id, models: entries } };
      } catch (error) {
        return {
          ok: false,
          failure: { provider: provider.id, message: error instanceof Error ? error.message : String(error) }
        };
      }
    }));
    return {
      groups: settled.filter((entry) => entry.ok && entry.group.models.length > 0).map((entry) => entry.group),
      failures: settled.filter((entry) => !entry.ok).map((entry) => entry.failure)
    };
  }

  followup(agent, text) { agent.followup(userMessage(text)); }
  steer(agent, text) { agent.steer(userMessage(text)); }
  interrupt(agent, { keepInbox = false } = {}) { agent.cancel({ kind: 'user' }, { keepInbox }); }
  whenIdle(agent) { return agent.whenIdle(); }
  getLive(sessionId) { return requireService(this.ctx, 'agents').get(SessionId(sessionId)); }
  listLive() { return requireService(this.ctx, 'agents').list(); }
  listRootAgents() { return requireService(this.ctx, 'agents').roots(); }

  async listSessions(signal) {
    return requireService(this.ctx, 'sessionPersistence').list(signal);
  }

  async inspectSession(sessionId, signal) {
    return requireService(this.ctx, 'sessionPersistence').inspect(SessionId(sessionId), signal);
  }
}
