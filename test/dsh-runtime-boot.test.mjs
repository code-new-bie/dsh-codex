import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dshxRuntimeEntries, dshxRuntimeProfile, runtimeInternals } from '../src/dsh/runtime-boot.mjs';

function temporaryDshHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'dshx-profile-test-'));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('runtime auto-initializes and composes the official DSH headless profile', () => {
  temporaryDshHome((home) => {
    assert.equal(runtimeInternals.DEFAULT_PROFILE, 'headless');
    const composition = dshxRuntimeProfile({ home });
    assert.equal(composition.name, 'headless');

    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'headless', 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless'
    ]);

    const entries = dshxRuntimeEntries({ home });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    // These are public DSH services DSHX consumes. Their plugin identities remain
    // the official profile rows — DSHX never substitutes implementations.
    assert.equal(byId.get('llm')?.name, '@deepseek-ai/dsh-llm');
    assert.equal(byId.get('session')?.name, '@deepseek-ai/dsh-session');
    assert.equal(byId.get('agent')?.name, '@deepseek-ai/dsh-agent');
    assert.equal(byId.get('permission')?.name, '@deepseek-ai/dsh-permission-presets');
    assert.equal(byId.get('approval')?.name, '@deepseek-ai/dsh-user-approval');
    assert.equal(byId.get('user-questions')?.name, '@deepseek-ai/dsh-user-questions');
    assert.equal(byId.get('session-persistence-jsonl')?.name, '@deepseek-ai/dsh-session-persistence-jsonl');
    assert.equal(byId.get('tools')?.name, '@deepseek-ai/dsh-tools');
    assert.equal(byId.get('code-runtime')?.name, '@deepseek-ai/dsh-code-runtime-worker-thread');

    // Only the competing headless presentation surface is locked off.
    assert.equal(byId.get('headless-startup')?.disabled, true);
    assert.equal(byId.get('headless-runner')?.disabled, true);
  });
});

test('profile-local and DSH-home user patch layers remain authoritative for capabilities', () => {
  temporaryDshHome((home) => {
    // First read creates the official profile using DSH's own template.
    dshxRuntimeProfile({ home });
    writeFileSync(join(home, 'profiles', 'headless', 'cordis.patch.yml'), `
- id: tools
  config:
    dshxProfileProbe: profile
`);
    writeFileSync(join(home, 'cordis.patch.yml'), `
- id: llm
  config:
    dshxHomeProbe: home
`);

    const entries = dshxRuntimeEntries({ home });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get('tools')?.config?.dshxProfileProbe, 'profile');
    assert.equal(byId.get('llm')?.config?.dshxHomeProbe, 'home');
  });
});

test('DSHX surface patches cannot insert a second Agent, Session, tool or provider implementation', () => {
  for (const patch of runtimeInternals.DSHX_SURFACE_PATCHES) {
    assert.ok('id' in patch);
    assert.equal('insert' in patch, false);
    assert.equal(patch.disabled, true);
  }
});
