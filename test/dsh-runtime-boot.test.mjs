import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * Replicate the official `initProfile` skeleton (the documented format written
 * by `dsh plugin --profile <name>` on first use) so composition tests can
 * target the non-template `tui` profile without running pnpm.
 */
function seedSurfaceProfile(home) {
  const dir = join(home, 'profiles', 'tui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-tui',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    }, null, 2)}\n`
  );
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  return dir;
}

test('runtime targets the tui surface profile over the official dsh-base layer', () => {
  temporaryDshHome((home) => {
    assert.equal(runtimeInternals.DEFAULT_PROFILE, 'tui');
    seedSurfaceProfile(home);
    const composition = dshxRuntimeProfile({ home });
    assert.equal(composition.name, 'tui');

    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'tui', 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);

    assert.equal(
      readFileSync(composition.rootConfig, 'utf8'),
      runtimeInternals.PROFILE_ROOT_CONFIG,
      'DSHX may only rewrite the same empty Loader root role used by official dsh'
    );

    const entries = dshxRuntimeEntries({ home });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    // The surface rows come exclusively from the installed bundle; an empty
    // dsh-base-only profile must not fabricate them here.
    assert.equal(byId.get('dshx-presentation'), undefined);
    assert.equal(byId.get('dshx-startup'), undefined);
  });
});

test('bundle patch declares the surface rows and locks the competing runner', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(source, /id: headless-startup/);
  assert.match(source, /id: headless-runner/);
  assert.match(source, /name: '@code-new-bie\/dshx-tui\/startup'/);
  assert.match(source, /name: '@code-new-bie\/dshx-tui\/presentation'/);
  assert.match(source, /inject: \[dshxStartup\]/);
  // Locks carry no config: a targeted patch replaces a row's whole config,
  // so any config key here would silently wipe the official row settings.
  assert.doesNotMatch(source, /- id: headless-(startup|runner)\n\s+config:/);

  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./presentation'], './src/dsh/presentation-plugin.mjs');
  assert.equal(manifest.exports['./startup'], './src/dsh/startup-plugin.mjs');
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh']);
  // Single-instance rule: dsh runtime packages must never become real
  // dependencies, or the profile copy shadows the healed installation
  // symlinks and splits every service registry in two.
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], undefined);
});

test('profile-local and DSH-home user patch layers remain authoritative and byte-for-byte untouched', () => {
  temporaryDshHome((home) => {
    seedSurfaceProfile(home);
    const initial = dshxRuntimeProfile({ home });
    const profilePatchPath = initial.profile.patchPath;
    const homePatchPath = initial.homePatchPath;
    const profilePatch = `# user profile layer - DSHX must never rewrite this byte stream\n- id: tools\n  config:\n    dshxProfileProbe: profile\n`;
    const homePatch = `# machine DSH layer - DSHX must never rewrite this byte stream\n- id: llm\n  config:\n    dshxHomeProbe: home\n`;
    writeFileSync(profilePatchPath, profilePatch);
    writeFileSync(homePatchPath, homePatch);

    const entries = dshxRuntimeEntries({ home });
    // The user layers apply verbatim even when they reference rows the
    // current bundle stack does not provide: unmatched targeted patches are
    // warn-and-skip by design (applyEntryPatches semantics).
    assert.ok(Array.isArray(entries));

    assert.equal(readFileSync(profilePatchPath, 'utf8'), profilePatch);
    assert.equal(readFileSync(homePatchPath, 'utf8'), homePatch);
    assert.equal(readFileSync(initial.rootConfig, 'utf8'), runtimeInternals.PROFILE_ROOT_CONFIG);
  });
});

test('recomposition rewrites only the generated empty root, never either user patch layer', () => {
  temporaryDshHome((home) => {
    seedSurfaceProfile(home);
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

test('missing surface profile fails loud instead of silently composing nothing', () => {
  temporaryDshHome((home) => {
    assert.throws(
      () => dshxRuntimeProfile({ home }),
      /plugin|Cannot find|ENOENT|profile/i,
      'the official loadProfile contract refuses unknown profiles'
    );
  });
});

test('untested DSH lines warn once and proceed; the tested line stays silent', () => {
  temporaryDshHome((home) => {
    seedSurfaceProfile(home);
    const fake = join(home, 'fake-dsh', 'package.json');
    mkdirSync(dirname(fake), { recursive: true });
    writeFileSync(fake, JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-unheard-of' }));

    // Ecosystem convention: bundles never block the host. A mismatch warns
    // exactly once with both versions, then lets every boot proceed.
    const warnings = [];
    const first = runtimeInternals.reportDshLineCompatibility(fake, (m) => warnings.push(m));
    assert.equal(first.compatible, false);
    assert.equal(first.installed, '9.9.9-unheard-of');
    runtimeInternals.reportDshLineCompatibility(fake, (m) => warnings.push(m));
    assert.equal(warnings.length, 1, 'warn-once per process');
    assert.match(warnings[0], new RegExp(`${runtimeInternals.SUPPORTED_DSH_LINE}.*9\\.9\\.9-unheard-of|9\\.9\\.9-unheard-of.*${runtimeInternals.SUPPORTED_DSH_LINE}`));
    assert.match(warnings[0], /proceeding/);

    // The tested line itself is silent and reports plain compatibility.
    const quiet = [];
    const real = runtimeInternals.reportDshLineCompatibility(
      new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url),
      (m) => quiet.push(m)
    );
    assert.equal(real.compatible, true);
    assert.deepEqual(quiet, []);
  });
});

test('presentation lifetime delegates disposal to the official DSH root Fiber', async () => {
  let disposals = 0;
  const ctx = {
    fiber: {
      async dispose() {
        disposals += 1;
      }
    }
  };

  const decorated = runtimeInternals.attachPresentationLifetime(ctx);
  assert.equal(decorated, ctx);
  assert.equal(typeof ctx.dispose, 'function');
  assert.equal(Object.prototype.propertyIsEnumerable.call(ctx, 'dispose'), false);

  await ctx.dispose();
  assert.equal(disposals, 1);
});
