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

    assert.equal(
      readFileSync(composition.rootConfig, 'utf8'),
      runtimeInternals.PROFILE_ROOT_CONFIG,
      'DSHX may only rewrite the same empty Loader root role used by official dsh'
    );
    assert.match(runtimeInternals.PROFILE_ROOT_CONFIG, /Edit cordis\.patch\.yml, not this file/);

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

test('profile-local and DSH-home user patch layers remain authoritative and byte-for-byte untouched', () => {
  temporaryDshHome((home) => {
    // First read creates the official profile using DSH's own template.
    const initial = dshxRuntimeProfile({ home });
    const profilePatchPath = initial.profile.patchPath;
    const homePatchPath = initial.homePatchPath;
    const profilePatch = `# user profile layer - DSHX must never rewrite this byte stream\n- id: tools\n  config:\n    dshxProfileProbe: profile\n`;
    const homePatch = `# machine DSH layer - DSHX must never rewrite this byte stream\n- id: llm\n  config:\n    dshxHomeProbe: home\n`;
    writeFileSync(profilePatchPath, profilePatch);
    writeFileSync(homePatchPath, homePatch);

    const entries = dshxRuntimeEntries({ home });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get('tools')?.config?.dshxProfileProbe, 'profile');
    assert.equal(byId.get('llm')?.config?.dshxHomeProbe, 'home');

    assert.equal(readFileSync(profilePatchPath, 'utf8'), profilePatch);
    assert.equal(readFileSync(homePatchPath, 'utf8'), homePatch);
    assert.equal(readFileSync(initial.rootConfig, 'utf8'), runtimeInternals.PROFILE_ROOT_CONFIG);
  });
});

test('recomposition rewrites only the generated empty root, never either user patch layer', () => {
  temporaryDshHome((home) => {
    const initial = dshxRuntimeProfile({ home });
    const profilePatch = '- id: tools\n  config: { probe: keep-profile }\n';
    const homePatch = '- id: llm\n  config: { probe: keep-home }\n';
    writeFileSync(initial.profile.patchPath, profilePatch);
    writeFileSync(initial.homePatchPath, homePatch);
    writeFileSync(initial.rootConfig, 'this is generated state and must be reset\n');

    const recomposed = dshxRuntimeProfile({ home });
    assert.equal(readFileSync(recomposed.rootConfig, 'utf8'), runtimeInternals.PROFILE_ROOT_CONFIG);
    assert.equal(readFileSync(recomposed.profile.patchPath, 'utf8'), profilePatch);
    assert.equal(readFileSync(recomposed.homePatchPath, 'utf8'), homePatch);
  });
});

test('DSHX surface patches cannot insert a second Agent, Session, tool or provider implementation', () => {
  for (const patch of runtimeInternals.DSHX_SURFACE_PATCHES) {
    assert.ok('id' in patch);
    assert.equal('insert' in patch, false);
    assert.equal(patch.disabled, true);
  }
});
