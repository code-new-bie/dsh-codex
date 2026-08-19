import { randomUUID } from 'node:crypto';
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy';

function requireService(ctx, name) {
  const service = ctx?.get?.(name);
  if (service == null) throw new Error(`DSHX requires DSH service: ${name}`);
  return service;
}

function rpcError(error, fallback) {
  if (error?.message) return new Error(error.message);
  return new Error(fallback);
}

/**
 * Very small façade over DSH's own transport-agnostic Host API.
 * Domain semantics stay in @deepseek-ai/dsh-host-apiproxy; DSHX only adapts
 * Codex presentation requests into that public API.
 */
export class DshHostApi {
  constructor(ctx, { cwd = process.cwd() } = {}) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshHostApi requires a Cordis Context');
    this.ctx = ctx;
    this.api = createApiProxy(ctx, {
      cwd,
      defaultModelSelection: () => requireService(ctx, 'agentDefaultModel').currentSelection(),
      saveDefaultModelSelection: (selection) => requireService(ctx, 'agentDefaultModel').saveSelection(selection)
    });
  }

  request(payload) {
    return {
      rpcId: RpcId(`dshx-${randomUUID()}`),
      payload
    };
  }

  async forkSession({ sessionId, atSeq } = {}) {
    const response = await this.api.sessions.fork(this.request({
      sessionId,
      ...(atSeq == null ? {} : { atSeq })
    }));
    if (!response?.result?.ok) {
      throw rpcError(response?.result?.error, `DSH session fork failed for ${String(sessionId)}`);
    }
    return response.result.value;
  }
}
