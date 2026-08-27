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
  plugin as startupPlugin,
  internals as startupInternals
} from '../src/dsh/startup-plugin.mjs';

const LAUNCH = {
  cwd: '/workspace',
  home: '/home/test/.dshx/codex-tui',
  version: 'test',
  debug: true,
  appServer: true
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

test('both rows expose named Cordis plugin contracts', () => {
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

test('startup consumes the official cmdlineArgs service and selects stdio mode', () => {
  const provided = new Map();
  const ctx = {
    cmdlineArgs: { get: () => ['--dshx-app-server'] },
    provide: (key, value) => provided.set(key, value)
  };
  const previous = process.env.DSHX_TUI_HOME;
  process.env.DSHX_TUI_HOME = '/tmp/dshx-launch-home';
  try {
    startupPlugin.apply(ctx);
    const launch = provided.get('dshxStartup');
    assert.equal(launch.home, '/tmp/dshx-launch-home');
    assert.equal(launch.appServer, true);
    assert.equal(launch.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(startupInternals.isStdioAppServerInvocation(['--other']), false);
    assert.equal('bridgeCommand' in launch, false);
    assert.equal('tuiCommand' in launch, false);
  } finally {
    if (previous === undefined) delete process.env.DSHX_TUI_HOME;
    else process.env.DSHX_TUI_HOME = previous;
  }
});

test('presentation binds stdio directly to the live DSH Context and exits through appExit', async () => {
  const exits = [];
  const { ctx, provided } = fakeContext(LAUNCH, (code) => exits.push(code));
  const started = [];
  let closed = 0;
  const original = internals.startStdio;
  internals.startStdio = (options) => {
    started.push(options);
    return { mode: 'stdio', close: async () => { closed += 1; } };
  };
  try {
    const dispose = await plugin.apply(ctx, {});
    assert.equal(started.length, 1);
    assert.equal(started[0].ctx, ctx, 'the row must use the already-mounted composition');
    assert.equal(started[0].home, LAUNCH.home);
    assert.equal(typeof started[0].onEof, 'function');

    const service = provided.get(SERVICE_KEY);
    assert.equal(service.mode, 'stdio');
    assert.equal(service.url, undefined);
    assert.equal(typeof service.close, 'function');

    started[0].onEof();
    assert.deepEqual(exits, [0]);
    await dispose();
    assert.equal(closed, 1);
  } finally {
    internals.startStdio = original;
  }
});

test('presentation rejects accidental non-app-server profile launches', async () => {
  const { ctx } = fakeContext({ ...LAUNCH, appServer: false });
  await assert.rejects(() => plugin.apply(ctx, {}), /launch it through `dshx`/);
});

test('presentation refuses contexts without the Cordis seams', async () => {
  await assert.rejects(() => plugin.apply({}, {}), /requires a Cordis Context with provide/);
  await assert.rejects(() => plugin.apply({ provide: () => {} }, {}), /requires the dshxStartup service/);
});
