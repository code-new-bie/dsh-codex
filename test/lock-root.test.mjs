import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assertLockRootMatchesManifest } from '../scripts/lock-root-contract.mjs';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

test('frozen package-lock root exactly matches the current manifest contract', () => {
  assert.doesNotThrow(() => assertLockRootMatchesManifest(manifest, lock));
});

test('lock contract rejects stale direct dependencies and host peer ranges', () => {
  const staleDependency = structuredClone(lock);
  staleDependency.packages[''].devDependencies = {
    ...staleDependency.packages[''].devDependencies,
    ws: '^8.18.0',
  };
  assert.throws(
    () => assertLockRootMatchesManifest(manifest, staleDependency),
    /root devDependencies drift/
  );

  const stalePeer = structuredClone(lock);
  stalePeer.packages[''].peerDependencies['@deepseek-ai/dsh'] = '0.1.0-rc.8';
  assert.throws(
    () => assertLockRootMatchesManifest(manifest, stalePeer),
    /root peerDependencies drift/
  );
});
