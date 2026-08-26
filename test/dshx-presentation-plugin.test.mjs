import assert from 'node:assert/strict';
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
  plugin as startupPlugin
} from '../src/dsh/startup-plugin.mjs';

const LAUNCH = {
  cwd: '/workspace',
  home: '/home/test/.dshx/codex-tui',
  version: 'test',
  tuiCommand: '/dist/bin/dshx-tui',
  bridgeCommand: '/dist/bin/dshx-ipc-bridge',
  debug: true
};

test('both rows export the Cordis plugin contract with named exports only', () => {
  assert.equal(startupName, 'dshx-startup');
  assert.deepEqual(startupInject, []);
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
    // A stray default export would collapse the module via unwrapExports and
    // drop the named contract (see dsh-tool-todo postmortem 0001).
    assert.doesNotMatch(source, /export default/);
  }
});

test('startup row publishes the launch descriptor from environment + packaged defaults', () => {
  const provided = new Map();
  const ctx = { provide: (key, value) => provided.set(key, value) };
  const previous = { ...process.env };
  process.env.DSHX_TUI_HOME = '/tmp/dshx-launch-home';
  process.env.DSHX_IPC_BRIDGE_BIN = '/opt/bridge-custom';
  process.env.DSHX_DEBUG = '1';
  try {
    startupPlugin.apply(ctx);
    const launch = provided.get('dshxStartup');
    assert.equal(launch.home, '/tmp/dshx-launch-home');
    assert.equal(launch.bridgeCommand, '/opt/bridge-custom');
    assert.equal(launch.debug, true);
    assert.equal(launch.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(typeof launch.tuiCommand, 'string');
  } finally {
    process.env = previous;
  }
});

test('presentation row starts the transport from the injected startup service', async () => {
  const provided = new Map();
  const ctx = Object.assign(
    { provide: (key, value) => provided.set(key, value) },
    { dshxStartup: LAUNCH }
  );
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
    assert.equal(service.url, 'unix:///tmp/dshx-i/d-XXXX/s');
    assert.equal(service.tuiCommand, LAUNCH.tuiCommand, 'the launcher reads the TUI path through the same service');
    assert.equal(typeof service.close, 'function');

    await dispose();
    assert.equal(closed, 1, 'the returned disposer closes the transport exactly once');
  } finally {
    internals.start = originalStart;
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
