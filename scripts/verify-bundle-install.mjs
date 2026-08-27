#!/usr/bin/env node
/**
 * End-to-end DSH bundle compliance proof using only official host machinery:
 * npm pack -> dsh plugin add -> dsh --dump-config -> stdio initialize/EOF.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = PACKAGE.name;
const PROFILE = 'tui';
const HOST_SETTLE_GRACE_MS = Number(process.env.DSHX_BUNDLE_HOST_SETTLE_GRACE_MS ?? 250);

function fail(message) {
  console.error(`\n[verify-bundle] FAIL: ${message}`);
  process.exitCode = 1;
}

function run(command, args, { cwd = ROOT, env = process.env, check = true } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (check && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function probeStdioSurface({ dsh, cwd, env, profile = PROFILE, timeoutMs = 90_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(dsh.command, [...dsh.args, '--profile', profile, '--dshx-app-server'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    let stderr = '';
    let initialized;
    let settled = false;
    let settleTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      lines.close();
      if (error) {
        try { child.kill('SIGTERM'); } catch {}
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`stdio surface timed out after ${timeoutMs}ms${stderr ? `:\n${stderr}` : ''}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16384); });
    child.on('error', (error) => finish(error));
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id !== 'verify-bundle') return;
      if (message.error) {
        finish(new Error(`stdio initialize rejected: ${message.error.message || JSON.stringify(message.error)}`));
        return;
      }
      initialized = message.result;
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      // initialize proves the bundle rows are mounted. rc.8's official
      // runProfile() then completes launcher-owned patch-watcher setup, which
      // intentionally has no plugin-facing settle service. Exercise steady-
      // state EOF only after that bounded host-only startup window.
      settleTimer = setTimeout(() => {
        if (!settled && !child.stdin.destroyed) child.stdin.end();
      }, HOST_SETTLE_GRACE_MS);
    });
    child.on('exit', (code, signal) => {
      if (!initialized) {
        finish(new Error(`stdio surface exited before initialize (${signal ?? code ?? 'unknown'})${stderr ? `:\n${stderr}` : ''}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`stdio surface did not honor bounded EOF exit (code ${code ?? '?'} signal ${signal ?? '-'})${stderr ? `:\n${stderr}` : ''}`));
        return;
      }
      finish(null, initialized);
    });
    child.stdin.write(`${JSON.stringify({
      id: 'verify-bundle',
      method: 'initialize',
      params: { clientInfo: { name: 'dshx-bundle-verifier', version: PACKAGE.version } }
    })}\n`);
  });
}

function assertComposition(dumpText) {
  return import('@deepseek-ai/dsh-app-boot').then(({ loadOptionalPatches }) => {
    const temp = path.join(os.tmpdir(), `dshx-dump-${process.pid}-${Date.now()}.yml`);
    fs.writeFileSync(temp, dumpText);
    try {
      const tree = loadOptionalPatches('dsh', temp);
      const rows = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (typeof node.id === 'string') rows.push(node);
        for (const value of Object.values(node)) walk(value);
      };
      walk(tree);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of ['dshx-startup', 'dshx-presentation']) {
        if (!byId.has(id)) throw new Error(`composed tree is missing '${id}'`);
      }
      if (byId.get('headless-runner')?.disabled !== true) {
        throw new Error('competing headless-runner must be disabled by the DSHX bundle patch');
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
  });
}

function assertSingleRuntime(home) {
  const ownLeafLibs = new Set(
    Object.keys(PACKAGE.dependencies ?? {})
      .filter((name) => name.startsWith('@deepseek-ai/dsh'))
      .map((name) => name.slice('@deepseek-ai/'.length))
  );
  const profileModules = path.join(home, 'profiles', PROFILE, 'node_modules', '@deepseek-ai');
  const shadowed = fs.existsSync(profileModules)
    ? fs.readdirSync(profileModules)
        .filter((entry) => /^dsh(-|$)/.test(entry))
        .filter((entry) => !ownLeafLibs.has(entry))
    : [];
  if (shadowed.length > 0) {
    throw new Error(`profile shadows stateful DSH runtime packages: ${shadowed.join(', ')}`);
  }
}

async function verifyInstall(specifier, label) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dshx-${label}-e2e-`));
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    DSH_HOME: home,
    npm_config_cache: path.join(work, 'npm-cache'),
    XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_DATA_HOME: path.join(work, 'data'),
    XDG_STATE_HOME: path.join(work, 'state')
  };
  for (const key of [
    'DSHX_APP_SERVER_CMD', 'DSHX_APP_SERVER_ENDPOINT', 'DSHX_APP_SERVER_TOKEN',
    'DSHX_IPC_BRIDGE_BIN', 'DSHX_ATTACH', 'DSHX_HEADLESS', 'DSHX_TUI_ARGS'
  ]) delete env[key];

  try {
    const dsh = resolveDshInvocation(ROOT, env);
    run(dsh.command, [...dsh.args, 'plugin', '--profile', PROFILE, 'add', specifier], {
      cwd: path.dirname(specifier), env
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', PROFILE, 'package.json'), 'utf8'));
    if (!manifest.dsh?.profile?.bundles?.includes(NAME)) throw new Error('bundle reconcile did not activate DSHX');
    if (manifest.dependencies?.[NAME] == null) throw new Error('profile manifest did not record DSHX dependency');

    const dump = run(dsh.command, [...dsh.args, '--profile', PROFILE, '--dump-config'], { cwd: work, env });
    await assertComposition(dump.stdout);
    const initialized = await probeStdioSurface({ dsh, cwd: work, env });
    if (!String(initialized?.userAgent ?? '').startsWith('dshx/')) {
      throw new Error(`unexpected initialize identity: ${JSON.stringify(initialized)}`);
    }
    assertSingleRuntime(home);
    console.log(`[verify-bundle] ${label} ok: official profile -> stdio -> ${initialized.userAgent}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-source-pack-'));
  try {
    const packed = run('npm', ['pack', '--pack-destination', packDir, '--loglevel', 'error']);
    const name = packed.stdout.trim().split('\n').pop()?.trim();
    if (!name?.endsWith('.tgz')) throw new Error(`npm pack returned no tarball: ${packed.stdout}`);
    await verifyInstall(path.join(packDir, name), 'source bundle');
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  const releaseDir = path.join(ROOT, 'dist', 'release');
  const releases = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter((file) => file.startsWith('dshx-') && file.endsWith('.tgz')).sort()
    : [];
  if (releases.length > 0) {
    await verifyInstall(path.join(releaseDir, releases.at(-1)), 'release bundle');
  } else if (process.env.DSHX_REQUIRE_RELEASE === '1') {
    throw new Error('release flavor required but no dist/release/dshx-*.tgz exists');
  } else {
    console.log('[verify-bundle] release flavor skipped (no platform artifact present)');
  }
  console.log('[verify-bundle] ALL CHECKS PASSED');
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error));
}
