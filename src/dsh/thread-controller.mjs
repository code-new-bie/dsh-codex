import { DshSessionProjector } from './session-projector.mjs';
import { tokenUsageNotification } from './token-usage.mjs';
import { DshToolPresentationResolver } from './tool-presentation.mjs';

function deferred(timeoutMs, label) {
  let resolve;
  let reject;
  let timer;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
    timer = setTimeout(() => rej(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  return {
    promise,
    resolve(value) { clearTimeout(timer); resolve(value); },
    reject(error) { clearTimeout(timer); reject(error); }
  };
}

function usageRelevant(event) {
  return event?.type === 'assistant/message'
    || event?.type === 'request/context'
    || (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage');
}

/**
 * Owns only the presentation lifetime for one already-created DSH Agent.
 * The Agent and Session remain authoritative and are never reconstructed here.
 */
export class DshThreadController {
  constructor({ handle, driver, emit = () => {}, turnStartTimeoutMs = 15_000, diagnostics = () => {} }) {
    if (!handle?.agent) throw new Error('DshThreadController requires a DSH AgentHandle');
    this.handle = handle;
    this.agent = handle.agent;
    this.driver = driver;
    this.emit = emit;
    this.turnStartTimeoutMs = turnStartTimeoutMs;
    this.diagnostics = diagnostics;

    // Real DSH Agent contexts expose `ctx.tools`; lightweight controller tests
    // may omit it. Presentation specialization is optional and never affects
    // tool execution.
    this.toolPresentation = typeof this.agent.ctx?.get === 'function'
      ? new DshToolPresentationResolver({
          ctx: this.agent.ctx,
          agent: this.agent,
          threadId: String(this.agent.id),
          workspaceCwd: this.agent.session?.header?.cwd ?? process.cwd(),
          diagnostics
        })
      : null;

    this.projector = new DshSessionProjector({
      threadId: String(this.agent.id),
      sessionId: String(this.agent.id),
      toolPresentation: this.toolPresentation
    });
    this.pendingTurnStart = null;
    this.responseGate = null;
    this.lastTokenUsageSignature = null;
    this.closed = false;

    const onSessionEvent = (session, event) => this.onSessionEvent(session, event);
    this.disposeSessionListener = this.agent.ctx.on('session/event', onSessionEvent);
  }

  get threadId() {
    return String(this.agent.id);
  }

  toolCorrelation(callId) {
    return this.toolPresentation?.correlation(callId);
  }

  /** Current live DSH turn translated only to presentation identity. */
  currentLocation() {
    const number = this.projector.currentTurn;
    if (!Number.isInteger(number)) return undefined;
    const turn = this.projector.turns.get(number);
    if (!turn) return undefined;
    return { threadId: this.threadId, turnId: turn.id };
  }

  deliver(notification) {
    if (this.responseGate && !this.responseGate.released) {
      this.responseGate.buffered.push(notification);
      return;
    }
    this.emit(notification);
  }

  maybeProjectTokenUsage(event) {
    if (!usageRelevant(event)) return;
    const location = this.currentLocation();
    if (!location) return;
    try {
      const notification = tokenUsageNotification({
        ctx: this.agent.ctx,
        session: this.agent.session,
        threadId: location.threadId,
        turnId: location.turnId
      });
      if (!notification) return;
      const signature = JSON.stringify(notification.params.tokenUsage);
      if (signature === this.lastTokenUsageSignature) return;
      this.lastTokenUsageSignature = signature;
      this.deliver(notification);
    } catch (error) {
      // Token accounting is presentation-only. A malformed optional projection
      // must never interrupt the DSH agent loop or transcript stream.
      this.diagnostics(`token usage projection failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  onSessionEvent(session, event) {
    if (this.closed || session !== this.agent.session) return;
    const projected = this.projector.project(event);
    for (const notification of projected) {
      if (notification.method === 'turn/started' && this.pendingTurnStart) {
        const pending = this.pendingTurnStart;
        this.pendingTurnStart = null;
        const gate = {
          firstNotification: notification,
          buffered: [],
          released: false
        };
        this.responseGate = gate;
        pending.resolve({ turn: notification.params.turn, gate });
        continue;
      }
      this.deliver(notification);
    }
    this.maybeProjectTokenUsage(event);
  }

  /** Submit a normal follow-up and wait until DSH itself commits turn/start. */
  async startTurn(text) {
    if (this.pendingTurnStart || (this.responseGate && !this.responseGate.released)) {
      throw new Error('A turn/start request is already awaiting DSHX protocol release');
    }
    const pending = deferred(this.turnStartTimeoutMs, 'DSH turn/start');
    this.pendingTurnStart = pending;
    try {
      this.driver.followup(this.agent, text);
      const { turn, gate } = await pending.promise;
      return {
        turn,
        release: () => {
          if (gate.released) return;
          gate.released = true;
          if (this.responseGate === gate) this.responseGate = null;
          this.emit(gate.firstNotification);
          for (const notification of gate.buffered) this.emit(notification);
          gate.buffered.length = 0;
        }
      };
    } catch (error) {
      if (this.pendingTurnStart === pending) this.pendingTurnStart = null;
      throw error;
    }
  }

  steer(text) {
    this.driver.steer(this.agent, text);
  }

  interrupt(options) {
    this.driver.interrupt(this.agent, options);
  }

  whenIdle() {
    return this.driver.whenIdle(this.agent);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingTurnStart?.reject(new Error('DSHX thread controller closed'));
    this.pendingTurnStart = null;
    if (this.responseGate && !this.responseGate.released) {
      this.responseGate.released = true;
      this.responseGate.buffered.length = 0;
    }
    this.responseGate = null;
    this.disposeSessionListener?.();
    await this.handle.dispose?.();
  }
}
