import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Shared bootstrap over the official DSH profile/plugin machinery.
 *
 * DSHX is a standard profile bundle. The UX launcher only ensures that the
 * selected profile carries this exact bundle version; the official `dsh`
 * process remains the application host and owns composition/lifecycle.
 */

export function dshHomeDir(environment = process.env) {
  return environment.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileManifestPath(profileName, environment = process.env) {
  return path.join(dshHomeDir(environment), 'profiles', profileName, 'package.json');
}

function isExecutable(candidate, platform = process.platform) {
  try {
    if (!fs.existsSync(candidate)) return false;
    if (platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dependencyCliFrom(directory) {
  try {
    const anchor = createRequire(path.join(directory, 'package.json')).resolve('@deepseek-ai/dsh/package.json');
    const cli = path.join(path.dirname(anchor), 'lib', 'bin.js');
    return fs.existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the user's real DSH launcher. PATH wins. On Windows npm exposes a
 * `dsh.cmd` shim; Rust/native children cannot execute batch files directly, so
 * resolve that shim back to the same installation's JS bin and invoke it with
 * the current Node executable. No shell command string is constructed.
 */
export function resolveDshInvocation(
  fromDirectory = process.cwd(),
  environment = process.env,
  platform = process.platform
) {
  if (environment.DSHX_DSH_BIN) {
    return { command: process.execPath, args: [environment.DSHX_DSH_BIN] };
  }

  const names = platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!isExecutable(candidate, platform)) continue;
      if (platform === 'win32' && name.toLowerCase().endsWith('.cmd')) {
        const cli = dependencyCliFrom(directory);
        if (!cli) {
          throw new Error(`found ${candidate} but could not resolve the matching @deepseek-ai/dsh/lib/bin.js`);
        }
        return { command: process.execPath, args: [cli] };
      }
      return { command: candidate, args: [] };
    }
  }

  const localCli = dependencyCliFrom(fromDirectory);
  if (localCli) return { command: process.execPath, args: [localCli] };
  return { command: 'dsh', args: [] };
}

/** Resolve the package version actually visible from one profile dependency tree. */
export function installedProfilePackageVersion(profileName, packageName, environment = process.env) {
  const manifestPath = profileManifestPath(profileName, environment);
  try {
    const packageJsonPath = createRequire(manifestPath).resolve(`${packageName}/package.json`);
    const installed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof installed.version === 'string' ? installed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Profile satisfaction is about installed state, not the dependency spec text:
 * pnpm may record local/global installs as `link:`/`file:` while resolving the
 * exact package version requested by the launcher.
 */
export function profileSatisfied(manifest, { name, version }, installedVersion = undefined) {
  if (!manifest || typeof manifest !== 'object') return false;
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const dependencies = manifest.dependencies ?? {};
  const resolvedVersion = installedVersion ?? (dependencies[name] === version ? version : undefined);
  return dependencies[name] !== undefined && bundles.includes(name) && resolvedVersion === version;
}

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
    const manifest = JSON.parse(fs.readFileSync(profileManifestPath(profile, environment), 'utf8'));
    const installedVersion = installedProfilePackageVersion(profile, name, environment);
    satisfied = profileSatisfied(manifest, { name, version }, installedVersion);
  } catch {
    // Missing/unreadable profile: the official plugin command initializes it.
  }
  if (satisfied) return { profile, action: 'already-installed' };
  if (environment.DSHX_SKIP_PROFILE_BOOTSTRAP === '1') return { profile, action: 'skipped' };

  const { command, args } = resolveDshInvocation(packageRoot, environment);
  const result = spawnSyncImpl(
    command,
    [...args, 'plugin', '--profile', profile, 'add', packageRoot],
    { stdio: 'inherit', shell: false }
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error("official 'dsh' CLI not found; install DeepSeek Harness to manage the DSHX profile");
  }
  if (result.status !== 0) {
    throw new Error(`failed to install ${name} into profile '${profile}' via dsh plugin add (exit ${result.status ?? '?'})`);
  }
  return { profile, action: 'installed' };
}
