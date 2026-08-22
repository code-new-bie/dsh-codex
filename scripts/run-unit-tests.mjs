import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');
const TIMEOUT_MS = 30_000;

const files = fs.readdirSync(TEST_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => path.join('test', entry.name))
  .sort();

if (files.length === 0) throw new Error('No unit test files found');

for (const file of files) {
  process.stdout.write(`\n==> ${file}\n`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-force-exit', file],
    {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGTERM'
    }
  );

  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`Unit test file exceeded ${TIMEOUT_MS / 1000}s: ${file}`);
    process.exit(124);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nPassed ${files.length} unit/contract test files.`);
