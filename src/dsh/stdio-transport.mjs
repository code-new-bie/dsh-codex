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
 * The adapter talks only to the already-mounted DSH Context supplied by the
 * hosting composition; this module never boots or disposes a Harness runtime.
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
    try { errorOutput?.write?.(`[dshx] ${message}\n`); } catch {}
  };

  let closing = false;
  let readClosed = false;
  let eofTriggered = false;
  let closePromise;
  const pending = new Set();

  const send = (message) => {
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

  const adapter = new Adapter({ ctx, cwd, home, version, send, diagnostics });
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

  let handleNaturalEof;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    input.off?.('end', handleNaturalEof);
    closePromise = (async () => {
      if (!readClosed) {
        readClosed = true;
        try { lines.close(); } catch {}
      }
      if (pending.size > 0) await Promise.allSettled([...pending]);
      await adapter.close?.();
    })();
    return closePromise;
  };

  handleNaturalEof = () => {
    if (eofTriggered || closing) return;
    eofTriggered = true;
    readClosed = true;
    diagnostics('stdio input EOF; draining presentation requests');
    void close().then(
      async () => {
        diagnostics('stdio presentation drained; requesting host exit');
        try {
          await onEof();
        } catch (error) {
          transportFault(`stdio EOF callback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      async (error) => {
        transportFault(`stdio shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        try {
          await onEof(error);
        } catch (callbackError) {
          transportFault(`stdio EOF callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`);
        }
      }
    );
  };

  // The underlying stream's `end` is the authoritative EOF fact. readline's
  // `close` remains a fallback for Readable implementations that close the
  // interface without first surfacing `end`.
  input.once('end', handleNaturalEof);
  lines.once('close', () => {
    if (!closing) handleNaturalEof();
  });

  return Object.freeze({ mode: 'stdio', close, send });
}

export const internals = { parseError, internalError };
