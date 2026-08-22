import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startDshxLocalServer } from '../src/dsh/local-server.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.stdin.once('finish', () => this.exit(0, null));
  }
  exit(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', code, signal));
  }
  kill(signal = 'SIGTERM') {
    this.exit(null, signal);
    return true;
  }
}

function bridgeSpawner() {
  return () => {
    const child = new FakeChild();
    queueMicrotask(() => child.stdout.write('{"dshxBridge":"ready"}\n'));
    return child;
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent close callers await the same shutdown transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-concurrent-close-test-'));
  const gate = deferred();
  let adapterCloses = 0;
  let disposed = 0;

  class SlowAdapter {
    async handle() {}
    async close() {
      adapterCloses += 1;
      await gate.promise;
    }
  }

  const server = await startDshxLocalServer({
    runtime: { async dispose() { disposed += 1; } },
    Adapter: SlowAdapter,
    bridgeCommand: 'fake-dshx-ipc-bridge',
    spawnBridge: bridgeSpawner(),
    socketRoot: root
  });
  const rendezvousDirectory = dirname(server.path);

  try {
    const first = server.close();
    const second = server.close();
    assert.equal(first, second);
    assert.equal(adapterCloses, 1);
    assert.equal(existsSync(rendezvousDirectory), true);

    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(adapterCloses, 1);
    assert.equal(disposed, 1);
    assert.equal(existsSync(rendezvousDirectory), false);
  } finally {
    gate.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown preserves the first failure while logging later cleanup failures and removing rendezvous state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshx-ipc-close-root-cause-test-'));
  const logs = [];

  class ThrowingAdapter {
    async handle() {}
    async close() {
      throw new Error('primary adapter close failure');
    }
  }

  const server = await startDshxLocalServer({
    runtime: {
      async dispose() {
        throw new Error('secondary DSH dispose failure');
      }
    },
    Adapter: ThrowingAdapter,
    bridgeCommand: 'fake-dshx-ipc-bridge',
    spawnBridge: bridgeSpawner(),
    socketRoot: root,
    log: (message) => logs.push(message)
  });
  const rendezvousDirectory = dirname(server.path);

  try {
    await assert.rejects(server.close(), /primary adapter close failure/);
    assert.ok(logs.some((message) => message.includes('shutdown cleanup: DSH dispose failed: secondary DSH dispose failure')));
    assert.equal(existsSync(rendezvousDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
