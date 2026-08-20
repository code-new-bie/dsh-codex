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

function npmInvocation(args) {
  // `npm run` provides the exact npm CLI entrypoint in npm_execpath. Execute
  // that JavaScript file through the current Node process instead of spawning
  // npm.cmd directly: Node 24 on Windows rejects direct .cmd execution with
  // shell:false (EINVAL), while this path is shell-free and identical across
  // Windows, Linux, and macOS.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('DSHX dependency freeze must be started with `npm run freeze:deps` so the exact npm CLI can be reused');
  }
  return [process.execPath, [npmCli, ...args]];
}

assertReleaseNodeVersion();
const [npmCommand, npmVersionArgs] = npmInvocation(['--version']);
const npmVersion = capture(npmCommand, npmVersionArgs);
const npmMajor = Number(npmVersion.split('.')[0]);
if (npmMajor !== 11) {
  throw new Error(`DSHX dependency freeze baseline requires npm 11.x with Node 24; got npm ${npmVersion}`);
}

console.log(`Freezing DSHX dependencies with Node ${process.version} / npm ${npmVersion}`);
const [installCommand, installArgs] = npmInvocation([
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);
run(installCommand, installArgs);

run(process.execPath, [
  'scripts/verify-dsh-closure.mjs',
  '.',
  'package-lock.json',
]);

console.log('Frozen npm dependency graph is ready in package-lock.json');
