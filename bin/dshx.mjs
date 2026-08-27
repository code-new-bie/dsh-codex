#!/usr/bin/env node
// DSHX is the UX alias for the standard DSH TUI profile. It may ensure the
// bundle is installed, but the official `dsh --profile tui` process remains
// the application host and owns the Loader tree, runtime services and exit.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSupportedNodeVersion } from '../src/cli/runtime.mjs';
import { ensureProfileInstalled, resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEFAULT_PROFILE = 'tui';

function selectedProfile() {
  const value = process.env.DSHX_PROFILE || DEFAULT_PROFILE;
  if (!value.trim()) throw new Error('DSH profile name must be non-empty');
  return value.trim();
}

export function bootstrapSurfaceProfile() {
  return ensureProfileInstalled({
    packageRoot: ROOT,
    name: PACKAGE.name,
    version: PACKAGE.version,
    profile: selectedProfile()
  });
}

export function run(argv = process.argv.slice(2)) {
  if (!isSupportedNodeVersion(process.versions.node)) {
    process.stderr.write(`dshx: unsupported Node ${process.version}; required ${PACKAGE.engines.node}\n`);
    return 1;
  }

  let profile;
  try {
    profile = bootstrapSurfaceProfile().profile;
  } catch (error) {
    process.stderr.write(`dshx: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const dsh = resolveDshInvocation(ROOT);
  const result = spawnSync(
    dsh.command,
    [...dsh.args, '--profile', profile, ...argv],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false
    }
  );
  if (result.error) {
    process.stderr.write(`dshx: failed to start official DSH profile: ${result.error.message}\n`);
    return result.error.code === 'ENOENT' ? 127 : 1;
  }
  if (result.signal) {
    if (process.env.DSHX_DEBUG === '1') process.stderr.write(`[dshx] dsh --profile ${profile} exited via ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
}

process.exitCode = run();
