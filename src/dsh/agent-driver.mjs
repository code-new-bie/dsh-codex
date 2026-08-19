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

/**
 * Thin delegation layer over official DeepSeek Harness public services.
 *
 * This class is intentionally boring: no agent loop, no tool execution, no
 * transcript persistence and no policy decisions live here. It converts TUI
 * intent into calls on DSH-owned objects and returns those objects/results.
 */
export class DshAgentDriver {
  constructor(ctx) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshAgentDriver requires a Cordis Context');
    this.ctx = ctx;
  }

  async settleComposition() {
    await this.ctx.get('loader')?.await?.();
  }

  async create({ cwd = process.cwd(), sessionId = `session-${randomUUID()}` } = {}) {
    await this.settleComposition();
    const agents = requireService(this.ctx, 'agents');
    const defaultModel = requireService(this.ctx, 'agentDefaultModel');
    const selection = defaultModel.currentSelection();

    return agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: {
        provider: selection.provider,
        model: selection.model
      },
      setup: (agentCtx) => {
        const selected = { current: selection, assembled: undefined };
        installModelSelection(agentCtx, selected);
      }
    });
  }

  /**
   * Resume delegates persisted-runtime reconstruction to DSH. In particular,
   * DSHX does not apply the machine's current default model to an old Session.
   */
  async resume(sessionId) {
    await this.settleComposition();
    const agents = requireService(this.ctx, 'agents');
    return agents.resume({ resumeSessionId: SessionId(sessionId) });
  }

  followup(agent, text) {
    agent.followup(userMessage(text));
  }

  steer(agent, text) {
    agent.steer(userMessage(text));
  }

  interrupt(agent, { keepInbox = false } = {}) {
    agent.cancel({ kind: 'user' }, { keepInbox });
  }

  whenIdle(agent) {
    return agent.whenIdle();
  }

  getLive(sessionId) {
    return requireService(this.ctx, 'agents').get(SessionId(sessionId));
  }

  listLive() {
    return requireService(this.ctx, 'agents').list();
  }

  listRootAgents() {
    return requireService(this.ctx, 'agents').roots();
  }

  async listSessions(options = {}) {
    const persistence = requireService(this.ctx, 'sessionPersistence');
    return persistence.list(options);
  }

  async inspectSession(sessionId) {
    const persistence = requireService(this.ctx, 'sessionPersistence');
    return persistence.inspect(SessionId(sessionId));
  }
}
