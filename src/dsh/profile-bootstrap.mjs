import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Shared bootstrap over the official DSH plugin machinery.
 *
 * The surface ships as a standard profile bundle; every entry point (the
 * zero-argument CLI, the smoke scripts, CI) ensures the selected profile
 * carries this exact package version by running the official
 * `dsh plugin --profile <p> add <packageRoot>` command, which owns profile
 * initialization, pnpm installation and bundles reconciliation.
 */

/** Resolve the DSH home directory exactly like the official launcher. */
export function dshHomeDir(environment = process.env) {
  return environment.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileManifestPath(profileName, environment = process.env) {
  return path.join(dshHomeDir(environment), 'profiles', profileName, 'package.json');
}

/**
 * How to invoke the official dsh CLI. Host fidelity first: a `dsh` on the
 * user's PATH IS their installed DeepSeek Harness (same build that powers
 * their other surfaces and wrote their state files), so it always wins.
 * Only when none exists do we fall back to the dependency-local CLI from
 * npm ci — fresh machines and CI.
 */
function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

export function resolveDshInvocation(fromDirectory = process.cwd(), environment = process.env) {
  if (environment.DSHX_DSH_BIN) {
    return { command: process.execPath, args: [environment.DSHX_DSH_BIN] };
  }
  const extensions = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of extensions) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return { command: candidate, args: [] };
    }
  }
  try {
    const anchor = createRequire(path.join(fromDirectory, 'package.json')).resolve(
      '@deepseek-ai/dsh/package.json'
    );
    const cli = path.join(path.dirname(anchor), 'lib', 'bin.js');
    if (fs.existsSync(cli)) return { command: process.execPath, args: [cli] };
  } catch {
    // Not installed locally; fall through to bare PATH lookup.
  }
  return { command: 'dsh', args: [] };
}

/** A profile satisfies bootstrap when it pins this exact version as a bundle layer. */
export function profileSatisfied(manifest, { name, version }) {
  if (!manifest || typeof manifest !== 'object') return false;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const dependencies = manifest.dependencies ?? {};
  return dependencies[name] === version && bundles.includes(name);
}

/**
 * Ensure `profileName` exists and carries `{name}@{version}` from
 * `packageRoot` as an activated bundle layer. Idempotent: satisfied profiles
 * are left untouched, honoring DSHX_SKIP_PROFILE_BOOTSTRAP=1 for offline runs.
 */
export function ensureProfileInstalled({
  packageRoot,
  name,
  version,
  profile = 'tui',
  environment = process.env,
  spawnSyncImpl = spawnSync
} = {}) {
  let satisfied = false;
  try {
    satisfied = profileSatisfied(JSON.parse(fs.readFileSync(profileManifestPath(profile, environment), 'utf8')), {
      name,
      version
    });
  } catch {
    // Missing or unreadable manifest: the official command initializes it.
  }
  if (satisfied) return { profile, action: 'already-installed' };
  if (environment.DSHX_SKIP_PROFILE_BOOTSTRAP === '1') {
    return { profile, action: 'skipped' };
  }

  const { command, args } = resolveDshInvocation(packageRoot, environment);
  const result = spawnSyncImpl(
    command,
    [...args, 'plugin', '--profile', profile, 'add', packageRoot],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      "official 'dsh' CLI not found (looked up DSHX_DSH_BIN, @deepseek-ai/dsh dependency and PATH); install DeepSeek Harness to manage the DSHX surface profile"
    );
  }
  if (result.status !== 0) {
    throw new Error(`failed to install ${name} into profile '${profile}' via dsh plugin add (exit ${result.status ?? '?'})`);
  }
  return { profile, action: 'installed' };
}
