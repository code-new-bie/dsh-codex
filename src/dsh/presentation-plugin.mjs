import process from 'node:process';
import z from '@deepseek-ai/schemastery';
import { startDshxStdioTransport } from './stdio-transport.mjs';

/**
 * dshx-presentation — presentation framing over the live DSH composition.
 * No Harness runtime or network/socket host is created by this row.
 */
export const name = 'dshx-presentation';
export const inject = ['dshxStartup'];
export const Config = z.object({});
export const SERVICE_KEY = 'dshxPresentation';

export const internals = { startStdio: startDshxStdioTransport };

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
    log(`requesting official DSH appExit(${code})`);
    exit(code);
    return;
  }
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

  ctx.provide(SERVICE_KEY, Object.freeze({ mode: 'stdio', close: transport.close }));
  return transport.close;
}

export const plugin = { name, inject, Config, apply };
