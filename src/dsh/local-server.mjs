import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DshxReleaseAdapter } from './release-adapter.mjs';
import { bootDshxRuntime } from './runtime-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const READY = 'ready';
const WINDOWS_UNIX_PATH_MAX = 108;

function packagedBridgeBinary() {
  const name = process.platform === 'win32' ? 'dshx-ipc-bridge.exe' : 'dshx-ipc-bridge';
  return process.env.DSHX_IPC_BRIDGE_BIN || path.join(ROOT, 'dist', 'bin', name);
}

function parseError(error) {
  return {
    id: null,
    error: {
      code: -32700,
      message: `Parse error: ${error instanceof Error ? error.message : String(error)}`
    }
  };
}

function defaultSocketRoot({
  home,
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
  userHome = os.homedir()
} = {}) {
  if (platform !== 'win32') return temporaryDirectory;
  // codex_uds can enforce 0700 on Unix. Its Windows implementation inherits
  // directory ACLs instead, so do not trust an arbitrary/shared %TEMP% root.
  // Anchor the rendezvous below the current user's DSHX presentation home,
  // whose parent in turn lives below the user's profile by default. Keep the
  // Windows suffix deliberately short because sockaddr_un.sun_path is bounded.
  const presentationHome = path.resolve(home || path.join(userHome, '.dshx', 'codex-tui'));
  return path.join(presentationHome, 'i');
}

function createSocketDirectory(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, 'd-'));
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function assertSocketPathSupported(socketPath, {
  platform = process.platform,
  windowsUnixPathMax = WINDOWS_UNIX_PATH_MAX
} = {}) {
  if (platform !== 'win32') return;
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  // sun_path needs one byte for the terminating NUL, so the pathname itself
  // must remain strictly shorter than the fixed buffer.
  if (bytes >= windowsUnixPathMax) {
    throw new Error(
      `DSHX local IPC path is ${bytes} UTF-8 bytes; Windows AF_UNIX requires fewer than ${windowsUnixPathMax}. ` +
      'Set DSHX_TUI_HOME to a shorter path under your user profile and retry.'
    );
  }
}

function waitForBridgeReady(lines, child, stderrText) {
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(new Error(`DSHX IPC bridge emitted invalid readiness JSON: ${line}`, { cause: error }));
        return;
      }
      if (message?.dshxBridge !== READY) {
        fail(new Error(`DSHX IPC bridge emitted unexpected readiness message: ${line}`));
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error) => fail(new Error(`failed to start DSHX IPC bridge: ${error.message}`, { cause: error }));
    const onExit = (code, signal) => {
      const detail = stderrText().trim();
      fail(new Error(`DSHX IPC bridge exited before ready (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`));
    };
    const cleanup = () => {
      lines.off('line', onLine);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    lines.once('line', onLine);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 750) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      finish();
    }, timeoutMs);
    child.once('exit', finish);
  });
}

async function cleanupFailedStartup({ lines, bridge, ctx, socketDirectory, log }) {
  lines?.close();
  if (bridge) {
    try {
      if (bridge.stdin?.writable) bridge.stdin.end();
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill?.('SIGTERM');
      await waitForExit(bridge);
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill?.('SIGKILL');
    } catch (error) {
      log(`startup rollback: bridge cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await ctx?.dispose?.();
  } catch (error) {
    log(`startup rollback: DSH dispose failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (socketDirectory) fs.rmSync(socketDirectory, { recursive: true, force: true });
  }
}

/**
 * Starts the production-local DSHX presentation transport.
 *
 * The official DeepSeek Harness runtime remains in-process in Node. The pinned
 * Codex TUI connects only to a private cross-platform Unix-domain socket owned
 * by the tiny packaged Rust bridge. JSON-RPC is relayed between that bridge and
 * this adapter over child stdio; no TCP listener or Codex remote WebSocket mode
 * exists in the production launch path.
 */
export async function startDshxLocalServer({
  cwd = process.cwd(),
  home,
  version = '0.1.0-dev',
  runtime,
  bootRuntime = bootDshxRuntime,
  Adapter = DshxReleaseAdapter,
  log = () => {},
  bridgeCommand = packagedBridgeBinary(),
  bridgeArgs,
  spawnBridge = spawn,
  socketRoot
} = {}) {
  const rendezvousRoot = path.resolve(socketRoot ?? defaultSocketRoot({ home }));
  let socketDirectory;
  let socketPath;
  let ctx = runtime;
  let bridge;
  let lines;
  let adapter;
  let closing = false;
  let stderr = '';

  const send = (message) => {
    if (!bridge?.stdin?.writable) throw new Error('DSHX IPC bridge stdin is not writable');
    bridge.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const safeSend = (message) => {
    try {
      send(message);
      return true;
    } catch (error) {
      log(`IPC response send failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  try {
    socketDirectory = createSocketDirectory(rendezvousRoot);
    socketPath = path.join(socketDirectory, 's');
    assertSocketPathSupported(socketPath);
    ctx ??= await bootRuntime({ cwd });
    const args = bridgeArgs ?? [socketPath];
    bridge = spawnBridge(bridgeCommand, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    bridge.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-8192);
      if (process.env.DSHX_DEBUG === '1') log(`ipc bridge: ${text.trimEnd()}`);
    });
    lines = createInterface({ input: bridge.stdout, crlfDelay: Infinity });
    await waitForBridgeReady(lines, bridge, () => stderr);
    adapter = new Adapter({
      ctx,
      cwd,
      home,
      version,
      send,
      diagnostics: log
    });
  } catch (error) {
    await cleanupFailedStartup({ lines, bridge, ctx, socketDirectory, log });
    throw error;
  }

  lines.on('line', (line) => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        safeSend(parseError(error));
        return;
      }
      if (message?.dshxBridge) {
        log(`IPC bridge control message: ${message.dshxBridge}`);
        return;
      }
      try {
        const handled = await adapter.handle(message);
        if (!handled) return;
        if (!safeSend(handled.response)) return;
        await handled.afterResponse?.();
      } catch (error) {
        log(`request handling failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (message?.id !== undefined) {
          safeSend({
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    })();
  });

  bridge.on('error', (error) => log(`IPC bridge error: ${error.message}`));
  bridge.on('exit', (code, signal) => {
    if (!closing) log(`IPC bridge exited unexpectedly (${signal ?? code ?? 'unknown'})`);
  });

  const close = async () => {
    if (closing) return;
    closing = true;
    lines?.close();
    try {
      await adapter?.close?.();
    } finally {
      if (bridge.stdin?.writable) bridge.stdin.end();
      await waitForExit(bridge);
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
      try {
        await ctx?.dispose?.();
      } finally {
        // The rendezvous directory is presentation transport state only. Its
        // cleanup must not depend on successful DSH runtime disposal.
        if (socketDirectory) fs.rmSync(socketDirectory, { recursive: true, force: true });
      }
    }
  };

  return {
    path: socketPath,
    url: `unix://${socketPath}`,
    context: ctx,
    close
  };
}

export const localServerInternals = {
  WINDOWS_UNIX_PATH_MAX,
  defaultSocketRoot,
  createSocketDirectory,
  assertSocketPathSupported,
  cleanupFailedStartup
};
