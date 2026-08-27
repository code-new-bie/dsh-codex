import process from 'node:process';
import z from '@deepseek-ai/schemastery';
import { startDshxStdioTransport } from './stdio-transport.mjs';

/**
 * dshx-presentation — the DSHX surface row.
 *
 * It owns only protocol framing against the ALREADY-MOUNTED DSH composition.
 * No Harness runtime is imported or booted here and no network/socket bridge is
 * created. The pinned TUI launches this composition as its local stdio backend.
 */

export const name = 'dshx-presentation';
export const inject = ['dshxStartup'];
export const Config = z.object({});
export const SERVICE_KEY = 'dshxPresentation';

export const internals = {
  startStdio: startDshxStdioTransport
};

function appExit(ctx) {
  if (typeof ctx?.get === 'function') {
    const value = ctx.get('appExit');
    if (typeof value === 'function') return value;
  }
  return typeof ctx?.appExit === 'function' ? ctx.appExit : undefined;
}

function requestHostExit(ctx, code, log) {
  const exit = appExit(ctx);
  if (exit) {
    exit(code);
    return;
  }
  // Embedding tests may omit appExit. A Cordis row must never call
  // process.exit(); recording the status leaves final process ownership to the
  // embedding host while preserving failure information.
  process.exitCode = code;
  log(`DSH launcher did not provide appExit; recorded process.exitCode=${code}`);
}

export async function apply(ctx) {
  if (!ctx || typeof ctx.provide !== 'function') {
    throw new Error('dshx-presentation requires a Cordis Context with provide()');
  }
  const launch = ctx.dshxStartup;
  if (!launch || typeof launch.home !== 'string') {
    throw new Error('dshx-presentation requires the dshxStartup service (mount dshx-startup first)');
  }
  if (launch.appServer !== true) {
    throw new Error('dshx-presentation is a stdio app-server surface; launch it through `dshx`');
  }

  const log = launch.debug === true
    ? (message) => process.stderr.write(`[dshx] ${message}\n`)
    : () => {};
  const transport = internals.startStdio({
    ctx,
    cwd: launch.cwd,
    home: launch.home,
    version: launch.version,
    diagnostics: log,
    onEof: (error) => requestHostExit(ctx, error ? 1 : 0, log)
  });

  ctx.provide(SERVICE_KEY, Object.freeze({
    mode: 'stdio',
    close: transport.close
  }));

  // Cordis owns lifetime. Mount completes immediately; stdin EOF closes the
  // adapter and asks the official launcher for bounded composition shutdown.
  return transport.close;
}

export const plugin = { name, inject, Config, apply };
