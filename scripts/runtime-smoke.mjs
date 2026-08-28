#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureProfileInstalled, resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLIENT = path.join(ROOT, 'scripts', 'profile-pipe-smoke-client.mjs');
const BOOT_TIMEOUT_MS = Number(process.env.DSHX_SMOKE_BOOT_TIMEOUT_MS ?? 90_000);

const ensured = ensureProfileInstalled({
  packageRoot: ROOT,
  name: PACKAGE.name,
  version: PACKAGE.version,
  profile: process.env.DSHX_PROFILE || 'tui'
});
process.stdout.write(`surface profile '${ensured.profile}' ${ensured.action}\n`);

const dsh = resolveDshInvocation(ROOT);
await new Promise((resolve, reject) => {
  const child = spawn(dsh.command, [...dsh.args, '--profile', ensured.profile, CLIENT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSHX_DEBUG: '1',
      DSHX_TUI_BIN: process.execPath
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => finish(new Error(
    `official DSH TUI profile exceeded ${BOOT_TIMEOUT_MS}ms${stderr ? `:\n${stderr}` : ''}`
  )), BOOT_TIMEOUT_MS);
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) {
      try { child.kill('SIGTERM'); } catch {}
      reject(error);
    } else resolve();
  };
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16384); });
  child.on('error', finish);
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      finish(new Error(`official DSH TUI profile failed (code ${code ?? '?'} signal ${signal ?? '-'})${stderr ? `:\n${stderr}` : ''}`));
      return;
    }
    const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('DSHX_PROFILE_PIPE_SMOKE '));
    if (!marker) {
      finish(new Error(`native presentation child never completed directional-pipe initialize${stderr ? `:\n${stderr}` : ''}`));
      return;
    }
    const payload = JSON.parse(marker.slice('DSHX_PROFILE_PIPE_SMOKE '.length));
    if (!String(payload.userAgent ?? '').startsWith('dshx/')) {
      finish(new Error(`unexpected initialize identity: ${JSON.stringify(payload)}`));
      return;
    }
    process.stdout.write(`official DSH composition mounted and served native child: ${payload.userAgent}\n`);
    process.stdout.write('native child exit disposed official DSH composition through appExit\n');
    finish();
  });
});
