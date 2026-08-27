import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

/**
 * dshx-startup — the surface's command-line/environment resolution row.
 *
 * The DSH launcher owns argv parsing at the host boundary and publishes the
 * app's inner arguments through `cmdlineArgs`. This row consumes only DSHX's
 * private transport selector; every ordinary DSH capability remains owned by
 * the hosting profile/composition.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SERVER_ARG = '--dshx-app-server';
let cachedVersion;

/** Stable Cordis plugin name. */
export const name = 'dshx-startup';

/** The official DSH launcher provides the immutable inner argv snapshot. */
export const inject = ['cmdlineArgs'];

/** Reserved for future static overrides supplied straight from the patch row. */
export const Config = z.object({});

/** Resolve the package version once from our own manifest. */
export function resolveVersion() {
  cachedVersion ??= JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  return cachedVersion;
}

/** Packaged-binary resolution shared by the migration-era TUI and IPC bridge. */
export function resolvePackagedBinary(baseName, envValue) {
  if (envValue) return envValue;
  const fileName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  return path.join(PACKAGE_ROOT, 'dist', 'bin', fileName);
}

/**
 * The app-server selector is an internal handshake between the pinned TUI and
 * this surface, not a public DSH CLI grammar. Public surface flags should use
 * @deepseek-ai/dsh-cmdline's Commander integration; this sentinel deliberately
 * stays dependency-free and exact-match only.
 */
export function isStdioAppServerInvocation(cmdlineArgs = []) {
  return Array.from(cmdlineArgs, String).includes(APP_SERVER_ARG);
}

/** Compute the launch descriptor published as the `dshxStartup` service. */
export function resolveLaunchDescriptor(environment = process.env, cmdlineArgs = []) {
  const home = path.resolve(
    environment.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui')
  );
  const appServer = isStdioAppServerInvocation(cmdlineArgs);
  return {
    cwd: process.cwd(),
    home,
    version: resolveVersion(),
    tuiCommand: resolvePackagedBinary('dshx-tui', environment.DSHX_TUI_BIN),
    bridgeCommand: resolvePackagedBinary('dshx-ipc-bridge', environment.DSHX_IPC_BRIDGE_BIN),
    debug: environment.DSHX_DEBUG === '1',
    appServer,
    // During migration the legacy bridge launch path remains available. The
    // stdio app-server invocation is always passive: the parent TUI already
    // owns the terminal and this DSH process owns only stdin/stdout JSONL.
    attach: !appServer && environment.DSHX_ATTACH === '1' && !environment.DSHX_HEADLESS,
    headless: environment.DSHX_HEADLESS === '1'
  };
}

export function apply(ctx) {
  const cmdlineArgs = ctx.cmdlineArgs?.get?.() ?? [];
  const launch = resolveLaunchDescriptor(process.env, cmdlineArgs);
  fs.mkdirSync(launch.home, { recursive: true, mode: 0o700 });
  ctx.provide('dshxStartup', launch);
  return undefined;
}

/** Bundle-shaped export consumed by the loader through the patch row. */
export const plugin = { name, inject, Config, apply };

export const internals = {
  APP_SERVER_ARG,
  PACKAGE_ROOT,
  isStdioAppServerInvocation,
  resolveLaunchDescriptor,
  resolvePackagedBinary,
  resolveVersion
};
