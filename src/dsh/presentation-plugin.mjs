import z from '@deepseek-ai/schemastery';
import { startDshxLocalServer } from './local-server.mjs';

/**
 * Cordis plugin wrapping the DSHX presentation lifetime.
 *
 * The plugin owns the production local-IPC transport: it boots nothing itself
 * (the official DSH composition is already mounted on the injected Context),
 * starts the packaged bridge + JSONL stdio relay against that Context, and
 * publishes the resulting endpoint as the `dshxPresentation` service. Disposal
 * returns the transport closer; teardown authority remains the Cordis root
 * Fiber, matching the official plugin contract (name / inject / Config /
 * apply, named exports only).
 */

/** Stable Cordis plugin name. */
export const name = 'dshx-presentation';

/**
 * No hard service injections on purpose: every DSH capability is consumed
 * lazily through ctx.get so an absent optional service degrades the matching
 * UI instead of blocking the whole composition.
 */
export const inject = [];

/** Serializable launch configuration for the presentation transport. */
export const Config = z.object({
  cwd: z.string(),
  home: z.string(),
  version: z.string(),
  bridgeCommand: z.string(),
  socketRoot: z.string(),
  debug: z.boolean()
});

/** Service key published on the Context after the endpoint is ready. */
export const SERVICE_KEY = 'dshxPresentation';

/** Test seam mirroring the official packages' `internals` convention. */
export const internals = { start: startDshxLocalServer };

export async function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.provide !== 'function') {
    throw new Error('dshx-presentation requires a Cordis Context with provide()');
  }
  const debug = config.debug === true;
  const log = debug ? (message) => process.stderr.write(`[dshx] ${message}\n`) : () => {};

  const server = await internals.start({
    cwd: config.cwd,
    home: config.home,
    version: config.version,
    bridgeCommand: config.bridgeCommand,
    socketRoot: config.socketRoot,
    // The composition Context already exists; never double-boot. Root-fiber
    // disposal stays owned by the caller/fiber, so the transport must not
    // dispose the runtime it lives in (double teardown would re-enter the
    // Fiber from inside its own disposer).
    runtime: ctx,
    disposeRuntimeOnClose: false,
    log
  });

  ctx.provide(SERVICE_KEY, {
    path: server.path,
    url: server.url,
    close: server.close
  });
  return server.close;
}

/** Bundle-shaped export consumed by runtime-boot's dynamic mount. */
export const plugin = { name, inject, Config, apply };
