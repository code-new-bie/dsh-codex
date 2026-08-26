import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import z from '@deepseek-ai/schemastery';
import { startDshxLocalServer } from './local-server.mjs';

/**
 * dshx-presentation — the surface's transport host row.
 *
 * Loaded by the Cordis loader through the bundle patch (no dynamic mounting):
 * it starts the packaged bridge + adapter transport against the ALREADY-BOOTED
 * composition of whatever DSH installation hosts this profile — zero harness
 * builds are imported from our own package, so the surface is version-agnostic
 * and rides the user's installation like any official row.
 *
 * Interactive attachment (spawning the pinned Codex TUI on this terminal) is
 * opt-in per launching context via `launch.attach`: entries with TUI-correct
 * signal semantics set it; bare passive launches serve the endpoint with a
 * visible listening hint instead.
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

/** Test seams mirroring the official packages' `internals` convention. */
export const internals = {
  start: startDshxLocalServer,
  spawn,
  isInteractive: () => process.stdout.isTTY === true && process.stdin.isTTY === true
};

function parseTuiArgs(environment) {
  if (!environment.DSHX_TUI_ARGS) return [];
  try {
    const parsed = JSON.parse(environment.DSHX_TUI_ARGS);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function attachTui(launch, server, log) {
  if (!launch.tuiCommand || !fs.existsSync(launch.tuiCommand)) {
    throw new Error(`dshx: packaged TUI binary not found (${launch.tuiCommand ?? 'unknown path'}); run \`dshx doctor\``);
  }
  const child = internals.spawn(launch.tuiCommand, parseTuiArgs(process.env), {
    cwd: launch.cwd,
    env: {
      ...process.env,
      // Do not inherit CODEX_HOME: DSHX uses Codex code as a presentation
      // component only and must not read/write the user's ordinary Codex state.
      CODEX_HOME: launch.home,
      DSHX_APP_SERVER_ENDPOINT: server.url
    },
    stdio: 'inherit',
    windowsHide: false
  });
  // SIGTERM propagates for lifecycle shutdown. SIGINT is intentionally left to
  // the TUI: in raw mode Ctrl+C arrives as a key event (turn interrupt), so no
  // signal ever reaches the hosting composition during normal interaction.
  process.once('SIGTERM', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => {
      if (!child.killed) child.kill('SIGHUP');
    });
  }
  child.on('error', (error) => log(`failed to launch pinned Codex TUI: ${error.message}`));
  const exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit };
}

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

  let tuiExit;
  let attached = false;
  if (launch.attach === true) {
    if (!internals.isInteractive()) {
      log('attach requested but stdout is not an interactive terminal; serving passive endpoint');
    } else {
      const handle = attachTui(launch, server, log);
      tuiExit = handle.exit;
      attached = true;
    }
  }

  ctx.provide(SERVICE_KEY, {
    path: server.path,
    url: server.url,
    close: server.close,
    tuiCommand: launch.tuiCommand,
    ...(tuiExit ? { tuiExit } : {})
  });

  // Passive launches would otherwise sit silently on a live endpoint; mirror
  // the official web surface's printUrl precedent.
  if (!attached) {
    process.stderr.write(`[dshx] surface listening at ${server.url} — start the interactive TUI with \`dshx\`\n`);
  }

  // Keep the row active for as long as the UI lives (same ownership shape as
  // the headless runner awaiting quiescence); disposal closes the transport.
  if (tuiExit) await tuiExit;
  return server.close;
}

/** Bundle-shaped export consumed by the loader through the patch row. */
export const plugin = { name, inject, Config, apply };
