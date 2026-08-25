import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { name, inject, Config, plugin, internals, SERVICE_KEY } from '../src/dsh/presentation-plugin.mjs';

test('exports the Cordis plugin contract with named exports only', () => {
  assert.equal(name, 'dshx-presentation');
  assert.deepEqual(inject, []);
  // Schemastery schemas are callable validators.
  assert.equal(typeof Config, 'function');
  assert.equal(plugin.name, name);
  assert.deepEqual(plugin.inject, inject);
  assert.equal(plugin.Config, Config);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof SERVICE_KEY, 'string');

  const source = readFileSync(fileURLToPath(new URL('../src/dsh/presentation-plugin.mjs', import.meta.url)), 'utf8');
  assert.match(source, /export const name/);
  assert.match(source, /export const inject/);
  assert.match(source, /export const Config/);
  assert.match(source, /export async function apply/);
  // A stray default export would collapse the module via unwrapExports and
  // drop the named contract (see dsh-tool-todo postmortem 0001).
  assert.doesNotMatch(source, /export default/);
});

test('apply starts the transport against the booted context and provides the service', async () => {
  const provided = new Map();
  const ctx = { provide: (key, value) => provided.set(key, value), get: () => undefined };
  const started = [];
  let closed = 0;
  const originalStart = internals.start;
  internals.start = async (options) => {
    started.push(options);
    return { path: '/tmp/dshx-i/d-XXXX/s', url: 'unix:///tmp/dshx-i/d-XXXX/s', close: async () => { closed += 1; } };
  };
  try {
    const dispose = await plugin.apply(ctx, {
      cwd: '/workspace',
      home: '/home/test/.dshx/codex-tui',
      version: 'test',
      debug: true
    });
    assert.equal(started.length, 1);
    assert.equal(started[0].runtime, ctx, 'plugin must never boot a second runtime');
    assert.equal(started[0].disposeRuntimeOnClose, false, 'root-fiber disposal stays owned by the composition');
    assert.equal(started[0].cwd, '/workspace');

    const service = provided.get(SERVICE_KEY);
    assert.equal(service.url, 'unix:///tmp/dshx-i/d-XXXX/s');
    assert.equal(typeof service.close, 'function');

    await dispose();
    assert.equal(closed, 1, 'the returned disposer closes the transport exactly once');
  } finally {
    internals.start = originalStart;
  }
});

test('apply refuses contexts without the Cordis provide() service seam', async () => {
  await assert.rejects(
    () => plugin.apply({ get: () => undefined }, {}),
    /requires a Cordis Context with provide/
  );
});
