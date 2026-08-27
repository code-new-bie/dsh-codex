import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  name,
  inject,
  Config,
  plugin,
  internals,
  SERVICE_KEY
} from '../src/dsh/presentation-plugin.mjs';
import {
  name as startupName,
  inject as startupInject,
  Config as startupConfig,
  plugin as startupPlugin,
  internals as startupInternals
} from '../src/dsh/startup-plugin.mjs';

const LAUNCH = {
  cwd: '/workspace',
  home: '/home/test/.dshx/codex-tui',
  version: 'test',
  tuiCommand: '/dist/bin/dshx-tui',
  bridgeCommand: '/dist/bin/dshx-ipc-bridge',
  debug: true,
  appServer: false,
  attach: false,
  headless: false
};

function fakeContext(launch = LAUNCH, onExit = () => {}) {
  const provided = new Map();
  const ctx = {
    dshxStartup: launch,
    provide: (key, value) => provided.set(key, value),
    get: (key) => key === 'appExit' ? onExit : undefined
  };
  return { ctx, provided };
}

test('both rows export the Cordis plugin contract with named exports only', () => {
  assert.equal(startupName, 'dshx-startup');
  assert.deepEqual(startupInject, ['cmdlineArgs']);
  assert.equal(typeof startupConfig, 'function');
  assert.equal(startupPlugin.name, startupName);
  assert.equal(typeof startupPlugin.apply, 'function');

  assert.equal(name, 'dshx-presentation');
  assert.deepEqual(inject, ['dshxStartup'], 'transport inputs flow exclusively via the startup row');
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

test('startup row reads the official cmdlineArgs service and selects stdio app-server mode', () => {
  const provided = new Map();
  const ctx = {
    cmdlineArgs: { get: () => ['--dshx-app-server'] },
    provide: (key, value) => provided.set(key, value)
  };
  const previous = { ...process.env };
  process.env.DSHX_TUI_HOME = '/tmp/dshx-launch-home';
  process.env.DSHX_IPC_BRIDGE_BIN = '/opt/bridge-custom';
  process.env.DSHX_ATTACH = '1';
  process.env.DSHX_DEBUG = '1';
  try {
    startupPlugin.apply(ctx);
    const launch = provided.get('dshxStartup');
    assert.equal(launch.home, '/tmp/dshx-launch-home');
    assert.equal(launch.bridgeCommand, '/opt/bridge-custom');
    assert.equal(launch.debug, true);
    assert.equal(launch.appServer, true);
    assert.equal(launch.attach, false, 'stdio child owns no terminal attachment');
    assert.equal(launch.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(typeof launch.tuiCommand, 'string');
    assert.equal(startupInternals.isStdioAppServerInvocation(['--other']), false);
  } finally {
    process.env = previous;
  }
});

test('presentation row starts the legacy transport from the injected startup service', async () => {
  const { ctx, provided } = fakeContext();
  let closed = 0;
  const started = [];
  const originalStart = internals.start;
  internals.start = async (options) => {
    started.push(options);
    return { path: '/tmp/dshx-i/d-XXXX/s', url: 'unix:///tmp/dshx-i/d-XXXX/s', close: async () => { closed += 1; } };
  };
  try {
    const dispose = await plugin.apply(ctx, {});
    assert.equal(started.length, 1);
    assert.equal(started[0].runtime, ctx, 'plugin must never boot a second runtime');
    assert.equal(started[0].disposeRuntimeOnClose, false, 'root-fiber disposal stays owned by the composition');
    assert.equal(started[0].home, LAUNCH.home);
    assert.equal(started[0].bridgeCommand, LAUNCH.bridgeCommand);

    const service = provided.get(SERVICE_KEY);
    assert.equal(service.mode, 'bridge');
    assert.equal(service.url, 'unix:///tmp/dshx-i/d-XXXX/s');
    assert.equal(service.tuiCommand, LAUNCH.tuiCommand);
    assert.equal(typeof service.close, 'function');

    await dispose();
    assert.equal(closed, 1, 'the returned disposer closes the transport exactly once');
  } finally {
    internals.start = originalStart;
  }
});

test('stdio app-server mode binds directly to the live DSH Context and exits through appExit on EOF', async () => {
  const exits = [];
  const launch = { ...LAUNCH, appServer: true };
  const { ctx, provided } = fakeContext(launch, (code) => exits.push(code));
  const started = [];
  let closed = 0;
  const originalStartStdio = internals.startStdio;
  internals.startStdio = (options) => {
    started.push(options);
    return { mode: 'stdio', close: async () => { closed += 1; } };
  };
  try {
    const dispose = await plugin.apply(ctx, {});
    assert.equal(started.length, 1);
    assert.equal(started[0].ctx, ctx);
    assert.equal(started[0].home, LAUNCH.home);
    assert.equal(typeof started[0].onEof, 'function');
    const service = provided.get(SERVICE_KEY);
    assert.equal(service.mode, 'stdio');
    assert.equal(service.url, undefined);

    started[0].onEof();
    assert.deepEqual(exits, [0]);
    await dispose();
    assert.equal(closed, 1);
  } finally {
    internals.startStdio = originalStartStdio;
  }
});

test('interactive legacy attachment does not block Cordis mount completion', async () => {
  const exits = [];
  const launch = { ...LAUNCH, attach: true, tuiCommand: process.execPath };
  const { ctx, provided } = fakeContext(launch, (code) => exits.push(code));
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };

  const originalStart = internals.start;
  const originalSpawn = internals.spawn;
  const originalInteractive = internals.isInteractive;
  internals.start = async () => ({ path: '/tmp/s', url: 'unix:///tmp/s', close: async () => {} });
  internals.spawn = () => child;
  internals.isInteractive = () => true;
  try {
    const dispose = await plugin.apply(ctx, {});
    assert.equal(typeof dispose, 'function', 'plugin mount completes while the TUI is still running');
    assert.equal(provided.get(SERVICE_KEY).mode, 'bridge');
    assert.equal(typeof provided.get(SERVICE_KEY).tuiExit?.then, 'function');

    child.emit('exit', 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
    await dispose();
  } finally {
    internals.start = originalStart;
    internals.spawn = originalSpawn;
    internals.isInteractive = originalInteractive;
  }
});

test('presentation row refuses contexts without the Cordis provide() seam or the startup service', async () => {
  await assert.rejects(
    () => plugin.apply({}, {}),
    /requires a Cordis Context with provide/
  );
  await assert.rejects(
    () => plugin.apply({ provide: () => {} }, {}),
    /requires the dshxStartup service/
  );
});
