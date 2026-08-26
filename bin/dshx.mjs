#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliInvocation } from '../src/cli/arguments.mjs';
import {
  DSHX_DOCTOR_BOOT_TIMEOUT_MS,
  DSHX_DOCTOR_DISPOSE_TIMEOUT_MS,
  isSupportedNodeVersion
} from '../src/cli/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const REQUIRED_RUNTIME_SERVICES = [
  'agents',
  'agentDefaultModel',
  'llm',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
  'sessionProjections',
  'sessionTitle',
  'attachments',
  'tools',
  'commands',
  'compaction',
  'subagents',
  'permissionPresets',
  'approval',
  'userQuestions',
  'skills',
  'planMode',
  // The surface rows themselves: their services exist only when the loader
  // activated the bundle patch (dshx-startup / dshx-presentation).
  'dshxStartup',
  'dshxPresentation'
];

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                     Start DSHX in the current project\n  dshx <prompt>            Start with an initial prompt\n  dshx resume              Open the Codex-style DSH session picker\n  dshx resume --last       Resume the most recent DSH session\n  dshx resume <session>    Resume a specific DSH session\n  dshx doctor              Check packaged TUI, local IPC and official DSH composition\n  dshx --version           Print version\n  dshx --help              Show this help\n\nEnvironment:\n  DSHX_TUI_BIN             Override the packaged DSHX TUI binary (development only)\n  DSHX_IPC_BRIDGE_BIN      Override the packaged local IPC bridge (development only)\n  DSHX_TUI_HOME            Override DSHX presentation-only Codex home (development only)\n  DSHX_PROFILE             Override the DSH profile surface (default: tui)\n  DSHX_DEBUG=1             Print DSHX adapter diagnostics\n\nPlugin usage:\n  The DSHX surface ships as a standard DSH profile bundle. Manage it through\n  the official machinery, e.g.:\n    dsh plugin --profile tui add ${PACKAGE.name}\n  The zero-argument launcher only bootstraps the same profile via the same\n  command, then hands control to the official DSH composition.\n\nProduct boundary:\n  DSHX owns only the launcher, Codex TUI thin fork and presentation adapter.\n  DeepSeek Harness remains the authoritative Agent/Session/Tool runtime.\n  DSHX never reads or writes the user's ordinary CODEX_HOME.\n`;
}

function commandDetail(command, result) {
  if (result.status === 0) return (result.stdout || result.stderr).trim();
  if (result.error) return `${command} failed: ${result.error.message}`;
  return `${command} is not runnable${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function binaryCandidate(baseName) {
  const fileName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  return process.env[baseName === 'dshx-tui' ? 'DSHX_TUI_BIN' : 'DSHX_IPC_BRIDGE_BIN']
    || path.join(ROOT, 'dist', 'bin', fileName);
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * Ensure the selected profile exists and carries this exact package version
 * as an activated bundle layer. Uses the official `dsh plugin add` machinery
 * (profile auto-init + pnpm forward + bundles reconcile); idempotent.
 */
function ensureProfileInstalled(profileName, runtimeBoot) {
  const selected = runtimeBoot.runtimeInternals.selectedProfile(profileName);
  const manifestPath = path.join(dshHome(), 'profiles', selected, 'package.json');
  let satisfied = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const dependencies = manifest.dependencies ?? {};
    satisfied =
      dependencies[PACKAGE.name] === VERSION && bundles.includes(PACKAGE.name);
  } catch {
    // Missing or unreadable manifest: the official command initializes it.
  }
  if (satisfied) return { profile: selected, action: 'already-installed' };

  if (process.env.DSHX_SKIP_PROFILE_BOOTSTRAP === '1') {
    return { profile: selected, action: 'skipped' };
  }
  const result = spawnSync(
    'dsh',
    ['plugin', '--profile', selected, 'add', ROOT],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      "official 'dsh' CLI not found on PATH; install DeepSeek Harness to manage the DSHX surface profile"
    );
  }
  if (result.status !== 0) {
    throw new Error(`failed to install ${PACKAGE.name} into profile '${selected}' via dsh plugin add (exit ${result.status})`);
  }
  return { profile: selected, action: 'installed' };
}

async function loadRuntimeModules() {
  try {
    const runtimeBoot = await import('../src/dsh/runtime-boot.mjs');
    let localServerInternals;
    try {
      ({ localServerInternals } = await import('../src/dsh/local-server.mjs'));
    } catch {
      localServerInternals = undefined;
    }
    return { runtimeBoot, localServerInternals };
  } catch (error) {
    return { loadError: error instanceof Error ? error.message : String(error) };
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
    // the real random rendezvous directory so an obviously-too-long home fails
    // in doctor before a runtime boot is attempted.
    const socketRoot = localServerInternals.defaultSocketRoot({ home });
    const probeSocket = path.join(socketRoot, 'd-XXXXXX', 's');
    localServerInternals.assertSocketPathSupported(probeSocket);
    return { ok: true, detail: home };
  } catch (error) {
    return { ok: false, detail: `${home}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function officialRuntimeCheck(runtimeBoot) {
  let ctx;
  let primaryError;
  let cleanupError;
  try {
    // Doctor deliberately exercises the same official composition and profile
    // watcher path as production startup, including the loader-mounted surface
    // rows (their services double as row-activation evidence). This catches
    // missing native optional dependencies (for example sharp/koffi) that a
    // static bundle-entry check cannot detect. The bounded timeout is
    // intentionally generous enough for first-run Windows module/native
    // initialization on supported hardware.
    ctx = await withTimeout(
      runtimeBoot.bootDshxRuntime({ cwd: process.cwd(), watch: true }),
      DSHX_DOCTOR_BOOT_TIMEOUT_MS,
      'official DSH composition boot'
    );
    const missing = REQUIRED_RUNTIME_SERVICES.filter((name) => ctx.get(name) == null);
    if (missing.length > 0) {
      throw new Error(`official DSH composition is missing required presentation services: ${missing.join(', ')}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (ctx) {
      try {
        await withTimeout(
          Promise.resolve(ctx.dispose?.()),
          DSHX_DOCTOR_DISPOSE_TIMEOUT_MS,
          'official DSH composition disposal'
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (primaryError) {
    const detail = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanup = cleanupError
      ? `; secondary cleanup failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      : '';
    return { ok: false, detail: `${detail}${cleanup}` };
  }
  if (cleanupError) {
    return {
      ok: false,
      detail: `official DSH composition disposal failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    };
  }
  return {
    ok: true,
    detail: `official DSH composition boot/dispose (${REQUIRED_RUNTIME_SERVICES.length} required services, surface rows active)`
  };
}

async function doctor(runtimeBoot) {
  const executable = binaryCandidate('dshx-tui');
  const tuiCheck = fs.existsSync(executable)
    ? spawnSync(executable, ['--version'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '', error: null };
  const bridge = binaryCandidate('dshx-ipc-bridge');
  const bridgeCheck = fs.existsSync(bridge)
    ? spawnSync(bridge, ['--check'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '', error: null };

  const { localServerInternals } = await loadRuntimeModules();
  const homeCheck = presentationHomeCheck(localServerInternals);
  let profileDetail = '';
  let profileOk = true;
  try {
    const ensured = ensureProfileInstalled(undefined, runtimeBoot);
    profileDetail = `profile '${ensured.profile}' (${ensured.action})`;
  } catch (error) {
    profileOk = false;
    profileDetail = error instanceof Error ? error.message : String(error);
  }
  const runtimeCheck = profileOk
    ? await officialRuntimeCheck(runtimeBoot)
    : { ok: false, detail: `skipped: ${profileDetail}` };

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
    ['DeepSeek Harness', runtimeCheck.detail, runtimeCheck.ok],
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
    const [, runtimeBoot] = await loadRuntimeModules().then((m) => [m.loadError ? undefined : m.runtimeBoot, m.runtimeBoot]);
    if (!runtimeBoot) {
      process.stderr.write('dshx: failed to load official DeepSeek Harness runtime modules\n');
      process.exitCode = 1;
      return;
    }
    await doctor(runtimeBoot);
    return;
  }

  if (!isSupportedNodeVersion(process.versions.node)) {
    process.stderr.write(`dshx: unsupported Node ${process.version}; pinned DeepSeek Harness requires ${PACKAGE.engines.node}\n`);
    process.stderr.write('Use Node 24 LTS for the DSHX 1.0 release baseline.\n');
    process.exitCode = 1;
    return;
  }

  const [, runtimeBoot] = await loadRuntimeModules().then((m) => [m.loadError ? undefined : m.runtimeBoot, m.runtimeBoot]);
  if (!runtimeBoot) {
    process.stderr.write('dshx: failed to load official DeepSeek Harness runtime modules\n');
    process.exitCode = 1;
    return;
  }

  const debug = process.env.DSHX_DEBUG === '1';
  let ctx;
  try {
    // Bootstrap the surface profile through the official plugin machinery,
    // then hand control entirely to the official composition: the loader
    // mounts the dshx-startup / dshx-presentation rows declared by the bundle
    // patch, and the transport endpoint arrives as a provided service.
    ensureProfileInstalled(undefined, runtimeBoot);
    ctx = await runtimeBoot.bootDshxRuntime({ cwd: process.cwd(), watch: true });
  } catch (error) {
    process.stderr.write(`dshx: failed to boot DeepSeek Harness surface profile: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  const startup = ctx.get('dshxStartup');
  const presentation = ctx.get('dshxPresentation');
  if (!startup || !presentation || typeof presentation.close !== 'function') {
    process.stderr.write('dshx: surface rows did not publish dshxStartup/dshxPresentation services\n');
    try { await ctx.dispose?.(); } catch { /* primary failure already reported */ }
    process.exitCode = 1;
    return;
  }

  const executable = startup.tuiCommand;
  if (!executable || !fs.existsSync(executable)) {
    process.stderr.write(`dshx: packaged TUI binary not found (${executable ?? 'unknown path'})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    try { await ctx.dispose?.(); } catch { /* ignore secondary */ }
    process.exitCode = 127;
    return;
  }

  const tuiHome = startup.home;
  try {
    fs.mkdirSync(tuiHome, { recursive: true, mode: 0o700 });
  } catch (error) {
    process.stderr.write(`dshx: cannot create presentation home ${tuiHome}: ${error instanceof Error ? error.message : error}\n`);
    try { await ctx.dispose?.(); } catch { /* ignore secondary */ }
    process.exitCode = 1;
    return;
  }

  let child;
  try {
    child = spawn(executable, invocation.tuiArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Do not inherit CODEX_HOME: DSHX uses Codex code as a presentation
        // component only and must not read/write the user's ordinary Codex state.
        CODEX_HOME: tuiHome,
        ...invocation.resumeEnv,
        DSHX_APP_SERVER_ENDPOINT: presentation.url
      },
      stdio: 'inherit',
      windowsHide: false
    });
  } catch (error) {
    process.stderr.write(`dshx: failed to launch pinned Codex TUI: ${error instanceof Error ? error.message : error}\n`);
    try { await ctx.dispose?.(); } catch { /* ignore secondary */ }
    process.exitCode = 127;
    return;
  }

  let closing = false;
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    try {
      // Root-fiber disposal unwinds the dshx-presentation plugin, whose
      // disposer closes the transport; the Fiber remains the sole teardown
      // authority.
      await ctx.dispose?.();
    } catch (error) {
      process.stderr.write(`dshx: shutdown cleanup failed: ${error instanceof Error ? error.message : error}\n`);
      if (exitCode === 0) exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  child.on('error', async (error) => {
    process.stderr.write(`dshx: failed to launch pinned Codex TUI: ${error.message}\n`);
    await close(127);
  });
  child.on('exit', async (code, signal) => {
    if (signal && debug) process.stderr.write(`[dshx] TUI exited via ${signal}\n`);
    await close(code ?? (signal ? 1 : 0));
  });

  // Process-lifecycle signals are forwarded to the TUI. Do not intercept
  // SIGINT: Ctrl+C is an in-TUI interaction used by Codex to interrupt the
  // active DSH turn.
  process.once('SIGTERM', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => {
      if (!child.killed) child.kill('SIGHUP');
    });
  }
}

await run();
