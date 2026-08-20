import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  assert.equal(root, resolve('C:\\Users\\Alice\\.dshx\\codex-tui', 'i'));
  assert.doesNotMatch(root.toLowerCase(), /shared-temp/);
});

test('Windows fallback IPC root remains below the current user home when no presentation home is supplied', () => {
  const root = localServerInternals.defaultSocketRoot({
    platform: 'win32',
    temporaryDirectory: 'C:\\shared-temp',
    userHome: 'C:\\Users\\Alice'
  });
  assert.equal(root, resolve('C:\\Users\\Alice', '.dshx', 'codex-tui', 'i'));
});

test('Windows local IPC path guard measures UTF-8 bytes and reserves the terminating NUL', () => {
  const max = localServerInternals.WINDOWS_UNIX_PATH_MAX;
  assert.equal(max, 108);
  assert.doesNotThrow(() => localServerInternals.assertSocketPathSupported(
    `C:\\${'a'.repeat(104)}`,
    { platform: 'win32' }
  ));
  assert.throws(() => localServerInternals.assertSocketPathSupported(
    `C:\\${'a'.repeat(105)}`,
    { platform: 'win32' }
  ), /requires fewer than 108/);
  assert.throws(() => localServerInternals.assertSocketPathSupported(
    `C:\\${'你'.repeat(35)}`,
    { platform: 'win32' }
  ), /108 UTF-8 bytes/);
});

test('Unix default local IPC root stays in tmp; createSocketDirectory enforces an ephemeral subdirectory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-root-test-'));
  try {
    assert.equal(localServerInternals.defaultSocketRoot({ platform: 'linux', temporaryDirectory: root }), root);
    const child = localServerInternals.createSocketDirectory(root);
    assert.match(child, /^.*d-/);
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

test('startup rollback disposes DSH, terminates the bridge, and removes rendezvous state when Adapter construction fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-adapter-startup-test-'));
  const fake = fakeBridgeSpawner();
  let disposed = 0;
  class ThrowingAdapter {
    constructor() {
      throw new Error('synthetic Adapter constructor failure');
    }
  }
  const runtime = { async dispose() { disposed += 1; } };
  try {
    await assert.rejects(startDshxLocalServer({
      runtime,
      Adapter: ThrowingAdapter,
      bridgeCommand: 'fake-dshx-ipc-bridge',
      spawnBridge: (...args) => fake.spawn(...args),
      socketRoot: root
    }), /synthetic Adapter constructor failure/);
    assert.equal(disposed, 1);
    assert.ok(fake.child().exitCode !== null || fake.child().signalCode !== null);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup rollback removes the rendezvous directory when official DSH boot fails before bridge spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-boot-startup-test-'));
  let spawnCount = 0;
  try {
    await assert.rejects(startDshxLocalServer({
      bootRuntime: async () => {
        throw new Error('synthetic DSH boot failure');
      },
      spawnBridge: () => {
        spawnCount += 1;
        return new FakeChild();
      },
      socketRoot: root
    }), /synthetic DSH boot failure/);
    assert.equal(spawnCount, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup rollback disposes an injected runtime when socket-root creation fails and preserves the filesystem error', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dshx-ipc-root-failure-test-'));
  const blockedRoot = join(parent, 'not-a-directory');
  writeFileSync(blockedRoot, 'block mkdir');
  let disposed = 0;
  const runtime = { async dispose() { disposed += 1; } };
  try {
    await assert.rejects(startDshxLocalServer({
      runtime,
      socketRoot: blockedRoot
    }), (error) => {
      assert.ok(['EEXIST', 'ENOTDIR'].includes(error?.code), `unexpected error code: ${error?.code}`);
      return true;
    });
    assert.equal(disposed, 1);
    assert.equal(existsSync(blockedRoot), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('startup rollback keeps the original failure when DSH disposal also fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-double-failure-test-'));
  const fake = fakeBridgeSpawner();
  const logs = [];
  class ThrowingAdapter {
    constructor() {
      throw new Error('primary startup failure');
    }
  }
  const runtime = {
    async dispose() {
      throw new Error('secondary dispose failure');
    }
  };
  try {
    await assert.rejects(startDshxLocalServer({
      runtime,
      Adapter: ThrowingAdapter,
      bridgeCommand: 'fake-dshx-ipc-bridge',
      spawnBridge: (...args) => fake.spawn(...args),
      socketRoot: root,
      log: (message) => logs.push(message)
    }), /primary startup failure/);
    assert.ok(logs.some((message) => message.includes('startup rollback: DSH dispose failed: secondary dispose failure')));
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('close removes the private rendezvous directory even when DSH disposal fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-close-test-'));
  const fake = fakeBridgeSpawner();
  const runtime = {
    async dispose() {
      throw new Error('synthetic DSH dispose failure');
    }
  };
  const server = await startDshxLocalServer({
    runtime,
    Adapter: FakeAdapter,
    bridgeCommand: 'fake-dshx-ipc-bridge',
    spawnBridge: (...args) => fake.spawn(...args),
    socketRoot: root
  });
  const rendezvousDirectory = dirname(server.path);
  assert.equal(existsSync(rendezvousDirectory), true);
  try {
    await assert.rejects(server.close(), /synthetic DSH dispose failure/);
    assert.equal(existsSync(rendezvousDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
