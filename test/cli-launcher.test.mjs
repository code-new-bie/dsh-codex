import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('dshx --version reports DSHX metadata without bootstrapping or invoking DSH', () => {
  for (const flag of ['--version', '-V']) {
    const result = spawnSync(process.execPath, ['bin/dshx.mjs', flag], {
      cwd: process.cwd(),
      env: { ...process.env, DSHX_DSH_BIN: '/definitely/not/a/dsh/binary' },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
    assert.equal(result.stderr, '');
  }
});
