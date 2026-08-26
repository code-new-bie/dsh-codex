#!/usr/bin/env node
/**
 * End-to-end proof that DSHX installs and activates as a real DSH profile
 * bundle, using only official machinery:
 *
 *   1. npm pack            -> platform-agnostic bundle tarball
 *   2. dsh plugin add      -> profile init + pnpm install + bundles reconcile
 *   3. dsh --dump-config   -> composed tree contains the surface rows
 *   4. bootDshxRuntime     -> loader activates the rows; services publish
 *   5. single-instance      -> profile copy never shadows healed symlinks
 *
 * Everything runs inside one temporary DSH_HOME; no global state is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = PACKAGE.name;
const PROFILE = 'tui';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshx-bundle-e2e-'));
const home = path.join(work, 'home');
const packDir = path.join(work, 'pack');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(packDir, { recursive: true });

// Keep every toolchain cache inside the temp area so repeated runs stay hermetic.
const isolatedEnv = {
  ...process.env,
  DSH_HOME: home,
  npm_config_cache: path.join(work, 'npm-cache'),
  XDG_CACHE_HOME: path.join(work, 'cache'),
  XDG_DATA_HOME: path.join(work, 'data'),
  XDG_STATE_HOME: path.join(work, 'state')
};

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: isolatedEnv,
    encoding: 'utf8',
    ...(options.spawn ?? {})
  });
  if (result.status === 0 || !options.check) return result;
  throw new Error(`${label} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
}

function fail(message) {
  console.error(`\n[verify-bundle] FAIL: ${message}`);
  process.exitCode = 1;
}

try {
  // In-process boots must see the same DSH_HOME as the spawned CLI steps;
  // several official plugins (e.g. credentials) read the environment directly.
  process.env.DSH_HOME = home;

  // Binaries ship with the companion CLI (dist/bin), not the bundle tarball;
  // the documented environment overrides point the surface at them.
  for (const [envName, fileName] of [
    ['DSHX_IPC_BRIDGE_BIN', 'dshx-ipc-bridge'],
    ['DSHX_TUI_BIN', 'dshx-tui']
  ]) {
    const candidate = path.join(ROOT, 'dist', 'bin', process.platform === 'win32' ? `${fileName}.exe` : fileName);
    if (fs.existsSync(candidate)) process.env[envName] = candidate;
  }

  // ── 1. pack ────────────────────────────────────────────────────────────
  const packed = run('npm pack', 'npm', ['pack', '--pack-destination', packDir, '--loglevel', 'error'], { check: true });
  const tarballName = (packed.stdout.trim().split('\n').pop() || '').trim();
  const tarball = path.join(packDir, tarballName);
  if (!tarballName.endsWith('.tgz') || !fs.existsSync(tarball)) {
    throw new Error(`npm pack did not produce a tarball: ${packed.stdout}`);
  }
  console.log(`[verify-bundle] packed ${tarballName}`);

  // ── 2. official install into a brand-new profile ──────────────────────
  const dsh = resolveDshInvocation(ROOT, isolatedEnv);
  const add = run(
    'dsh plugin add',
    dsh.command,
    [...dsh.args, 'plugin', '--profile', PROFILE, 'add', `./${tarballName}`],
    { cwd: packDir, check: true }
  );
  if (!add.stdout.includes(`initialized profile ${PROFILE}`) && !add.stdout.includes('already')) {
    // First use prints the init line; tolerate either shape but require success.
    console.log('[verify-bundle] (profile init message not on stdout; continuing)');
  }

  const manifestPath = path.join(home, 'profiles', PROFILE, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(NAME)) {
    fail(`reconcile did not append ${NAME} to dsh.profile.bundles: ${JSON.stringify(bundles)}`);
    process.exit(process.exitCode || 1);
  }
  if (manifest.dependencies?.[NAME] == null) {
    fail(`pnpm did not record ${NAME} in profile dependencies`);
    process.exit(process.exitCode || 1);
  }
  console.log(`[verify-bundle] reconcile ok: bundles=${JSON.stringify(bundles)}`);

  // ── 3. composed tree contains the surface rows ─────────────────────────
  // --dump-config emits the composed tree as YAML in the same dialect as
  // patch files (including !!js nodes), so we reuse DSH's own parser.
  const { loadOptionalPatches } = await import('@deepseek-ai/dsh-app-boot');
  const dumpPath = path.join(work, 'dump-config.yml');
  const dump = run('dsh --dump-config', dsh.command, [...dsh.args, '--profile', PROFILE, '--dump-config']);
  if (dump.status !== 0) {
    throw new Error(`--dump-config failed: ${dump.stderr || dump.stdout}`);
  }
  fs.writeFileSync(dumpPath, dump.stdout);
  let tree;
  try {
    tree = loadOptionalPatches('dsh', dumpPath);
  } catch {
    throw new Error(`--dump-config output did not parse as an entry list:\n${dump.stdout.slice(0, 2000)}`);
  }
  const flat = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      if (typeof node.id === 'string') flat.push(node);
      for (const value of Object.values(node)) {
        if (Array.isArray(value) || (value && typeof value === 'object' && value.constructor === Object)) walk(value);
      }
    }
  };
  walk(tree);
  const byId = new Map(flat.map((entry) => [entry.id, entry]));
  for (const id of ['dshx-startup', 'dshx-presentation']) {
    if (!byId.has(id)) {
      fail(`composed tree is missing row '${id}'. Dumped ids: ${[...byId.keys()].join(', ')}`);
      process.exit(process.exitCode || 1);
    }
  }
  const headlessRunner = byId.get('headless-runner');
  if (headlessRunner && headlessRunner.disabled !== true) {
    fail('competing headless-runner row is present but not disabled');
    process.exit(process.exitCode || 1);
  }
  console.log('[verify-bundle] dump-config ok: surface rows composed, locks applied');

  // ── 4. real boot: loader activates rows and services publish ───────────
  const { bootDshxRuntime } = await import('../src/dsh/runtime-boot.mjs');
  let ctx;
  try {
    ctx = await bootDshxRuntime({ cwd: ROOT, home, watch: false });
  } catch (error) {
    // Surface the per-entry failures the AggregateError wraps.
    const dump = (e, depth = 0) => {
      if (!e || depth > 4) return;
      const line = (e.message ?? String(e)).split('\n')[0];
      console.error(`${'  '.repeat(depth)}- ${line}`);
      if (Array.isArray(e.errors)) e.errors.forEach((sub) => dump(sub, depth + 1));
      if (e.cause && e.cause !== e) dump(e.cause, depth + 1);
    };
    console.error('[verify-bundle] boot failure breakdown:');
    dump(error);
    throw error;
  }
  try {
    const startup = ctx.get('dshxStartup');
    const presentation = ctx.get('dshxPresentation');
    if (!startup || startup.home !== path.resolve(process.env.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui'))) {
      throw new Error(`dshxStartup missing or unexpected home: ${JSON.stringify(startup)}`);
    }
    if (!presentation?.url?.startsWith('unix://')) {
      throw new Error(`dshxPresentation missing or bad endpoint: ${JSON.stringify(presentation)}`);
    }
    if (!fs.existsSync(startup.bridgeCommand ?? '')) {
      throw new Error('packaged bridge binary not found; build it before running this verifier');
    }
    console.log(`[verify-bundle] boot ok: transport live at ${presentation.url}`);

    // ── 5. single-instance rule ──────────────────────────────────────────
    // Leaf parser libraries declared as real dependencies (official bundle
    // convention) may live in the profile; stateful runtime services must
    // not — they would shadow the healed installation symlinks.
    const ownLeafLibs = new Set(
      Object.keys(PACKAGE.dependencies ?? {})
        .filter((name) => name.startsWith('@deepseek-ai/dsh'))
        .map((name) => name.slice('@deepseek-ai/'.length))
    );
    const profileModules = path.join(home, 'profiles', PROFILE, 'node_modules', '@deepseek-ai');
    const shadowed = fs.existsSync(profileModules)
      ? fs.readdirSync(profileModules)
          .filter((entry) => /^dsh(-|$)/.test(entry))
          .filter((entry) => !ownLeafLibs.has(entry))
      : [];
    if (shadowed.length > 0) {
      throw new Error(`profile node_modules shadows stateful dsh runtime packages: ${shadowed.join(', ')}`);
    }
    console.log('[verify-bundle] single-instance ok: no stateful dsh runtime copies shadow the healed fallback');
  } finally {
    await ctx.dispose?.();
  }

  console.log('\n[verify-bundle] ALL CHECKS PASSED');
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error));
  console.error(`[verify-bundle] temp workspace preserved for inspection: ${work}`);
} finally {
  if (!process.exitCode) fs.rmSync(work, { recursive: true, force: true });
}
