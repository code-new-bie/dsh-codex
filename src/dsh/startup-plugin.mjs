import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

/**
 * dshx-startup — resolve the private app-server launch handshake supplied by
 * the official DSH launcher. The host owns argv and publishes the immutable
 * inner arguments through cmdlineArgs; this row only recognizes DSHX's private
 * stdio sentinel and publishes the presentation launch descriptor.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SERVER_ARG = '--dshx-app-server';
let cachedVersion;

export const name = 'dshx-startup';
export const inject = ['cmdlineArgs'];
export const Config = z.object({});

export function resolveVersion() {
  cachedVersion ??= JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  return cachedVersion;
}

export function isStdioAppServerInvocation(cmdlineArgs = []) {
  return Array.from(cmdlineArgs, String).includes(APP_SERVER_ARG);
}

export function resolveLaunchDescriptor(environment = process.env, cmdlineArgs = []) {
  return {
    cwd: process.cwd(),
    home: path.resolve(environment.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui')),
    version: resolveVersion(),
    debug: environment.DSHX_DEBUG === '1',
    appServer: isStdioAppServerInvocation(cmdlineArgs)
  };
}

export function apply(ctx) {
  const cmdlineArgs = ctx.cmdlineArgs?.get?.() ?? [];
  const launch = resolveLaunchDescriptor(process.env, cmdlineArgs);
  fs.mkdirSync(launch.home, { recursive: true, mode: 0o700 });
  ctx.provide('dshxStartup', launch);
}

export const plugin = { name, inject, Config, apply };

export const internals = {
  APP_SERVER_ARG,
  PACKAGE_ROOT,
  isStdioAppServerInvocation,
  resolveLaunchDescriptor,
  resolveVersion
};
