import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DSHX_NODE_ENGINE,
  DSHX_RELEASE_NODE_MAJOR,
  assertReleaseNodeVersion,
  isSupportedNodeVersion
} from '../src/cli/runtime.mjs';

test('runtime support matches the pinned DSH Node engine boundary', () => {
  assert.equal(DSHX_NODE_ENGINE, '^22.19.0 || >=24.0.0');
  assert.equal(isSupportedNodeVersion('20.20.2'), false);
  assert.equal(isSupportedNodeVersion('22.18.0'), false);
  assert.equal(isSupportedNodeVersion('22.19.0'), true);
  assert.equal(isSupportedNodeVersion('22.23.0'), true);
  assert.equal(isSupportedNodeVersion('23.11.0'), false);
  assert.equal(isSupportedNodeVersion('24.0.0'), true);
  assert.equal(isSupportedNodeVersion('26.3.0'), true);
  assert.equal(isSupportedNodeVersion('not-a-version'), false);
});

test('release/freeze work is intentionally standardized on Node 24 LTS', () => {
  assert.equal(DSHX_RELEASE_NODE_MAJOR, 24);
  assert.doesNotThrow(() => assertReleaseNodeVersion('24.19.0'));
  assert.throws(() => assertReleaseNodeVersion('22.23.0'), /requires Node 24\.x/);
  assert.throws(() => assertReleaseNodeVersion('26.3.0'), /requires Node 24\.x/);
});
