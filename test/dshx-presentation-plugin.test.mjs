import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  name,
  inject,
  Config,
  plugin,
  internals,
  SERVICE_KEY,
  constants
} from '../src/dsh/presentation-plugin.mjs';
import {
  name as startupName,
  inject as startupInject,
  Config as startupConfig,
  plugin as startupPlugin
} from '../src/dsh/startup-plugin.mjs';

const LAUNCH = {
  cwd: '/workspace',
  home: path.join(os.tmpdir(), `dshx-presentation-test-${process.pid}`),
  version: 'test',
  debug: true,
  tuiArgs: ['resume', '--last']
};

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdio = [child.stdin, null, null, null, new PassThrough()];
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function fakeContext(launch = LAUNCH, onExit = () => {}) {
  const provided = new Map();
  let loaderAwaited = 0;
  const ctx = {
    dshxStartup: launch,
    provide: (key, value) => provided.set(key, value),
    get: (key) => {
      if (key === 'appExit') return onExit;
      if (key === 'loader') return { await: async () => { loaderAwaited += 1; } };
      return undefined;
    }
  };
  return { ctx, provided, loaderAwaited: () => loaderAwaited };
}

test('startup and presentation expose ordinary Cordis plugin contracts', () => {
  assert.equal(startupName, 'dshx-startup');
  assert.deepEqual(startupInject, ['cmdlineArgs']);
  assert.equal(typeof startupConfig, 'function');
  assert.equal(startupPlugin.name, startupName);

  assert.equal(name, 'dshx-presentation');
  assert.deepEqual(inject, ['dshxStartup']);
  assert.equal(typeof Config, 'function');
  assert.equal(plugin.name, name);
  assert.deepEqual(plugin.inject, inject);
  assert.equal(typeof SERVICE_KEY, 'string');

  for (const file of ['presentation-plugin.mjs', 'startup-plugin.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/dsh/${file}`, import.meta.url)), 'utf8');
    assert.match(source, /export const name/);
    assert.match(source, /export const Config/);
    assert.doesNotMatch(source, /export default/);
  }
});

test('startup publishes the raw official profile arguments for the native TUI', () => {
  const provided = new Map();
  const ctx = {
    cmdlineArgs: { get: () => ['resume', '--last'] },
    provide: (key, value) => provided.set(key, value)
  };
  const previous = process.env.DSHX_TUI_HOME;
  process.env.DSHX_TUI_HOME = path.join(os.tmpdir(), 'dshx-launch-home');
  try {
    startupPlugin.apply(ctx);
    const launch = provided.get('dshxStartup');
    assert.equal(launch.home, path.join(os.tmpdir(), 'dshx-launch-home'));
    assert.deepEqual(launch.tuiArgs, ['resume', '--last']);
    assert.equal('appServer' in launch, false);
    assert.equal('bridgeCommand' in launch, false);
    assert.equal(launch.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } finally {
    if (previous === undefined) delete process.env.DSHX_TUI_HOME;
    else process.env.DSHX_TUI_HOME = previous;
  }
});

test('presentation waits for Loader settlement, launches TUI with directional inherited pipes, and exits through appExit', async () => {
  const exits = [];
  const { ctx, provided, loaderAwaited } = fakeContext(LAUNCH, (code) => exits.push(code));
  const child = fakeChild();
  const spawned = [];
  const transports = [];
  const originalSpawn = internals.spawnTui;
  const originalTransport = internals.startTransport;
  const previousTui = process.env.DSHX_TUI_BIN;
  process.env.DSHX_TUI_BIN = fileURLToPath(new URL('../package.json', import.meta.url));
  internals.spawnTui = (command, args, options) => {
    spawned.push({ command, args, options });
    return child;
  };
  internals.startTransport = (options) => {
    transports.push(options);
    return { mode: 'stdio', close: async () => {} };
  };
  try {
    const dispose = plugin.apply(ctx, {});
    assert.equal(typeof dispose, 'function');
    assert.equal(spawned.length, 0);
    await tick();
    assert.equal(loaderAwaited(), 1);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, LAUNCH.tuiArgs);
    assert.deepEqual(spawned[0].options.stdio, ['pipe', 'inherit', 'inherit', 0, 'pipe']);
    assert.equal(spawned[0].options.env.DSHX_APP_SERVER_INPUT_FD, String(constants.PROTOCOL_INPUT_FD));
    assert.equal(spawned[0].options.env.DSHX_TERMINAL_INPUT_FD, String(constants.TERMINAL_INPUT_FD));
    assert.equal(spawned[0].options.env.DSHX_APP_SERVER_OUTPUT_FD, String(constants.PROTOCOL_OUTPUT_FD));
    assert.equal(transports.length, 1);
    assert.equal(transports[0].ctx, ctx);
    assert.equal(transports[0].input, child.stdio[4]);
    assert.equal(transports[0].output, child.stdin);

    const service = provided.get(SERVICE_KEY);
    assert.equal(service.mode, 'inherited-pipes');
    assert.equal(service.inputFd, 0);
    assert.equal(service.terminalInputFd, 3);
    assert.equal(service.outputFd, 4);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await tick();
    assert.deepEqual(exits, [0]);
    await dispose();
  } finally {
    internals.spawnTui = originalSpawn;
    internals.startTransport = originalTransport;
    if (previousTui === undefined) delete process.env.DSHX_TUI_BIN;
    else process.env.DSHX_TUI_BIN = previousTui;
  }
});

test('disposal terminates a still-running TUI without requesting another host exit', async () => {
  const exits = [];
  const { ctx } = fakeContext(LAUNCH, (code) => exits.push(code));
  const child = fakeChild();
  const originalSpawn = internals.spawnTui;
  const originalTransport = internals.startTransport;
  const previousTui = process.env.DSHX_TUI_BIN;
  process.env.DSHX_TUI_BIN = fileURLToPath(new URL('../package.json', import.meta.url));
  internals.spawnTui = () => child;
  internals.startTransport = () => ({ close: async () => {} });
  try {
    const dispose = plugin.apply(ctx, {});
    await tick();
    await dispose();
    assert.equal(child.killed, true);
    child.emit('exit', 0, null);
    await tick();
    assert.deepEqual(exits, []);
  } finally {
    internals.spawnTui = originalSpawn;
    internals.startTransport = originalTransport;
    if (previousTui === undefined) delete process.env.DSHX_TUI_BIN;
    else process.env.DSHX_TUI_BIN = previousTui;
  }
});
