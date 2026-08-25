import { mapCodexDecisionToDshApprovalOutcome } from './permissions.mjs';

function unavailable() {
  return 'unavailable';
}

/**
 * Presentation-only answerer for DSH `approval/request`.
 *
 * `classify(req)` must return a faithful presentation descriptor for a DSH
 * tool that already has a matching Codex UI surface, or null when DSHX cannot
 * represent the request. Null deliberately delegates to the next DSH answerer;
 * if nobody owns it, DSH itself returns `unavailable` and callers fail closed.
 */
export class DshApprovalBridge {
  constructor({ agent, broker, classify, diagnostics = () => {} }) {
    if (!agent?.ctx) throw new Error('DshApprovalBridge requires a live DSH Agent');
    if (!broker) throw new Error('DshApprovalBridge requires a UiRequestBroker');
    if (typeof classify !== 'function') throw new Error('DshApprovalBridge requires classify(req)');
    this.agent = agent;
    this.broker = broker;
    this.classify = classify;
    this.diagnostics = diagnostics;
    this.disposeListener = agent.ctx.on('approval/request', (req, next) => this.answer(req, next));
  }

  async answer(req, next) {
    const descriptor = this.classify(req);
    if (!descriptor) return next();

    const { kind, threadId, turnId, itemId } = descriptor;
    if (!threadId || !turnId || !itemId) {
      this.diagnostics('approval classifier returned an incomplete descriptor');
      return unavailable();
    }

    let method;
    let params;
    if (kind === 'command') {
      method = 'item/commandExecution/requestApproval';
      params = {
        threadId,
        turnId,
        itemId,
        startedAtMs: Date.now(),
        approvalId: null,
        environmentId: null,
        reason: req.reason ?? null,
        networkApprovalContext: null,
        command: descriptor.command ?? null,
        cwd: descriptor.cwd ?? null,
        commandActions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null
      };
    } else if (kind === 'fileChange') {
      method = 'item/fileChange/requestApproval';
      params = {
        threadId,
        turnId,
        itemId,
        startedAtMs: Date.now(),
        reason: req.reason ?? null,
        grantRoot: null
      };
    } else {
      this.diagnostics(`unsupported approval descriptor kind: ${String(kind)}`);
      return unavailable();
    }

    try {
      const result = await this.broker.request(method, params, { signal: req.signal });
      return mapCodexDecisionToDshApprovalOutcome(result?.decision);
    } catch (error) {
      // Any transport failure, abort, timeout, unsupported persistent grant or
      // malformed decision fails closed. DSH remains the policy owner and logs
      // the resulting `unavailable`/cancelled decision through its own service.
      if (req.signal?.aborted || error?.name === 'AbortError') return 'cancelled';
      this.diagnostics(error instanceof Error ? error.message : String(error));
      return unavailable();
    }
  }

  dispose() {
    this.disposeListener?.();
    this.disposeListener = undefined;
  }
}
