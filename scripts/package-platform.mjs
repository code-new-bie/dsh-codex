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
if (rootPackage.dependencies?.ws) {
  throw new Error('Production DSHX release must not depend on the WebSocket package');
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

// Ship only the production presentation/translation closure. Development
// protocol servers remain in the source repository, but the installable DSHX
// package contains no WebSocket server and no loopback transport dependency.
copy('bin/dshx.mjs');
copy('bin/dshx-app-server.mjs');
copy('src/dsh');
fs.rmSync(path.join(stage, 'src', 'dsh', 'local-server.mjs'), { force: true });
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
  files: ['bin', 'src', 'dist/bin', 'upstream', 'LICENSE', 'NOTICE', 'npm-shrinkwrap.json']
};
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

const forbiddenReleasePaths = [
  path.join(stage, 'src', 'server.mjs'),
  path.join(stage, 'src', 'dsh', 'local-server.mjs')
];
for (const forbidden of forbiddenReleasePaths) {
  if (fs.existsSync(forbidden)) {
    throw new Error(`Production release contains legacy transport module: ${path.relative(stage, forbidden)}`);
  }
}

// Static release-closure check before npm pack. Every local relative import in
// shipped JavaScript must resolve inside the staged package. This also proves
// no retained production module still imports the removed loopback server.
for (const file of walkJs(stage)) {
  const source = fs.readFileSync(file, 'utf8');
  if (/from\s+['\"]ws['\"]|import\s*['\"]ws['\"]/.test(source)) {
    throw new Error(`Production release still imports ws from ${path.relative(stage, file)}`);
  }
  for (const match of source.matchAll(/(?:from\s+|import\s*)['\"](\.{1,2}\/[^'\"]+)['\"]/g)) {
    const target = resolveLocalImport(path.dirname(file), match[1]);
    if (!target) throw new Error(`Release package has unresolved local import ${match[1]} from ${path.relative(stage, file)}`);
  }
}

// A published DSH release is version-synchronized across @deepseek-ai/dsh-*.
// Generate a shrinkwrap from the exact registry closure, then reject packaging
// if npm selected any different DSH release through a peer/caret range. This
// makes future upstream releases fail loudly until DSHX deliberately updates
// its pin, rather than silently shipping a mixed Harness runtime.
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

const metadata = {
  version,
  platform,
  arch,
  node: process.version,
  transport: 'stdio-process-jsonl',
  dshVersion: rootPackage.dependencies['@deepseek-ai/dsh'],
  codexCommit: fs.readFileSync(path.join(root, 'upstream', 'CODEX_COMMIT'), 'utf8').trim(),
  dshCommit: fs.readFileSync(path.join(root, 'upstream', 'DSH_COMMIT'), 'utf8').trim(),
  tarball: path.basename(targetTarball),
  builtAt: new Date().toISOString(),
  host: os.hostname()
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
