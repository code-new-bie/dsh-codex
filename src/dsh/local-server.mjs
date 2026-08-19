import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { DshxProductAdapter } from './product-adapter.mjs';
import { bootDshxRuntime } from './runtime-boot.mjs';

const DEFAULT_HOST = '127.0.0.1';

function tokenEquals(actual, expected) {
  const left = Buffer.from(actual ?? '', 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(request, token) {
  const header = request.headers.authorization;
  return typeof header === 'string' && tokenEquals(header, `Bearer ${token}`);
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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

/**
 * Authenticated single-client loopback transport for the pinned Codex TUI.
 * The bearer token is process-ephemeral and accepted only on 127.0.0.1; DSH
 * itself remains in-process behind the official boot composition.
 */
export async function startDshxLocalServer({
  host = DEFAULT_HOST,
  port = 0,
  cwd = process.cwd(),
  home,
  version = '0.1.0-dev',
  token = crypto.randomBytes(32).toString('base64url'),
  runtime,
  bootRuntime = bootDshxRuntime,
  Adapter = DshxProductAdapter,
  log = () => {}
} = {}) {
  if (host !== '127.0.0.1') {
    throw new Error(`DSHX local app-server must bind 127.0.0.1, got ${JSON.stringify(host)}`);
  }
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('DSHX local app-server bearer token must be at least 32 characters');
  }

  const ctx = runtime ?? await bootRuntime({ cwd });
  const server = new WebSocketServer({
    host,
    port,
    maxPayload: 128 << 20,
    verifyClient(info, done) {
      if (!authorized(info.req, token)) {
        done(false, 401, 'Unauthorized');
        return;
      }
      done(true);
    }
  });

  let activeSocket;
  let adapter;
  let closing = false;

  server.on('connection', (socket, request) => {
    if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED) {
      socket.close(1008, 'DSHX accepts one TUI client');
      return;
    }
    activeSocket = socket;
    adapter = new Adapter({
      ctx,
      cwd,
      home,
      version,
      send: (message) => sendJson(socket, message),
      diagnostics: log
    });
    log(`Codex TUI connected from ${request.socket.remoteAddress ?? 'unknown'}`);

    socket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        sendJson(socket, parseError(error));
        return;
      }

      try {
        const handled = await adapter.handle(message);
        if (!handled) return;
        sendJson(socket, handled.response);
        await handled.afterResponse?.();
      } catch (error) {
        log(`request handling failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (message?.id !== undefined) {
          sendJson(socket, {
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    });

    socket.on('close', () => {
      const closedAdapter = adapter;
      adapter = undefined;
      activeSocket = undefined;
      void closedAdapter?.close().catch((error) => log(`adapter close failed: ${error instanceof Error ? error.message : error}`));
    });
    socket.on('error', (error) => log(`socket error: ${error.message}`));
  });

  await new Promise((resolve, reject) => {
    if (server.address()) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('DSHX local app-server did not bind a TCP address');
  }

  const close = async () => {
    if (closing) return;
    closing = true;
    if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          activeSocket?.terminate();
          resolve();
        }, 500);
        activeSocket.once('close', () => { clearTimeout(timer); resolve(); });
        activeSocket.close(1001, 'DSHX shutting down');
      });
    }
    await adapter?.close?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await ctx.dispose?.();
  };

  return {
    host,
    port: address.port,
    url: `ws://${host}:${address.port}`,
    token,
    context: ctx,
    close
  };
}
