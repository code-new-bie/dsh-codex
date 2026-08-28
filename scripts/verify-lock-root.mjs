#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertLockRootMatchesManifest } from './lock-root-contract.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : scriptRoot;
const lockPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'package-lock.json');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

assertLockRootMatchesManifest(manifest, lock, path.relative(root, lockPath) || 'package-lock.json');
console.log('Frozen package-lock root matches package.json');
