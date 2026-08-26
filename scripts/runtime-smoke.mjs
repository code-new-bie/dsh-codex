#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { bootDshxRuntime } from '../src/dsh/runtime-boot.mjs';
import { ensureProfileInstalled } from '../src/dsh/profile-bootstrap.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

const REQUIRED_SERVICES = [
  'agents',
  'agentDefaultModel',
  'llm',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'sessionProjections',
  'sessionTitle',
  'attachments',
  'tools',
  'commands',
  'compaction',
  'subagents',
  'permissionPresets',
  'approval',
  'userQuestions',
  'skills',
  'planMode'
];

// CI-grade disks boot well inside these defaults; slow checkouts (for example
// a WSL /mnt/c mount) can raise them without touching the script.
const BOOT_TIMEOUT_MS = Number(process.env.DSHX_SMOKE_BOOT_TIMEOUT_MS ?? 20_000);
const DISPOSE_TIMEOUT_MS = Number(process.env.DSHX_SMOKE_DISPOSE_TIMEOUT_MS ?? 10_000);

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

let ctx;
let primaryError;
try {
  // The smoke targets the production surface profile; make sure the official
  // plugin machinery has it installed before composing.
  const ensured = ensureProfileInstalled({
    packageRoot: PACKAGE_ROOT,
    name: PACKAGE.name,
    version: PACKAGE.version
  });
  process.stdout.write(`surface profile '${ensured.profile}' ${ensured.action}\n`);
  process.stdout.write('booting official DSH composition with production patch watchers enabled\n');
  ctx = await withTimeout(
    bootDshxRuntime({ cwd: process.cwd(), watch: true }),
    BOOT_TIMEOUT_MS,
    'official DSH composition boot'
  );
  process.stdout.write('official DSH composition boot completed\n');

  const missing = REQUIRED_SERVICES.filter((name) => ctx.get(name) == null);
  if (missing.length > 0) {
    throw new Error(`official DSH composition is missing required presentation services: ${missing.join(', ')}`);
  }
  // Workspace command probes are Agent-scoped and use the official `tools`
  // service. `workspaceRegistry` was an older composition detail and is not a
  // DSHX product dependency. Command discovery is likewise Agent-scoped in
  // DSH rc.8, so do not invent a fake Agent merely to inspect /compact here.
  process.stdout.write(`official DSH runtime booted: ${REQUIRED_SERVICES.join(', ')}\n`);
} catch (error) {
  primaryError = error;
} finally {
  if (ctx) {
    process.stdout.write('disposing official DSH composition\n');
    try {
      await withTimeout(Promise.resolve(ctx.dispose?.()), DISPOSE_TIMEOUT_MS, 'official DSH composition disposal');
      process.stdout.write('official DSH composition disposed\n');
    } catch (disposeError) {
      if (!primaryError) primaryError = disposeError;
      else process.stderr.write(`secondary DSH disposal failure: ${disposeError instanceof Error ? disposeError.stack : disposeError}\n`);
    }
  }
}

if (primaryError) throw primaryError;
