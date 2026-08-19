import { DshxProductAdapter } from './product-adapter.mjs';
import { foldDshSessionTitle, threadNameUpdatedNotification } from './thread-title.mjs';

function snapshotTitle(snapshot) {
  return typeof snapshot?.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null;
}

/**
 * Final product-facing protocol tail. Keep small metadata/UI compatibility
 * extensions here so the core DSH public adapter remains stable and auditable.
 */
export class DshxReleaseAdapter extends DshxProductAdapter {
  async dispatch(method, params) {
    if (method === 'thread/name/set') return this.threadNameSet(params);
    return super.dispatch(method, params);
  }

  threadResponse(agent, options = {}) {
    const response = super.threadResponse(agent, options);
    const folded = this.driver.currentTitle(agent);
    const name = snapshotTitle(folded) ?? foldDshSessionTitle(agent.session?.events ?? []);
    return {
      ...response,
      thread: { ...response.thread, name }
    };
  }

  async threadList(params = {}) {
    const response = await super.threadList(params);
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

  async threadRead(params = {}) {
    const response = await super.threadRead(params);
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
}

export const releaseAdapterInternals = { snapshotTitle };
