import assert from 'node:assert/strict';

export function normalizeBin(bin = {}) {
  return Object.fromEntries(
    Object.entries(bin).map(([name, target]) => [name, String(target).replace(/^\.\//, '')])
  );
}

export function assertLockRootMatchesManifest(manifest, lock, label = 'package-lock.json') {
  const root = lock?.packages?.[''];
  assert.ok(root, `${label} has no root package record`);
  assert.equal(lock.name, manifest.name, `${label} top-level name drift`);
  assert.equal(lock.version, manifest.version, `${label} top-level version drift`);
  assert.equal(root.name, manifest.name, `${label} root name drift`);
  assert.equal(root.version, manifest.version, `${label} root version drift`);

  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'engines',
  ]) {
    assert.deepStrictEqual(
      root[field] ?? {},
      manifest[field] ?? {},
      `${label} root ${field} drift`
    );
  }

  assert.deepStrictEqual(
    normalizeBin(root.bin),
    normalizeBin(manifest.bin),
    `${label} root bin drift`
  );
  return root;
}
