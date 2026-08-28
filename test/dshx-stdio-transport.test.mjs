import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startDshxStdioTransport } from '../src/dsh/stdio-transport.mjs';

function decodeLines(chunks) {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class FakeAdapter {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.closed = 0;
    FakeAdapter.instances.push(this);
  }

  async handle(message) {
    if (message.method === 'notification') {
      this.options.send({ method: 'server/notification', params: { seen: true } });
      return null;
    }
    return {
      response: { id: message.id, result: { echoed: message.method } },
      afterResponse: async () => {
        this.options.send({ method: 'after/response', params: { id: message.id } });
      }
    };
  }

  async close() {
    this.closed += 1;
  }
}

test('stdio transport preserves response-before-afterResponse ordering and closes on EOF', async () => {
  FakeAdapter.instances.length = 0;
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

  let resolveEof;
  const eof = new Promise((resolve) => { resolveEof = resolve; });
  const ctx = { get: () => undefined };
  const transport = startDshxStdioTransport({
    ctx,
    cwd: '/workspace',
    home: '/tmp/dshx-home',
    version: 'test',
    input,
    output,
    errorOutput: errors,
    Adapter: FakeAdapter,
    onEof: resolveEof
  });

  input.write(`${JSON.stringify({ id: 7, method: 'initialize', params: {} })}\n`);
  input.end();
  await eof;

  const messages = decodeLines(chunks);
  assert.deepEqual(messages, [
    { id: 7, result: { echoed: 'initialize' } },
    { method: 'after/response', params: { id: 7 } }
  ]);
  assert.equal(FakeAdapter.instances.length, 1);
  assert.equal(FakeAdapter.instances[0].options.ctx, ctx);
  assert.equal(FakeAdapter.instances[0].closed, 1);
  await transport.close();
  assert.equal(FakeAdapter.instances[0].closed, 1, 'close is idempotent');
});

test('stdio transport returns JSON-RPC parse errors without contaminating stdout with diagnostics', async () => {
  FakeAdapter.instances.length = 0;
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks = [];
  const errorChunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  errors.on('data', (chunk) => errorChunks.push(chunk.toString('utf8')));

  let resolveEof;
  const eof = new Promise((resolve) => { resolveEof = resolve; });
  startDshxStdioTransport({
    ctx: { get: () => undefined },
    input,
    output,
    errorOutput: errors,
    Adapter: FakeAdapter,
    onEof: resolveEof
  });

  input.write('{not-json}\n');
  input.end();
  await eof;

  const messages = decodeLines(chunks);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, null);
  assert.equal(messages[0].error.code, -32700);
  assert.match(messages[0].error.message, /^Parse error:/);
  assert.equal(errorChunks.join(''), '');
});

test('stdio transport keeps adapter notifications on stdout and diagnostics on stderr', async () => {
  FakeAdapter.instances.length = 0;
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

  let resolveEof;
  const eof = new Promise((resolve) => { resolveEof = resolve; });
  startDshxStdioTransport({
    ctx: { get: () => undefined },
    input,
    output,
    errorOutput: errors,
    Adapter: FakeAdapter,
    diagnostics: (message) => errors.write(`[debug] ${message}\n`),
    onEof: resolveEof
  });

  input.write(`${JSON.stringify({ method: 'notification', params: {} })}\n`);
  input.end();
  await eof;

  assert.deepEqual(decodeLines(chunks), [
    { method: 'server/notification', params: { seen: true } }
  ]);
});
