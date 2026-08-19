#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.env.DSHX_VERSION || rootPackage.version;
const platform = process.platform;
const arch = process.arch;
const exe = platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui';
const tuiSource = path.join(root, 'dist', 'bin', exe);
if (!fs.existsSync(tuiSource)) {
  throw new Error(`Missing built TUI at ${tuiSource}; build the pinned Codex TUI first`);
}

const releaseRoot = path.join(root, '.release');
const stage = path.join(releaseRoot, `dshx-${platform}-${arch}`);
const out = path.join(root, 'dist', 'release');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(out, { recursive: true });

function copy(relative) {
  const from = path.join(root, relative);
  const to = path.join(stage, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

copy('bin/dshx.mjs');
copy('src/dsh');
copy('NOTICE');
copy('upstream/CODEX_COMMIT');
copy('upstream/DSH_COMMIT');
copy('upstream/patches/codex');

fs.mkdirSync(path.join(stage, 'dist', 'bin'), { recursive: true });
fs.copyFileSync(tuiSource, path.join(stage, 'dist', 'bin', exe));
if (platform !== 'win32') fs.chmodSync(path.join(stage, 'dist', 'bin', exe), 0o755);

const codexLicense = path.join(root, '.upstream', 'codex', 'LICENSE');
if (!fs.existsSync(codexLicense)) {
  throw new Error('Pinned Codex LICENSE is missing; materialize Codex before packaging');
}
fs.copyFileSync(codexLicense, path.join(stage, 'LICENSE'));

const packageJson = {
  name: 'dsh-codex',
  version,
  description: 'Codex-grade TUI presentation for official DeepSeek Harness',
  type: 'module',
  license: 'Apache-2.0',
  os: [platform],
  cpu: [arch],
  engines: { node: '>=20' },
  bin: { dshx: './bin/dshx.mjs' },
  dependencies: rootPackage.dependencies,
  repository: { type: 'git', url: 'https://github.com/code-new-bie/dsh-codex.git' },
  files: ['bin', 'src/dsh', 'dist/bin', 'upstream', 'LICENSE', 'NOTICE']
};
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

const packOutput = execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', stage, '--pack-destination', out, '--json'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);
const packed = JSON.parse(packOutput);
const filename = packed[0]?.filename;
if (!filename) throw new Error(`npm pack did not return a filename: ${packOutput}`);
const sourceTarball = path.join(out, filename);
const targetTarball = path.join(out, `dshx-${version}-${platform}-${arch}.tgz`);
if (path.resolve(sourceTarball) !== path.resolve(targetTarball)) {
  fs.rmSync(targetTarball, { force: true });
  fs.renameSync(sourceTarball, targetTarball);
}

const metadata = {
  version,
  platform,
  arch,
  node: process.version,
  codexCommit: fs.readFileSync(path.join(root, 'upstream', 'CODEX_COMMIT'), 'utf8').trim(),
  dshCommit: fs.readFileSync(path.join(root, 'upstream', 'DSH_COMMIT'), 'utf8').trim(),
  tarball: path.basename(targetTarball),
  builtAt: new Date().toISOString(),
  host: os.hostname()
};
fs.writeFileSync(`${targetTarball}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${targetTarball}\n`);
