import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = path.join(ROOT, 'scripts', 'verify-dsh-closure.mjs');

function fixture(lockPackages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-closure-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8' }
  }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: lockPackages
  }));
  return dir;
}

test('DSH closure verifier ignores ordinary dependencies nested below DSH packages', () => {
  const dir = fixture({
    '': { dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8' } },
    'node_modules/@deepseek-ai/dsh': { version: '0.1.0-rc.8' },
    'node_modules/@deepseek-ai/dsh-client-ui-trajectory': { version: '0.1.0-rc.8' },
    'node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react': { version: '19.2.8' },
    'node_modules/@deepseek-ai/dsh-skill-filesystem': { version: '0.1.0-rc.8' },
    'node_modules/@deepseek-ai/dsh-skill-filesystem/node_modules/chokidar': { version: '5.0.0' }
  });
  try {
    const output = execFileSync(process.execPath, [VERIFY, dir, path.join(dir, 'package-lock.json')], { encoding: 'utf8' });
    assert.match(output, /Verified 3 DeepSeek Harness packages at 0\.1\.0-rc\.8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH closure verifier still rejects an actual mismatched DSH package record', () => {
  const dir = fixture({
    '': { dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8' } },
    'node_modules/@deepseek-ai/dsh': { version: '0.1.0-rc.8' },
    'node_modules/@deepseek-ai/dsh-agent': { version: '0.1.0-rc.7' }
  });
  try {
    const result = spawnSync(process.execPath, [VERIFY, dir, path.join(dir, 'package-lock.json')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dsh-agent: 0\.1\.0-rc\.7/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
