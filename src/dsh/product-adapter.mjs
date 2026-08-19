import path from 'node:path';
import { DshAppServerAdapter } from './app-server-adapter.mjs';
import { dshSkillsListEntry } from './skills.mjs';

function textInput(params) {
  const inputs = Array.isArray(params?.input) ? params.input : [];
  const unsupported = inputs.filter((item) => item?.type !== 'text');
  if (unsupported.length > 0) {
    throw new Error(`DSHX steer currently supports Codex text items only; got ${unsupported.map((item) => item?.type).join(', ')}`);
  }
  return inputs.map((item) => item.text ?? '').join('\n').trim();
}

/**
 * Product-level protocol tail on top of the stable DSH public API adapter.
 * Keep feature-specific compatibility decisions here instead of widening the
 * runtime-owning base: every method still delegates to official DSH services.
 */
export class DshxProductAdapter extends DshAppServerAdapter {
  async dispatch(method, params) {
    switch (method) {
      case 'skills/list':
        return this.skillsList(params);
      case 'turn/steer':
        return this.turnSteer(params);
      default:
        return super.dispatch(method, params);
    }
  }

  async skillsList(params = {}) {
    if (params.forceReload === true) {
      throw new Error(
        'DSHX cannot honor Codex forceReload: DSH skill cache invalidation is provider-owned; retry after the DSH provider emits skills/change'
      );
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
    controller.steer(textInput(params));
    return { result: { turnId: location.turnId } };
  }
}
