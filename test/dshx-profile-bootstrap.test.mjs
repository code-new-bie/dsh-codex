import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  dshHomeDir,
  profileManifestPath,
  profileSatisfied,
  ensureProfileInstalled
} from '../src/dsh/profile-bootstrap.mjs';

function temporaryHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-bootstrap-test-'));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const SELF = { name: '@code-new-bie/dshx-tui', version: '9.9.9-test' };

function writeManifest(home, manifest) {
  const dir = path.join(home, 'profiles', 'tui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}

test('home and manifest paths honor DSH_HOME exactly like the official launcher', () => {
  assert.equal(dshHomeDir({}), path.join(os.homedir(), '.dsh'));
  assert.equal(dshHomeDir({ DSH_HOME: '/tmp/h' }), '/tmp/h');
  assert.equal(profileManifestPath('tui', { DSH_HOME: '/tmp/h' }), path.join('/tmp/h', 'profiles', 'tui', 'package.json'));
});

test('profile satisfaction needs the exact version AND bundle-layer membership', () => {
  const ok = { dependencies: { [SELF.name]: SELF.version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SELF.name] } } };
  const wrongVersion = { ...ok, dependencies: { [SELF.name]: '0.0.1' } };
  const missingLayer = { dependencies: { [SELF.name]: SELF.version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  assert.equal(profileSatisfied(ok, SELF), true);
  assert.equal(profileSatisfied(wrongVersion, SELF), false);
  assert.equal(profileSatisfied(missingLayer, SELF), false);
  assert.equal(profileSatisfied(undefined, SELF), false);
});

test('bootstrap installs through the official command when the profile is missing', () => {
  temporaryHome((home) => {
    const calls = [];
    const result = ensureProfileInstalled({
      packageRoot: '/repo',
      ...SELF,
      environment: { DSH_HOME: home },
      spawnSyncImpl: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      }
    });
    assert.equal(result.action, 'installed');
    const forwarded = calls[0][1];
    assert.equal(forwarded[0], 'plugin');
    assert.deepEqual(forwarded.slice(1, 4), ['--profile', 'tui', 'add']);
    assert.equal(forwarded.at(-1), '/repo');
  });
});

test('bootstrap is idempotent for satisfied profiles and honors the skip switch', () => {
  temporaryHome((home) => {
    writeManifest(home, {
      name: 'dsh-profile-tui',
      private: true,
      dependencies: { [SELF.name]: SELF.version },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SELF.name] } }
    });
    const spawn = () => ({ status: 1 });
    assert.equal(
      ensureProfileInstalled({ packageRoot: '/repo', ...SELF, environment: { DSH_HOME: home }, spawnSyncImpl: spawn }).action,
      'already-installed'
    );
    // The skip switch only short-circuits profiles that still need work.
    fs.writeFileSync(
      path.join(home, 'profiles', 'tui', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-tui',
        private: true,
        dependencies: { [SELF.name]: '0.0.1' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
      })
    );
    assert.equal(
      ensureProfileInstalled({
        packageRoot: '/repo', ...SELF,
        environment: { DSH_HOME: home, DSHX_SKIP_PROFILE_BOOTSTRAP: '1' },
        spawnSyncImpl: spawn
      }).action,
      'skipped'
    );
  });
});
