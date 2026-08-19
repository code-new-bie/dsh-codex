import { DshSessionProjector } from './session-projector.mjs';

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

/**
 * Owns only the presentation lifetime for one already-created DSH Agent.
 * The Agent and Session remain authoritative and are never reconstructed here.
 */
export class DshThreadController {
  constructor({ handle, driver, emit = () => {}, turnStartTimeoutMs = 15_000 }) {
    if (!handle?.agent) throw new Error('DshThreadController requires a DSH AgentHandle');
    this.handle = handle;
    this.agent = handle.agent;
    this.driver = driver;
    this.emit = emit;
    this.turnStartTimeoutMs = turnStartTimeoutMs;
    this.projector = new DshSessionProjector({
      threadId: String(this.agent.id),
      sessionId: String(this.agent.id)
    });
    this.pendingTurnStart = null;
    this.closed = false;

    const onSessionEvent = (_session, event) => this.onSessionEvent(event);
    this.disposeSessionListener = this.agent.ctx.on('session/event', onSessionEvent);
  }

  get threadId() {
    return String(this.agent.id);
  }

  onSessionEvent(event) {
    if (this.closed) return;
    const projected = this.projector.project(event);
    for (const notification of projected) {
      if (notification.method === 'turn/started' && this.pendingTurnStart) {
        // The caller needs the DSH-committed turn identity for the JSON-RPC
        // response. Buffer this first notification so the response can be sent
        // before the matching notification, mirroring Codex app-server order.
        const pending = this.pendingTurnStart;
        this.pendingTurnStart = null;
        pending.resolve({ turn: notification.params.turn, firstNotification: notification });
        continue;
      }
      this.emit(notification);
    }
  }

  /**
   * Submit a normal follow-up and wait until DSH itself commits turn/start.
   * Returns a release callback so the transport can send the RPC response first.
   */
  async startTurn(text) {
    if (this.pendingTurnStart) throw new Error('A turn/start request is already awaiting DSH');
    const pending = deferred(this.turnStartTimeoutMs, 'DSH turn/start');
    this.pendingTurnStart = pending;
    try {
      this.driver.followup(this.agent, text);
      const { turn, firstNotification } = await pending.promise;
      let released = false;
      return {
        turn,
        release: () => {
          if (released) return;
          released = true;
          this.emit(firstNotification);
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
    this.disposeSessionListener?.();
    await this.handle.dispose?.();
  }
}
