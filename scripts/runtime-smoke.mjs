#!/usr/bin/env node
import process from 'node:process';
import { bootDshxRuntime } from '../src/dsh/runtime-boot.mjs';

const REQUIRED_SERVICES = [
  'agents',
  'llm',
  'sessions',
  'sessionPersistence',
  'tools',
  'permissionPresets',
  'approval',
  'userQuestions',
  'skills'
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
  process.stdout.write(`official DSH runtime booted: ${REQUIRED_SERVICES.join(', ')}\n`);
} finally {
  clearTimeout(timer);
  await ctx?.dispose?.();
}
