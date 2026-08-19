#!/usr/bin/env node
import process from 'node:process';
import { bootDshxRuntime } from '../src/dsh/runtime-boot.mjs';

const REQUIRED_SERVICES = [
  'agents',
  'agentDefaultModel',
  'llm',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'sessionProjections',
  'sessionTitle',
  'workspaceRegistry',
  'attachments',
  'tools',
  'commands',
  'compaction',
  'permissionPresets',
  'approval',
  'userQuestions',
  'skills',
  'planMode'
];

let ctx;
const timer = setTimeout(() => {
  process.stderr.write('dshx runtime smoke timed out while booting official DeepSeek Harness\n');
  process.exit(124);
}, 30_000);
timer.unref?.();

try {
  ctx = await bootDshxRuntime({ cwd: process.cwd() });
  const missing = REQUIRED_SERVICES.filter((name) => ctx.get(name) == null);
  if (missing.length > 0) {
    throw new Error(`official DSH composition is missing required presentation services: ${missing.join(', ')}`);
  }
  // Command discovery is Agent-scoped in DSH rc.8. Do not invent a fake Agent
  // just to inspect /compact here: the product-level delegation test proves the
  // command call shape, while this smoke proves the official shipped services compose.
  process.stdout.write(`official DSH runtime booted: ${REQUIRED_SERVICES.join(', ')}\n`);
} finally {
  clearTimeout(timer);
  await ctx?.dispose?.();
}
