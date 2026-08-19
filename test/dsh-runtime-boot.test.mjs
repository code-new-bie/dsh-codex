import assert from 'node:assert/strict';
import test from 'node:test';
import { dshxRuntimeEntries, runtimeInternals } from '../src/dsh/runtime-boot.mjs';

test('runtime composition comes from official base/headless bundles and disables only their one-shot surface', () => {
  assert.deepEqual(runtimeInternals.OFFICIAL_BUNDLES, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless'
  ]);

  const entries = dshxRuntimeEntries();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  // These are public DSH services DSHX consumes. Their plugin identities remain
  // the official bundle rows — DSHX never substitutes implementations.
  assert.equal(byId.get('llm')?.name, '@deepseek-ai/dsh-llm');
  assert.equal(byId.get('session')?.name, '@deepseek-ai/dsh-session');
  assert.equal(byId.get('agent')?.name, '@deepseek-ai/dsh-agent');
  assert.equal(byId.get('permission')?.name, '@deepseek-ai/dsh-permission-presets');
  assert.equal(byId.get('approval')?.name, '@deepseek-ai/dsh-user-approval');
  assert.equal(byId.get('user-questions')?.name, '@deepseek-ai/dsh-user-questions');
  assert.equal(byId.get('session-persistence-jsonl')?.name, '@deepseek-ai/dsh-session-persistence-jsonl');
  assert.equal(byId.get('tools')?.name, '@deepseek-ai/dsh-tools');

  // The official headless bundle contributes Code Mode plus its own CLI surface.
  // DSHX keeps the runtime capability and removes only the competing surface.
  assert.equal(byId.get('code-runtime')?.name, '@deepseek-ai/dsh-code-runtime-worker-thread');
  assert.equal(byId.get('headless-startup')?.disabled, true);
  assert.equal(byId.get('headless-runner')?.disabled, true);
});

test('DSHX surface patches do not insert a second Agent, Session, tool or provider implementation', () => {
  for (const patch of runtimeInternals.DSHX_SURFACE_PATCHES) {
    assert.ok('id' in patch);
    assert.equal('insert' in patch, false);
    assert.equal(patch.disabled, true);
  }
});
