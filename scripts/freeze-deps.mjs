import { spawnSync } from 'node:child_process';
import { assertReleaseNodeVersion } from '../src/cli/runtime.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}: ${result.stderr?.trim() ?? ''}`);
  }
  return result.stdout.trim();
}

assertReleaseNodeVersion();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmVersion = capture(npm, ['--version']);
const npmMajor = Number(npmVersion.split('.')[0]);
if (npmMajor !== 11) {
  throw new Error(`DSHX dependency freeze baseline requires npm 11.x with Node 24; got npm ${npmVersion}`);
}

console.log(`Freezing DSHX dependencies with Node ${process.version} / npm ${npmVersion}`);
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
