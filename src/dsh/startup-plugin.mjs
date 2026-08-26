import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

/**
 * dshx-startup — the surface's command-line/environment resolution row.
 *
 * Mirrors the official three-stage launch pattern (see @deepseek-ai/dsh-headless
 * `startup`): a tiny host-plane plugin that turns launcher-provided inputs into
 * one provided service (`dshxStartup`) so downstream rows stay declarative.
 * Inputs come from the documented DSHX_* environment overrides with packaged
 * defaults; no argv parsing, so bare `dsh --profile tui` boots identically.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let cachedVersion;

/** Stable Cordis plugin name. */
export const name = 'dshx-startup';

/** Environment + packaged defaults only; nothing is a hard service dependency. */
export const inject = [];

/** Reserved for future static overrides supplied straight from the patch row. */
export const Config = z.object({});

/** Resolve the package version once from our own manifest. */
export function resolveVersion() {
  cachedVersion ??= JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  return cachedVersion;
}

/** Packaged-binary resolution shared by the TUI and the IPC bridge. */
export function resolvePackagedBinary(baseName, envValue) {
  if (envValue) return envValue;
  const fileName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  return path.join(PACKAGE_ROOT, 'dist', 'bin', fileName);
}

/** Compute the launch descriptor published as the `dshxStartup` service. */
export function resolveLaunchDescriptor(environment = process.env) {
  const home = path.resolve(
    environment.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui')
  );
  return {
    cwd: process.cwd(),
    home,
    version: resolveVersion(),
    tuiCommand: resolvePackagedBinary('dshx-tui', environment.DSHX_TUI_BIN),
    bridgeCommand: resolvePackagedBinary('dshx-ipc-bridge', environment.DSHX_IPC_BRIDGE_BIN),
    debug: environment.DSHX_DEBUG === '1',
    // Only launching contexts with TUI-correct signal semantics (a launcher
    // that leaves SIGINT to the TUI) may take over the terminal; the official
    // dsh CLI maps SIGINT to composition shutdown, so bare `dsh --profile tui`
    // stays a passive endpoint provider by design.
    attach: environment.DSHX_ATTACH === '1' && !environment.DSHX_HEADLESS,
    headless: environment.DSHX_HEADLESS === '1'
  };
}

export function apply(ctx) {
  const launch = resolveLaunchDescriptor();
  fs.mkdirSync(launch.home, { recursive: true, mode: 0o700 });
  ctx.provide('dshxStartup', launch);
  return undefined;
}

/** Bundle-shaped export consumed by the loader through the patch row. */
export const plugin = { name, inject, Config, apply };

export const internals = {
  PACKAGE_ROOT,
  resolveLaunchDescriptor,
  resolvePackagedBinary,
  resolveVersion
};
