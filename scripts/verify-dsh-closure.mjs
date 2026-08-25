#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? process.cwd());
const packagePath = path.join(root, 'package.json');
const lockPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, fs.existsSync(path.join(root, 'npm-shrinkwrap.json')) ? 'npm-shrinkwrap.json' : 'package-lock.json');

if (!fs.existsSync(packagePath)) throw new Error(`Missing package.json at ${packagePath}`);
if (!fs.existsSync(lockPath)) throw new Error(`Missing npm lockfile at ${lockPath}`);

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const expected = pkg.dependencies?.['@deepseek-ai/dsh'];
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  throw new Error('DSHX requires an exact @deepseek-ai/dsh dependency version');
}

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages ?? {};
const mismatches = [];
let count = 0;
for (const [location, record] of Object.entries(packages)) {
  // package-lock `packages` keys identify the package by the final
  // node_modules segment. Match only the actual @deepseek-ai/dsh* record,
  // never an arbitrary transitive dependency nested below a DSH package.
  // Example that must NOT match:
  // node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react
  if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(location)) continue;
  if (!record || typeof record.version !== 'string') continue;
  count += 1;
  if (record.version !== expected) {
    mismatches.push(`${location}: ${record.version}`);
  }
}
if (count === 0) throw new Error('npm lockfile contains no @deepseek-ai/dsh* packages');
if (mismatches.length > 0) {
  throw new Error(
    `DSHX refuses a mixed DeepSeek Harness release closure; expected every @deepseek-ai/dsh* package at ${expected}:\n${mismatches.join('\n')}`
  );
}
process.stdout.write(`Verified ${count} DeepSeek Harness packages at ${expected}\n`);
