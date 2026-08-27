import process from 'node:process';
import { createInterface } from 'node:readline';
import { DshxPresentationAdapter } from '../tui-protocol/adapter.mjs';

function parseError(error) {
  return {
    id: null,
    error: {
      code: -32700,
      message: `Parse error: ${error instanceof Error ? error.message : String(error)}`
    }
  };
}

function internalError(message, error) {
  return {
    id: message?.id ?? null,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

/**
 * Start a single-client Codex app-server transport directly on process stdio.
 *
 * The transport owns framing only. The adapter continues to talk exclusively
 * to the already-mounted DSH Context supplied by the hosting composition; it
 * never imports, boots or disposes another Harness runtime.
 */
export function startDshxStdioTransport({
  ctx,
  cwd = process.cwd(),
  home,
  version = '0.1.0-dev',
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  Adapter = DshxPresentationAdapter,
  diagnostics = () => {},
  onEof = () => {}
} = {}) {
  if (!ctx || typeof ctx.get !== 'function') {
    throw new Error('startDshxStdioTransport requires the hosting Cordis Context');
  }
  if (!input || typeof input.on !== 'function') {
    throw new Error('startDshxStdioTransport requires a readable input stream');
  }
  if (!output || typeof output.write !== 'function') {
    throw new Error('startDshxStdioTransport requires a writable output stream');
  }

  const transportFault = (message) => {
    try {
      errorOutput?.write?.(`[dshx] ${message}\n`);
    } catch {
      // Diagnostics must never make the protocol transport less reliable.
    }
  };

  let closing = false;
  let readClosed = false;
  let closePromise;
  const pending = new Set();

  const send = (message) => {
    // stdin may already be at EOF while the final request is still being
    // handled; keep stdout writable until all pending responses drain.
    if (output.destroyed === true || output.writableEnded === true) {
      throw new Error('DSHX stdio app-server output is not writable');
    }
    output.write(`${JSON.stringify(message)}\n`);
  };

  const safeSend = (message) => {
    try {
      send(message);
      return true;
    } catch (error) {
      transportFault(`stdio response send failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const adapter = new Adapter({
    ctx,
    cwd,
    home,
    version,
    send,
    diagnostics
  });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  const handleLine = (line) => {
    if (!line.trim()) return;
    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        safeSend(parseError(error));
        return;
      }

      try {
        const handled = await adapter.handle(message);
        if (!handled) return;
        // Preserve the existing adapter contract: the JSON-RPC response must
        // reach the client before any afterResponse side effect is allowed to
        // emit follow-up notifications.
        if (!safeSend(handled.response)) return;
        await handled.afterResponse?.();
      } catch (error) {
        diagnostics(`stdio request handling failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (message?.id !== undefined) safeSend(internalError(message, error));
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  lines.on('line', handleLine);

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (!readClosed) {
        readClosed = true;
        try {
          lines.close();
        } catch {
          // Already closed by EOF.
        }
      }
      if (pending.size > 0) await Promise.allSettled([...pending]);
      await adapter.close?.();
    })();
    return closePromise;
  };

  lines.once('close', () => {
    const naturalEof = !closing;
    readClosed = true;
    if (!naturalEof) return;
    void close().then(
      () => Promise.resolve(onEof()).catch((error) => transportFault(`stdio EOF callback failed: ${error instanceof Error ? error.message : String(error)}`)),
      (error) => {
        transportFault(`stdio shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        void Promise.resolve(onEof(error)).catch((callbackError) => transportFault(`stdio EOF callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`));
      }
    );
  });

  return Object.freeze({
    mode: 'stdio',
    close,
    send
  });
}

export const internals = { parseError, internalError };
