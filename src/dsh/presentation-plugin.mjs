import z from '@deepseek-ai/schemastery';
import { startDshxLocalServer } from './local-server.mjs';

/**
 * dshx-presentation — the surface's transport host row.
 *
 * Loaded by the Cordis loader through the bundle patch (no dynamic mounting):
 * it starts the packaged bridge + adapter transport against the already-booted
 * official composition Context, publishes the endpoint as the
 * `dshxPresentation` service, and returns the transport closer as its
 * disposer. Teardown authority remains the Cordis root Fiber.
 *
 * Launch inputs arrive exclusively from the injected `dshxStartup` service
 * (see startup-plugin.mjs) — the official three-stage pattern — so this module
 * carries no environment or path policy of its own.
 */

/** Stable Cordis plugin name. */
export const name = 'dshx-presentation';

/** The startup row's service is a hard prerequisite for the transport. */
export const inject = ['dshxStartup'];

/** Static overrides straight from the patch row; everything else flows via dshxStartup. */
export const Config = z.object({
  socketRoot: z.string()
});

/** Service key published on the Context after the endpoint is ready. */
export const SERVICE_KEY = 'dshxPresentation';

/** Test seam mirroring the official packages' `internals` convention. */
export const internals = { start: startDshxLocalServer };

export async function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.provide !== 'function') {
    throw new Error('dshx-presentation requires a Cordis Context with provide()');
  }
  const launch = ctx.dshxStartup;
  if (!launch || typeof launch.home !== 'string') {
    throw new Error('dshx-presentation requires the dshxStartup service (mount the dshx-startup row first)');
  }
  const debug = launch.debug === true;
  const log = debug ? (message) => process.stderr.write(`[dshx] ${message}\n`) : () => {};

  const server = await internals.start({
    cwd: launch.cwd,
    home: launch.home,
    version: launch.version,
    bridgeCommand: launch.bridgeCommand,
    socketRoot: config.socketRoot,
    // The composition Context already exists; never double-boot. Root-fiber
    // disposal stays owned by the composition, so the transport must not
    // dispose the runtime it lives in (double teardown would re-enter the
    // Fiber from inside its own disposer).
    runtime: ctx,
    disposeRuntimeOnClose: false,
    log
  });

  ctx.provide(SERVICE_KEY, {
    path: server.path,
    url: server.url,
    close: server.close,
    tuiCommand: launch.tuiCommand
  });

  // Passive launches (bare `dsh --profile tui`, scripts, CI) would otherwise
  // sit silently on a live endpoint; mirror the official web surface's
  // printUrl precedent so the listening state is always visible.
  process.stderr.write(`[dshx] surface listening at ${server.url} — start the interactive TUI with \`dshx\`\n`);
  return server.close;
}

/** Bundle-shaped export consumed by the loader through the patch row. */
export const plugin = { name, inject, Config, apply };
