import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  dshHomeDir,
  profileManifestPath,
  profileSatisfied,
  installedProfilePackageVersion,
  ensureProfileInstalled,
  resolveDshInvocation
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

function profileDir(home) {
  return path.join(home, 'profiles', 'tui');
}

function writeManifest(home, manifest) {
  const dir = profileDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}

function writeInstalledPackage(home, version = SELF.version) {
  const dir = path.join(profileDir(home), 'node_modules', '@code-new-bie', 'dshx-tui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: SELF.name,
    version,
    exports: { './package.json': './package.json' }
  }, null, 2));
}

test('home and manifest paths honor DSH_HOME exactly like the official launcher', () => {
  assert.equal(dshHomeDir({}), path.join(os.homedir(), '.dsh'));
  assert.equal(dshHomeDir({ DSH_HOME: '/tmp/h' }), '/tmp/h');
  assert.equal(profileManifestPath('tui', { DSH_HOME: '/tmp/h' }), path.join('/tmp/h', 'profiles', 'tui', 'package.json'));
});

test('profile satisfaction uses actual resolved version rather than pnpm link/file spec text', () => {
  const linked = {
    dependencies: { [SELF.name]: 'link:/opt/dshx' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SELF.name] } }
  };
  assert.equal(profileSatisfied(linked, SELF, SELF.version), true);
  assert.equal(profileSatisfied(linked, SELF, '0.0.1'), false);
  assert.equal(profileSatisfied({ ...linked, dependencies: {} }, SELF, SELF.version), false);
  assert.equal(profileSatisfied({ ...linked, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, SELF, SELF.version), false);
  assert.equal(profileSatisfied(undefined, SELF, SELF.version), false);
});

test('installed package version resolves from the profile dependency tree', () => {
  temporaryHome((home) => {
    writeManifest(home, {
      name: 'dsh-profile-tui',
      private: true,
      dependencies: { [SELF.name]: 'link:/opt/dshx' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SELF.name] } }
    });
    assert.equal(installedProfilePackageVersion('tui', SELF.name, { DSH_HOME: home }), undefined);
    writeInstalledPackage(home);
    assert.equal(installedProfilePackageVersion('tui', SELF.name, { DSH_HOME: home }), SELF.version);
  });
});

test('bootstrap installs through the official plugin command when the profile is missing', () => {
  temporaryHome((home) => {
    const calls = [];
    const result = ensureProfileInstalled({
      packageRoot: '/repo',
      ...SELF,
      environment: { DSH_HOME: home },
      spawnSyncImpl: (command, args, options) => {
        calls.push([command, args, options]);
        return { status: 0 };
      }
    });
    assert.equal(result.action, 'installed');
    assert.equal(calls[0][1][0], 'plugin');
    assert.deepEqual(calls[0][1].slice(1, 4), ['--profile', 'tui', 'add']);
    assert.equal(calls[0][1].at(-1), '/repo');
    assert.equal(calls[0][2].shell, false);
  });
});

test('bootstrap is idempotent for linked profiles with the exact installed package', () => {
  temporaryHome((home) => {
    writeManifest(home, {
      name: 'dsh-profile-tui',
      private: true,
      dependencies: { [SELF.name]: 'link:/opt/dshx' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SELF.name] } }
    });
    writeInstalledPackage(home);
    const spawn = () => ({ status: 1 });
    assert.equal(
      ensureProfileInstalled({ packageRoot: '/repo', ...SELF, environment: { DSH_HOME: home }, spawnSyncImpl: spawn }).action,
      'already-installed'
    );
  });
});

test('Windows npm dsh.cmd shim resolves back to the same installation JS bin without a shell', () => {
  temporaryHome((home) => {
    const prefix = path.join(home, 'npm');
    const packageDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
    const cli = path.join(packageDir, 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'dsh.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', exports: { './package.json': './package.json' } }));
    fs.writeFileSync(cli, '');
    const resolved = resolveDshInvocation(home, { PATH: prefix }, 'win32');
    assert.equal(resolved.command, process.execPath);
    assert.equal(resolved.args.length, 1);
    assert.equal(fs.realpathSync(resolved.args[0]), fs.realpathSync(cli));
  });
});
