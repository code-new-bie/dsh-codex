import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDshModel } from '../src/tui-protocol/shapes.mjs';
import { DshxPresentationAdapter } from '../src/tui-protocol/adapter.mjs';

test('thread/loaded/list returns thread ids rather than thread maps', () => {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.driver = {
    listLive() { return [{ id: 'root-1' }, { id: 'child-2' }]; }
  };
  assert.deepEqual(adapter.loadedThreadList(), {
    result: { data: ['root-1', 'child-2'] }
  });
});

test('config/batchWrite delegates model defaults to official DSH persistence', async () => {
  const saved = [];
  const resolved = [];
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.home = '/tmp/dshx-presentation';
  adapter.ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return {
          currentSelection() {
            return { provider: 'deepseek', model: 'old-model', reasoningEffort: 'high' };
          },
          async saveSelection(selection) { saved.push(selection); }
        };
      }
      if (name === 'llm') {
        return {
          async resolveCallConfig(selection) {
            resolved.push(selection);
            return {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort })
            };
          }
        };
      }
      return undefined;
    }
  };

  const model = encodeDshModel({ provider: 'opencode-free', model: 'x-preview-f-free' });
  const response = await adapter.configBatchWrite({
    edits: [
      { keyPath: 'model', value: model, mergeStrategy: 'replace' },
      { keyPath: 'model_reasoning_effort', value: null, mergeStrategy: 'replace' }
    ],
    reloadUserConfig: true
  });

  assert.deepEqual(resolved, [{ provider: 'opencode-free', model: 'x-preview-f-free' }]);
  assert.deepEqual(saved, [{ provider: 'opencode-free', model: 'x-preview-f-free' }]);
  assert.equal(response.result.status, 'ok');
  assert.match(response.result.version, /^dshx-/);
  assert.equal(response.result.overriddenMetadata, null);
});

test('rich user turn strips Codex null effort before the DSH-owned base path', async () => {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  const agent = { session: { header: { origin: 'user' } } };
  adapter.controllers = new Map([['thread-1', {
    agent,
    prepareUserContent() { return () => {}; }
  }]]);
  adapter.ctx = { get() { return undefined; } };

  // The flattened richUserTurn routes the DSH-owned base path directly to the
  // most-derived turnStart; stub that seam to observe what gets forwarded.
  let forwarded;
  adapter.turnStart = async (params) => {
    forwarded = params;
    return { result: {} };
  };
  await adapter.richUserTurn('turn/start', {
    threadId: 'thread-1',
    effort: null,
    input: [{ type: 'text', text: 'hello', text_elements: [] }]
  });

  assert.equal(forwarded.effort, undefined);
  assert.deepEqual(forwarded.input, [{ type: 'text', text: 'hello' }]);
});

test('config/batchWrite fails closed on Codex-owned settings', async () => {
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.home = '/tmp/dshx-presentation';
  adapter.ctx = { get() { return undefined; } };
  await assert.rejects(
    () => adapter.configBatchWrite({
      edits: [{ keyPath: 'features.web_search', value: true, mergeStrategy: 'replace' }]
    }),
    /refuses Codex-owned setting/
  );
});