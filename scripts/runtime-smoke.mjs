#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ensureProfileInstalled, resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BOOT_TIMEOUT_MS = Number(process.env.DSHX_SMOKE_BOOT_TIMEOUT_MS ?? 90_000);
const EXIT_TIMEOUT_MS = Number(process.env.DSHX_SMOKE_EXIT_TIMEOUT_MS ?? 15_000);
// `initialize` proves the loader tree has mounted, but rc.8's official
// `runProfile()` still finishes its launcher-owned user-patch watcher setup
// immediately afterwards. That phase has intentionally no public plugin seam.
// Give the host one short bounded turn to settle before testing normal EOF;
// tearing the root down inside that private setup window exercises a launcher
// startup race, not the steady-state app-server lifecycle DSHX owns.
const HOST_SETTLE_GRACE_MS = Number(process.env.DSHX_SMOKE_HOST_SETTLE_GRACE_MS ?? 250);

const ensured = ensureProfileInstalled({
  packageRoot: ROOT,
  name: PACKAGE.name,
  version: PACKAGE.version,
  profile: process.env.DSHX_PROFILE || 'tui'
});
process.stdout.write(`surface profile '${ensured.profile}' ${ensured.action}\n`);

const dsh = resolveDshInvocation(ROOT);
await new Promise((resolve, reject) => {
  const child = spawn(dsh.command, [...dsh.args, '--profile', ensured.profile, '--dshx-app-server'], {
    cwd: process.cwd(),
    env: { ...process.env, DSHX_DEBUG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  let initialized = false;
  let stderr = '';
  let settled = false;
  let timer;
  let settleTimer;
  const arm = (timeoutMs, label) => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(new Error(`official DSH stdio ${label} exceeded ${timeoutMs}ms${stderr ? `:\n${stderr}` : ''}`)), timeoutMs);
  };
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(settleTimer);
    lines.close();
    if (error) {
      try { child.kill('SIGTERM'); } catch {}
      reject(error);
    } else {
      resolve();
    }
  };
  arm(BOOT_TIMEOUT_MS, 'boot');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16384); });
  child.on('error', finish);
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id !== 'runtime-smoke') return;
    if (message.error) {
      finish(new Error(`initialize rejected: ${message.error.message || JSON.stringify(message.error)}`));
      return;
    }
    initialized = true;
    process.stdout.write(`official DSH composition mounted: ${message.result?.userAgent ?? 'dshx'}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    settleTimer = setTimeout(() => {
      if (settled || child.stdin.destroyed) return;
      process.stdout.write('official DSH profile boot settled; closing app-server stdin\n');
      child.stdin.end();
      arm(EXIT_TIMEOUT_MS, 'EOF/appExit shutdown');
    }, HOST_SETTLE_GRACE_MS);
  });
  child.on('exit', (code, signal) => {
    if (!initialized) {
      finish(new Error(`official DSH exited before initialize (${signal ?? code ?? 'unknown'})${stderr ? `:\n${stderr}` : ''}`));
    } else if (code !== 0) {
      finish(new Error(`official DSH EOF disposal failed (code ${code ?? '?'} signal ${signal ?? '-'})${stderr ? `:\n${stderr}` : ''}`));
    } else {
      process.stdout.write('official DSH composition disposed through appExit\n');
      finish();
    }
  });
  child.stdin.write(`${JSON.stringify({
    id: 'runtime-smoke',
    method: 'initialize',
    params: { clientInfo: { name: 'dshx-runtime-smoke', version: PACKAGE.version } }
  })}\n`);
});
