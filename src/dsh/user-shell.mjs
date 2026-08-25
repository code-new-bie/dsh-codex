import { randomUUID } from 'node:crypto';

function seconds(ms = Date.now()) {
  return Math.floor(ms / 1000);
}

function turnRecord(id, status, startedAt, completedAt = null, error = null) {
  return {
    id,
    items: [],
    itemsView: 'full',
    status,
    error,
    startedAt,
    completedAt,
    durationMs: completedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1000)
  };
}

function errorRecord(message) {
  return { message: String(message), codexErrorInfo: null, additionalDetails: null };
}

function resultData(callId, result) {
  return {
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: Array.isArray(result?.content) ? result.content : [],
        isError: Boolean(result?.isError)
      }]
    },
    ...(result?.meta === undefined ? {} : { meta: result.meta })
  };
}

function pickTool(agent) {
  const tools = agent.ctx?.get?.('tools');
  if (!tools) throw new Error('DSHX user shell requires DSH service: tools');
  const preferred = process.platform === 'win32' ? ['pwsh', 'bash'] : ['bash', 'pwsh'];
  for (const name of preferred) {
    if (tools.get?.(name, agent)) return { tools, name };
  }
  throw new Error('No DSH shell tool is visible in the current Agent scope');
}

/**
 * Presentation-only bridge for Codex `!` commands. Execution still goes through
 * the official DSH ToolRuntime, so pre-execute policy, guards, approval,
 * sandboxing, timeouts, post-policy and result normalization all remain DSH-owned.
 * Like Codex's own user-shell action, these cells are intentionally not durable
 * conversation history.
 */
export class DshUserShellBridge {
  constructor({ send, diagnostics = () => {} } = {}) {
    if (typeof send !== 'function') throw new Error('DshUserShellBridge requires send(message)');
    this.send = send;
    this.diagnostics = diagnostics;
    this.active = new Map();
  }

  start(controller, command) {
    const threadId = String(controller?.threadId ?? controller?.agent?.id ?? '');
    if (!threadId) throw new Error('thread/shellCommand requires a resumed DSH thread');
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('thread/shellCommand requires a non-empty command');
    }
    if (this.active.has(threadId)) throw new Error('A DSHX user-shell command is already active for this thread');

    const existing = controller.currentLocation();
    const callId = `dshx-user-shell-${randomUUID()}`;
    const turnId = existing?.turnId ?? `dsh-user-shell-turn-${randomUUID()}`;
    const maintenance = existing == null;
    const startedAtMs = Date.now();
    const abortController = new AbortController();
    const state = {
      threadId,
      turnId,
      callId,
      maintenance,
      startedAtMs,
      abortController,
      controller,
      command
    };
    this.active.set(threadId, state);

    return {
      result: {},
      afterResponse: () => {
        void this.run(state);
      }
    };
  }

  async run(state) {
    const { threadId, turnId, callId, maintenance, startedAtMs, abortController, controller, command } = state;
    try {
      if (maintenance) {
        this.send({
          method: 'turn/started',
          params: { threadId, turn: turnRecord(turnId, 'inProgress', seconds(startedAtMs)) }
        });
      }

      const { tools, name } = pickTool(controller.agent);
      const args = {
        command,
        description: 'Run command from interactive user shell',
        workdir: controller.agent.session?.header?.cwd,
        run_in_background: false
      };
      const projected = controller.toolPresentation?.start({
        turnId,
        callId,
        name,
        rawArguments: args,
        startedAtMs
      });
      if (!projected || projected.state.semantic !== 'command') {
        throw new Error(`DSH shell tool ${name} does not expose terminal presentation semantics`);
      }
      projected.item.source = 'userShell';
      projected.state.item = projected.item;
      this.send({
        method: 'item/started',
        params: { threadId, turnId, startedAtMs, item: projected.item }
      });

      const result = await tools.execute({
        callId,
        name,
        arguments: args,
        signal: abortController.signal,
        agent: controller.agent
      });
      const completedAtMs = Date.now();
      const completed = controller.toolPresentation.complete({
        callId,
        resultData: resultData(callId, result),
        completedAtMs
      });
      if (!completed) throw new Error(`DSHX lost user-shell presentation correlation for ${callId}`);
      completed.item.source = 'userShell';
      this.send({
        method: 'item/completed',
        params: { threadId, turnId, completedAtMs, item: completed.item }
      });
      if (maintenance) {
        const completedAt = seconds(completedAtMs);
        this.send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: turnRecord(
              turnId,
              result?.isError ? 'failed' : 'completed',
              seconds(startedAtMs),
              completedAt,
              result?.isError ? errorRecord(result.error?.message ?? 'DSH shell command failed') : null
            )
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics(`user shell ${threadId}: ${message}`);
      if (maintenance) {
        const completedAt = seconds();
        this.send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: turnRecord(turnId, 'failed', seconds(startedAtMs), completedAt, errorRecord(message))
          }
        });
      } else {
        this.send({ method: 'warning', params: { threadId, message } });
      }
    } finally {
      if (this.active.get(threadId) === state) this.active.delete(threadId);
    }
  }

  interrupt(threadId, turnId) {
    const state = this.active.get(String(threadId));
    if (!state || state.turnId !== String(turnId)) return false;
    state.abortController.abort(new Error('user cancelled DSHX shell command'));
    return true;
  }

  abortThread(threadId, reason = 'thread closed') {
    const state = this.active.get(String(threadId));
    if (!state) return false;
    state.abortController.abort(new Error(reason));
    return true;
  }

  close() {
    for (const state of this.active.values()) {
      state.abortController.abort(new Error('DSHX adapter closing'));
    }
    this.active.clear();
  }
}

export const userShellInternals = { pickTool, resultData, turnRecord };
