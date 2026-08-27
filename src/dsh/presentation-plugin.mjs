import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { startDshxStdioTransport } from './stdio-transport.mjs';

/**
 * dshx-presentation — native TUI runner over the live DSH composition.
 *
 * The official `dsh --profile tui` process is the parent/runtime owner. This
 * row launches only the pinned presentation binary. Terminal fds 0/1/2 are
 * inherited by the TUI; fd 3 is a private duplex NDJSON pipe bound directly to
 * the already-mounted DSH Context.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROTOCOL_FD = 3;

export const name = 'dshx-presentation';
export const inject = ['dshxStartup'];
export const Config = z.object({});
export const SERVICE_KEY = 'dshxPresentation';

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

export function resolveTuiBinary(environment = process.env, platform = process.platform) {
  if (environment.DSHX_TUI_BIN) return path.resolve(environment.DSHX_TUI_BIN);
  return path.join(PACKAGE_ROOT, 'dist', 'bin', platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui');
}

export const internals = {
  spawnTui: spawn,
  startTransport: startDshxStdioTransport
};

export function apply(ctx) {
  if (!ctx || typeof ctx.provide !== 'function' || typeof ctx.get !== 'function') {
    throw new Error('dshx-presentation requires a live Cordis Context');
  }
  const launch = ctx.dshxStartup;
  if (!launch || typeof launch.home !== 'string' || !Array.isArray(launch.tuiArgs)) {
    throw new Error('dshx-presentation requires the dshxStartup service');
  }

  const log = launch.debug === true
    ? (message) => process.stderr.write(`[dshx] ${message}\n`)
    : () => {};
  const state = {
    child: undefined,
    transport: undefined,
    closing: false,
    finished: false
  };

  const close = async () => {
    if (state.closing) return;
    state.closing = true;
    try { await state.transport?.close?.(); } catch {}
    const child = state.child;
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch {}
    }
  };

  const finish = async (code, detail) => {
    if (state.finished) return;
    state.finished = true;
    try { await state.transport?.close?.(); } catch {}
    if (state.closing) return;
    if (detail) log(detail);
    requestHostExit(ctx, code, log);
  };

  const launchTui = async () => {
    const loader = ctx.get('loader');
    await loader?.await?.();
    if (state.closing) return;

    fs.mkdirSync(launch.home, { recursive: true, mode: 0o700 });
    const executable = resolveTuiBinary(process.env);
    if (!fs.existsSync(executable)) {
      throw new Error(`packaged DSHX TUI binary not found: ${executable}`);
    }

    const child = internals.spawnTui(executable, launch.tuiArgs, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        CODEX_HOME: launch.home,
        DSHX_APP_SERVER_FD: String(PROTOCOL_FD)
      },
      // fd 3 is an anonymous duplex pipe. Keep it synchronous on Windows too:
      // the Rust client wraps the inherited handle in tokio::fs::File, whose
      // blocking adapter works uniformly without FILE_FLAG_OVERLAPPED.
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      windowsHide: false
    });
    state.child = child;

    const protocol = child.stdio?.[PROTOCOL_FD];
    if (!protocol || typeof protocol.on !== 'function' || typeof protocol.write !== 'function') {
      try { child.kill('SIGTERM'); } catch {}
      throw new Error(`native TUI did not expose inherited protocol fd ${PROTOCOL_FD}`);
    }

    state.transport = internals.startTransport({
      ctx,
      cwd: launch.cwd,
      home: launch.home,
      version: launch.version,
      input: protocol,
      output: protocol,
      diagnostics: log,
      onEof: (error) => {
        if (error && !state.closing) {
          log(`protocol pipe closed with error: ${error instanceof Error ? error.message : String(error)}`);
          try { child.kill('SIGTERM'); } catch {}
        }
      }
    });

    child.once('error', (error) => {
      void finish(1, `native TUI spawn failed: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
      void finish(exitCode, signal ? `native TUI exited via ${signal}` : undefined);
    });
  };

  ctx.provide(SERVICE_KEY, Object.freeze({ mode: 'inherited-pipe', fd: PROTOCOL_FD, close }));
  void launchTui().catch((error) => {
    void finish(1, `failed to launch native TUI: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  return close;
}

export const plugin = { name, inject, Config, apply };
export const constants = { PACKAGE_ROOT, PROTOCOL_FD };
