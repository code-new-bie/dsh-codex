#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_DIR = path.resolve(process.env.DSHX_CODEX_DIR || path.join(ROOT, '.upstream', 'codex'));
const MANIFEST = path.join(CODEX_DIR, 'codex-rs', 'Cargo.toml');
const FORBIDDEN = [
  'codex-app-server',
  'codex-core',
  'codex-exec-server',
  'codex-login',
  'codex-rollout',
  'codex-state'
];

function cargo(args) {
  const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024
  });
}

const baseArgs = [
  'tree',
  '--manifest-path', MANIFEST,
  '--locked',
  '--edges', 'normal',
  '-p', 'codex-tui'
];
const tree = cargo([...baseArgs, '--format', '{p}']);
if (tree.error) throw tree.error;
if (tree.status !== 0) {
  process.stderr.write(tree.stdout || '');
  process.stderr.write(tree.stderr || '');
  throw new Error(`cargo tree failed with exit code ${tree.status}`);
}

const packages = new Set();
for (const rawLine of tree.stdout.split(/\r?\n/)) {
  const line = rawLine.trim();
  const match = /^([^\s]+)\s+v\d/.exec(line);
  if (match) packages.add(match[1]);
}
const offenders = FORBIDDEN.filter((name) => packages.has(name));
if (offenders.length === 0) {
  process.stdout.write('DSHX Codex dependency closure is presentation/remote-only\n');
  process.exit(0);
}

process.stderr.write(
  `DSHX release profile still reaches authoritative Codex runtime crates: ${offenders.join(', ')}\n`
);
for (const name of offenders) {
  process.stderr.write(`\n--- reverse dependency path for ${name} ---\n`);
  const inverse = cargo([...baseArgs, '--invert', name]);
  process.stderr.write(inverse.stdout || '');
  process.stderr.write(inverse.stderr || '');
}
process.stderr.write(
  '\nRelease is blocked until codex-tui is built through an explicit remote-only Cargo feature profile and this gate passes.\n'
);
process.exit(1);
