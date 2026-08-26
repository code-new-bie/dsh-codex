#!/usr/bin/env node
// DSHX launcher — a thin, version-agnostic bootstrap over the official DSH
// machinery. This file deliberately imports NO DeepSeek Harness code: the
// composition is booted by the user's own `dsh` installation, our bundle rows
// are loaded by that installation's loader, and the pinned Codex TUI is
// attached from inside the surface row. Zero harness builds ship or load from
// this launcher, which is what keeps the plugin host-version agnostic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliInvocation } from '../src/cli/arguments.mjs';
import { isSupportedNodeVersion } from '../src/cli/runtime.mjs';
import {
  ensureProfileInstalled,
  profileManifestPath,
  resolveDshInvocation
} from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const DEFAULT_PROFILE = 'tui';

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                     Start DSHX in the current project\n  dshx <prompt>            Start with an initial prompt\n  dshx resume              Open the Codex-style DSH session picker\n  dshx resume --last       Resume the most recent DSH session\n  dshx resume <session>    Resume a specific DSH session\n  dshx doctor              Check packaged TUI, local IPC and official DSH composition\n  dshx --version           Print version\n  dshx --help              Show this help\n\nEnvironment:\n  DSHX_TUI_BIN             Override the packaged DSHX TUI binary (development only)\n  DSHX_IPC_BRIDGE_BIN      Override the packaged local IPC bridge (development only)\n  DSHX_TUI_HOME            Override DSHX presentation-only Codex home (development only)\n  DSHX_PROFILE             Override the DSH profile surface (default: ${DEFAULT_PROFILE})\n  DSHX_DEBUG=1             Print DSHX adapter diagnostics\n\nPlugin usage:\n  The DSHX surface ships as a standard DSH profile bundle. Manage it through\n  the official machinery, e.g.:\n    dsh plugin --profile ${DEFAULT_PROFILE} add ${PACKAGE.name}\n\nCompatibility:\n  Runs against whatever DeepSeek Harness installation hosts the profile; the\n  tested line is announced at startup when they differ. No harness builds are\n  loaded from this launcher.\n\nProduct boundary:\n  DSHX owns only the launcher, Codex TUI thin fork and presentation adapter.\n  DeepSeek Harness remains the authoritative Agent/Session/Tool runtime.\n  DSHX never reads or writes the user's ordinary CODEX_HOME.\n`;
}

function commandDetail(command, result) {
  if (result.status === 0) return (result.stdout || result.stderr).trim();
  if (result.error) return `${command} failed: ${result.error.message}`;
  return `${command} is not runnable${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
}

function binaryCandidate(baseName) {
  const fileName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  return process.env[baseName === 'dshx-tui' ? 'DSHX_TUI_BIN' : 'DSHX_IPC_BRIDGE_BIN']
    || path.join(ROOT, 'dist', 'bin', fileName);
}

function selectedProfile() {
  const value = process.env.DSHX_PROFILE || DEFAULT_PROFILE;
  if (!value.trim()) throw new Error('DSH profile name must be non-empty');
  return value.trim();
}

/** Bootstrap the surface profile through the official plugin machinery. */
export function bootstrapSurfaceProfile() {
  const profile = selectedProfile();
  const manifestPath = profileManifestPath(profile);
  let satisfied = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    satisfied =
      manifest.dependencies?.[PACKAGE.name] === VERSION &&
      manifest.dsh?.profile?.bundles?.includes(PACKAGE.name);
  } catch {
    // Missing or unreadable manifest: the official command initializes it.
  }
  if (satisfied) return { profile, action: 'already-installed' };
  if (process.env.DSHX_SKIP_PROFILE_BOOTSTRAP === '1') {
    return { profile, action: 'skipped' };
  }

  const dsh = resolveDshInvocation(ROOT);
  const result = spawnSync(
    dsh.command,
    [...dsh.args, 'plugin', '--profile', profile, 'add', ROOT],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      "official 'dsh' CLI not found (looked up DSHX_DSH_BIN, the @deepseek-ai/dsh dependency and PATH)"
    );
  }
  if (result.status !== 0) {
    throw new Error(`failed to install ${PACKAGE.name} into profile '${profile}' via dsh plugin add (exit ${result.status ?? '?'})`);
  }
  return { profile, action: 'installed' };
}

async function loadLocalServerInternals() {
  try {
    const { localServerInternals } = await import('../src/dsh/local-server.mjs');
    return localServerInternals;
  } catch {
    return undefined;
  }
}

function presentationHomeCheck(localServerInternals) {
  const home = path.resolve(process.env.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui'));
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(home);
    if (!stat.isDirectory()) throw new Error('path exists but is not a directory');
    fs.accessSync(home, fs.constants.R_OK | fs.constants.W_OK);
    if (!localServerInternals) {
      throw new Error('IPC policy unavailable because DSH modules failed to load');
    }

    // On Windows this also enforces that a custom DSHX_TUI_HOME stays below
    // the current user's profile ACL boundary. Probe the fixed suffix used by
    // the real random rendezvous directory so an obviously-too-long home
    // fails in doctor before a launch is attempted.
    const socketRoot = localServerInternals.defaultSocketRoot({ home });
    const probeSocket = path.join(socketRoot, 'd-XXXXXX', 's');
    localServerInternals.assertSocketPathSupported(probeSocket);
    return { ok: true, detail: home };
  } catch (error) {
    return { ok: false, detail: `${home}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Probe the user's real installation end to end: launch the official CLI for
 * the surface profile in headless-passive mode and wait until the loader has
 * activated the surface rows (visible via the listening hint), proving the
 * whole plugin chain works against THIS machine's actual DSH build.
 */
function surfaceActivationProbe(dsh, profile, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(
      dsh.command,
      [...dsh.args, '--profile', profile],
      {
        cwd: process.cwd(),
        env: { ...process.env, DSHX_ATTACH: '1', DSHX_HEADLESS: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let collected = '';
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already exiting */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `no activation within ${timeoutMs}ms`), timeoutMs);
    const onData = (chunk) => {
      collected += chunk.toString('utf8');
      if (collected.includes('surface listening at')) finish(true, 'surface rows active on your installation');
      if (/credentials-local|does not exist|Cannot find package/.test(collected)) {
        finish(false, collected.trim().split('\n').slice(-3).join(' | '));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => finish(false, error.message));
    child.on('exit', (code) => finish(false, `official CLI exited early (code ${code ?? '?'})`));
  });
}

async function doctor() {
  const executable = binaryCandidate('dshx-tui');
  const tuiCheck = fs.existsSync(executable)
    ? spawnSync(executable, ['--version'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '', error: null };
  const bridge = binaryCandidate('dshx-ipc-bridge');
  const bridgeCheck = fs.existsSync(bridge)
    ? spawnSync(bridge, ['--check'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '', error: null };

  const localServerInternals = await loadLocalServerInternals();
  const homeCheck = presentationHomeCheck(localServerInternals);

  let profileDetail = '';
  let profileOk = true;
  let dsh;
  try {
    const ensured = bootstrapSurfaceProfile();
    profileDetail = `profile '${ensured.profile}' (${ensured.action})`;
    dsh = resolveDshInvocation(ROOT);
  } catch (error) {
    profileOk = false;
    profileDetail = error instanceof Error ? error.message : String(error);
  }

  // The strongest compatibility evidence possible: activate the surface rows
  // against the user's ACTUAL installed build (headless-passive probe).
  let harnessDetail = '';
  let harnessOk = false;
  if (profileOk && bridgeCheck.status === 0) {
    const probe = surfaceActivationProbe(dsh, selectedProfile());
    harnessDetail = probe.detail;
    harnessOk = probe.ok;
  } else {
    harnessDetail = 'skipped: packaged IPC bridge missing';
  }

  const rows = [
    ['Node', `${process.version} (required: ${PACKAGE.engines.node})`, isSupportedNodeVersion(process.versions.node)],
    [
      'Pinned Codex TUI',
      tuiCheck.status === 0 ? commandDetail(executable, tuiCheck) : (executable ? commandDetail(executable, tuiCheck) : 'not found'),
      tuiCheck.status === 0
    ],
    [
      'Local IPC bridge',
      bridgeCheck.status === 0 ? `${bridge} (cross-platform Codex UDS)` : (bridge ? commandDetail(bridge, bridgeCheck) : 'not found'),
      bridgeCheck.status === 0
    ],
    ['Surface profile', profileDetail, profileOk],
    ['DeepSeek Harness (your installation)', harnessDetail, harnessOk],
    ['Presentation home / IPC path', homeCheck.detail, homeCheck.ok]
  ];
  for (const [name, detail, ok] of rows) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}: ${detail}\n`);
  }
  if (rows.some((row) => !row[2])) {
    process.stderr.write(
      process.platform === 'win32'
        ? 'For a source checkout, build the pinned TUI + IPC bridge with `.\\scripts\\build-codex-tui.ps1`; packaged releases include both.\n'
        : 'For a source checkout, build the pinned TUI + IPC bridge with `./scripts/build-codex-tui.sh`; packaged releases include both.\n'
    );
    process.exitCode = 1;
  }
}

async function run() {
  const args = process.argv.slice(2);
  let invocation;

  try {
    invocation = parseCliInvocation(args);
  } catch (error) {
    process.stderr.write(`dshx: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (invocation.kind === 'help') {
    process.stdout.write(usage());
    return;
  }
  if (invocation.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (invocation.kind === 'doctor') {
    await doctor();
    return;
  }

  if (!isSupportedNodeVersion(process.versions.node)) {
    process.stderr.write(`dshx: unsupported Node ${process.version}; pinned DeepSeek Harness requires ${PACKAGE.engines.node}\n`);
    process.stderr.write('Use Node 24 LTS for the DSHX 1.0 release baseline.\n');
    process.exitCode = 1;
    return;
  }

  const executable = binaryCandidate('dshx-tui');
  if (!fs.existsSync(executable)) {
    process.stderr.write(`dshx: packaged TUI binary not found (${executable})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    process.exitCode = 127;
    return;
  }
  const bridge = binaryCandidate('dshx-ipc-bridge');
  if (!fs.existsSync(bridge)) {
    process.stderr.write(`dshx: packaged local IPC bridge not found (${bridge})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    process.exitCode = 127;
    return;
  }

  const debug = process.env.DSHX_DEBUG === '1';
  let profile;
  try {
    profile = bootstrapSurfaceProfile().profile;
  } catch (error) {
    process.stderr.write(`dshx: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  // Hand over to the user's own official DSH installation. The loader mounts
  // our surface rows; the presentation row attaches the pinned TUI because
  // DSHX_ATTACH marks this launching context as interactive.
  const tuiHome = path.resolve(process.env.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui'));
  const dsh = resolveDshInvocation(ROOT);
  const child = spawn(
    dsh.command,
    [...dsh.args, '--profile', profile],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: tuiHome,
        ...(invocation.resumeEnv ?? {}),
        DSHX_ATTACH: '1',
        DSHX_TUI_ARGS: JSON.stringify(invocation.tuiArgs ?? [])
      },
      stdio: 'inherit',
      windowsHide: false
    }
  );

  child.on('error', (error) => {
    process.stderr.write(`dshx: failed to start official DSH CLI: ${error.message}\n`);
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    if (signal && debug) process.stderr.write(`[dshx] official DSH exited via ${signal}\n`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

await run();
