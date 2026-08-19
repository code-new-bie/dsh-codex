import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { localServerInternals, startDshxLocalServer } from '../src/dsh/local-server.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdin.once('finish', () => this.exit(0, null));
  }
  exit(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', code, signal));
  }
  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.exit(null, signal);
    return true;
  }
}

function fakeBridgeSpawner() {
  let child;
  return {
    spawn() {
      child = new FakeChild();
      queueMicrotask(() => child.stdout.write('{"dshxBridge":"ready"}\n'));
      return child;
    },
    child() {
      return child;
    }
  };
}

function readJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      stream.off('data', onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    stream.on('data', onData);
  });
}

class FakeAdapter {
  static closes = 0;
  constructor({ send }) {
    this.send = send;
  }
  async handle(message) {
    return { response: { id: message.id, result: { echoed: message.method } } };
  }
  async close() {
    FakeAdapter.closes += 1;
  }
}

test('Windows default local IPC root is anchored below DSHX user presentation home, not TEMP', () => {
  const root = localServerInternals.defaultSocketRoot({
    platform: 'win32',
    home: 'C:\\Users\\Alice\\.dshx\\codex-tui',
    temporaryDirectory: 'C:\\shared-temp',
    userHome: 'C:\\Users\\Alice'
  });
  assert.equal(root, resolve('C:\\Users\\Alice\\.dshx\\codex-tui', 'ipc'));
  assert.doesNotMatch(root.toLowerCase(), /shared-temp/);
});

test('Windows fallback IPC root remains below the current user home when no presentation home is supplied', () => {
  const root = localServerInternals.defaultSocketRoot({
    platform: 'win32',
    temporaryDirectory: 'C:\\shared-temp',
    userHome: 'C:\\Users\\Alice'
  });
  assert.equal(root, resolve('C:\\Users\\Alice', '.dshx', 'codex-tui', 'ipc'));
});

test('Unix default local IPC root stays in tmp; createSocketDirectory enforces an ephemeral subdirectory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-root-test-'));
  try {
    assert.equal(localServerInternals.defaultSocketRoot({ platform: 'linux', temporaryDirectory: root }), root);
    const child = localServerInternals.createSocketDirectory(root);
    assert.match(child, /^.*dshx-/);
    assert.notEqual(child, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local production transport exposes only a unix endpoint and relays RPC over bridge stdio', async () => {
  let disposed = 0;
  FakeAdapter.closes = 0;
  const fake = fakeBridgeSpawner();
  const runtime = { async dispose() { disposed += 1; } };
  const server = await startDshxLocalServer({
    runtime,
    Adapter: FakeAdapter,
    bridgeCommand: 'fake-dshx-ipc-bridge',
    spawnBridge: (...args) => fake.spawn(...args)
  });
  try {
    assert.match(server.url, /^unix:\/\//);
    assert.equal('token' in server, false);

    const response = readJsonLine(fake.child().stdin);
    fake.child().stdout.write(`${JSON.stringify({ id: 7, method: 'initialize', params: {} })}\n`);
    assert.deepEqual(await response, { id: 7, result: { echoed: 'initialize' } });
  } finally {
    await server.close();
  }
  assert.equal(FakeAdapter.closes, 1);
  assert.equal(disposed, 1);
});

test('local production transport returns JSON-RPC parse errors through bridge stdio', async () => {
  const fake = fakeBridgeSpawner();
  const runtime = { async dispose() {} };
  const server = await startDshxLocalServer({
    runtime,
    Adapter: FakeAdapter,
    bridgeCommand: 'fake-dshx-ipc-bridge',
    spawnBridge: (...args) => fake.spawn(...args)
  });
  try {
    const response = readJsonLine(fake.child().stdin);
    fake.child().stdout.write('{not-json}\n');
    const parsed = await response;
    assert.equal(parsed.id, null);
    assert.equal(parsed.error.code, -32700);
  } finally {
    await server.close();
  }
});
