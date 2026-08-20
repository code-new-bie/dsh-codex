import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run(npm, [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

run(process.execPath, [
  'scripts/verify-dsh-closure.mjs',
  '.',
  'package-lock.json',
]);

console.log('Frozen npm dependency graph is ready in package-lock.json');
