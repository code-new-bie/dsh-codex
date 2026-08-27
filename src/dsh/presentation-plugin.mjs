import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import z from '@deepseek-ai/schemastery';
import { startDshxLocalServer } from './local-server.mjs';
import { startDshxStdioTransport } from './stdio-transport.mjs';

/**
 * dshx-presentation — the surface's presentation transport row.
 *
 * Both migration-era transports run against the ALREADY-BOOTED composition of
 * whatever DSH installation hosts this profile. The new stdio app-server mode
 * is the target architecture; the local bridge remains temporarily available
 * until the pinned Codex TUI is switched to spawn an external stdio backend.
 */

/** Stable Cordis plugin name. */
export const name = 'dshx-presentation';

/** The startup row's service is a hard prerequisite for the transport. */
export const inject = ['dshxStartup'];

/** Static legacy socket override retained only during the bridge migration. */
export const Config = z.object({
  socketRoot: z.string()
});

/** Service key published on the Context after the transport is ready. */
export const SERVICE_KEY = 'dshxPresentation';

/** Test seams mirroring the official packages' `internals` convention. */
export const internals = {
  // `start` is kept as the legacy alias so downstream migration tests do not
  // need to change in the same commit that introduces stdio.
  start: startDshxLocalServer,
  startStdio: startDshxStdioTransport,
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
  // Tests/embedding hosts may omit the launcher's optional appExit seam. Do
  // not hard-exit from a Cordis row; record the status and let the host decide.
  process.exitCode = code;
  log(`DSH launcher did not provide appExit; recorded process.exitCode=${code}`);
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
  // the TUI: in raw mode Ctrl+C arrives as a key event (turn interrupt).
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

  if (launch.appServer === true) {
    const transport = await internals.startStdio({
      ctx,
      cwd: launch.cwd,
      home: launch.home,
      version: launch.version,
      diagnostics: log,
      onEof: (error) => requestHostExit(ctx, error ? 1 : 0, log)
    });
    ctx.provide(SERVICE_KEY, {
      mode: 'stdio',
      close: transport.close,
      tuiCommand: launch.tuiCommand
    });
    // Cordis owns row lifetime. Initialization returns immediately with the
    // disposer; stdin EOF requests bounded host exit through appExit.
    return transport.close;
  }

  const server = await internals.start({
    cwd: launch.cwd,
    home: launch.home,
    version: launch.version,
    bridgeCommand: launch.bridgeCommand,
    socketRoot: config.socketRoot,
    // The composition Context already exists; never double-boot. Root-fiber
    // disposal stays owned by the composition, so the transport must not
    // dispose the runtime it lives in.
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
      // Never await the child from plugin apply(): adapter readiness waits for
      // loader.await(), which in turn requires this row to finish mounting.
      // Request official bounded exit after the TUI leaves instead.
      void tuiExit.then(({ code, signal }) => {
        requestHostExit(ctx, code ?? (signal ? 1 : 0), log);
      });
    }
  }

  ctx.provide(SERVICE_KEY, {
    mode: 'bridge',
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

  return server.close;
}

/** Bundle-shaped export consumed by the loader through the patch row. */
export const plugin = { name, inject, Config, apply };
