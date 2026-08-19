#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.env.DSHX_VERSION || rootPackage.version;
const platform = process.platform;
const arch = process.arch;
const tuiExe = platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui';
const bridgeExe = platform === 'win32' ? 'dshx-ipc-bridge.exe' : 'dshx-ipc-bridge';
const tuiSource = path.join(root, 'dist', 'bin', tuiExe);
const bridgeSource = path.join(root, 'dist', 'bin', bridgeExe);
if (!fs.existsSync(tuiSource)) {
  throw new Error(`Missing built TUI at ${tuiSource}; build the pinned Codex TUI first`);
}
if (!fs.existsSync(bridgeSource)) {
  throw new Error(`Missing built IPC bridge at ${bridgeSource}; build the pinned Codex transport bridge first`);
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
  if (!fs.existsSync(from)) throw new Error(`Release input is missing: ${relative}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// Ship only the production presentation closure. Early TCP/WebSocket protocol
// stubs remain source-tree development fixtures and are deliberately excluded
// from installable artifacts.
copy('bin/dshx.mjs');
copy('src/dsh');
copy('src/protocol');
copy('config');
copy('NOTICE');
copy('upstream/CODEX_COMMIT');
copy('upstream/DSH_COMMIT');
copy('upstream/patches/codex');

fs.mkdirSync(path.join(stage, 'dist', 'bin'), { recursive: true });
fs.copyFileSync(tuiSource, path.join(stage, 'dist', 'bin', tuiExe));
fs.copyFileSync(bridgeSource, path.join(stage, 'dist', 'bin', bridgeExe));
if (platform !== 'win32') {
  fs.chmodSync(path.join(stage, 'dist', 'bin', tuiExe), 0o755);
  fs.chmodSync(path.join(stage, 'dist', 'bin', bridgeExe), 0o755);
}

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
  files: [
    'bin/dshx.mjs',
    'src/dsh',
    'src/protocol',
    'config',
    'dist/bin',
    'upstream',
    'LICENSE',
    'NOTICE',
    'npm-shrinkwrap.json'
  ]
};
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

// Every relative import in the release closure must resolve inside the staged
// package. This prevents a source-tree-only helper from leaking into 1.0.
for (const file of walkJs(stage)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s*)['\"](\.{1,2}\/[^'\"]+)['\"]/g)) {
    const target = resolveLocalImport(path.dirname(file), match[1]);
    if (!target) throw new Error(`Release package has unresolved local import ${match[1]} from ${path.relative(stage, file)}`);
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund'
], { cwd: stage, stdio: 'inherit' });
execFileSync(process.execPath, [
  path.join(root, 'scripts', 'verify-dsh-closure.mjs'),
  stage,
  path.join(stage, 'package-lock.json')
], { cwd: root, stdio: 'inherit' });
fs.renameSync(path.join(stage, 'package-lock.json'), path.join(stage, 'npm-shrinkwrap.json'));

const packOutput = execFileSync(
  npm,
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

// Keep metadata deterministic for a given source/version/platform. Wall clock
// and builder hostname belong in CI provenance, not the distributable sidecar.
const metadata = {
  version,
  platform,
  arch,
  node: process.version,
  dshVersion: rootPackage.dependencies['@deepseek-ai/dsh'],
  codexCommit: fs.readFileSync(path.join(root, 'upstream', 'CODEX_COMMIT'), 'utf8').trim(),
  dshCommit: fs.readFileSync(path.join(root, 'upstream', 'DSH_COMMIT'), 'utf8').trim(),
  transport: 'local-uds-via-stdio-bridge',
  tarball: path.basename(targetTarball)
};
fs.writeFileSync(`${targetTarball}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${targetTarball}\n`);

function* walkJs(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'upstream') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkJs(absolute);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) yield absolute;
  }
}

function resolveLocalImport(directory, specifier) {
  const base = path.resolve(directory, specifier);
  const candidates = [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
