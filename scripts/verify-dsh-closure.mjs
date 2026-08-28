#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertLockRootMatchesManifest } from './lock-root-contract.mjs';

const root = path.resolve(process.argv[2] ?? process.cwd());
const packagePath = path.join(root, 'package.json');
const lockPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, fs.existsSync(path.join(root, 'npm-shrinkwrap.json')) ? 'npm-shrinkwrap.json' : 'package-lock.json');

if (!fs.existsSync(packagePath)) throw new Error(`Missing package.json at ${packagePath}`);
if (!fs.existsSync(lockPath)) throw new Error(`Missing npm lockfile at ${lockPath}`);

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Host compatibility and test reproducibility are separate contracts. The
// host-facing @deepseek-ai/dsh peer may be a range, while the source/test graph
// pins one exact DSH release line for every stateful package in the lockfile.
const hostSpec = pkg.dependencies?.['@deepseek-ai/dsh'] ?? pkg.peerDependencies?.['@deepseek-ai/dsh'];
if (typeof hostSpec !== 'string') {
  throw new Error('DSHX requires an @deepseek-ai/dsh dependency or peerDependency host contract');
}
const exactCandidates = [
  pkg.devDependencies?.['@deepseek-ai/dsh'],
  pkg.dependencies?.['@deepseek-ai/dsh'],
  ...Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    .map(([, value]) => value)
].filter((value) => typeof value === 'string' && exactVersion.test(value));
const uniqueCandidates = [...new Set(exactCandidates)];
if (uniqueCandidates.length !== 1) {
  throw new Error(`DSHX requires one exact tested DSH release baseline; found ${JSON.stringify(uniqueCandidates)}`);
}
const expected = uniqueCandidates[0];
if (hostSpec !== expected && !hostSpec.includes(expected)) {
  throw new Error(`@deepseek-ai/dsh host range ${hostSpec} does not include tested baseline ${expected}`);
}

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
// Source package-lock files are also the reviewed manifest freeze contract.
// npm-shrinkwrap files produced for platform artifacts intentionally have a
// different staged root (no devDependencies, platform os/cpu), so they keep
// using the DSH closure check below rather than this source-root assertion.
if (
  path.basename(lockPath) === 'package-lock.json' &&
  typeof pkg.name === 'string' &&
  typeof pkg.version === 'string'
) {
  assertLockRootMatchesManifest(pkg, lock, path.relative(root, lockPath) || 'package-lock.json');
}

const packages = lock.packages ?? {};
const mismatches = [];
let count = 0;
for (const [location, record] of Object.entries(packages)) {
  if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(location)) continue;
  if (!record || typeof record.version !== 'string') continue;
  count += 1;
  if (record.version !== expected) mismatches.push(`${location}: ${record.version}`);
}
if (count === 0) throw new Error('npm lockfile contains no @deepseek-ai/dsh* packages');
if (mismatches.length > 0) {
  throw new Error(
    `DSHX refuses a mixed DeepSeek Harness release closure; expected every @deepseek-ai/dsh* package at ${expected}:\n${mismatches.join('\n')}`
  );
}
process.stdout.write(`Verified ${count} DeepSeek Harness packages at ${expected} (host contract ${hostSpec})\n`);
