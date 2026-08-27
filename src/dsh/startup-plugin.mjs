import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

/**
 * dshx-startup — ordinary app-argument provider for the `tui` profile.
 *
 * The official DSH launcher owns argv and exposes the immutable inner arguments
 * through `ctx.cmdlineArgs`. DSHX does not need a private app-server sentinel:
 * `dsh --profile tui <args...>` is itself the surface invocation.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let cachedVersion;

export const name = 'dshx-startup';
export const inject = ['cmdlineArgs'];
export const Config = z.object({});

export function resolveVersion() {
  cachedVersion ??= JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  return cachedVersion;
}

export function resolveLaunchDescriptor(environment = process.env, cmdlineArgs = []) {
  return Object.freeze({
    cwd: process.cwd(),
    home: path.resolve(environment.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui')),
    version: resolveVersion(),
    debug: environment.DSHX_DEBUG === '1',
    tuiArgs: Object.freeze(Array.from(cmdlineArgs, String))
  });
}

export function apply(ctx) {
  const cmdlineArgs = ctx.cmdlineArgs?.get?.() ?? [];
  ctx.provide('dshxStartup', resolveLaunchDescriptor(process.env, cmdlineArgs));
}

export const plugin = { name, inject, Config, apply };

export const internals = {
  PACKAGE_ROOT,
  resolveLaunchDescriptor,
  resolveVersion
};
