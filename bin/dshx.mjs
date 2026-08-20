#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliInvocation } from '../src/cli/arguments.mjs';
import { startDshxLocalServer } from '../src/dsh/local-server.mjs';
import { dshxRuntimeEntries } from '../src/dsh/runtime-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                     Start DSHX in the current project\n  dshx <prompt>            Start with an initial prompt\n  dshx resume              Open the Codex-style DSH session picker\n  dshx resume --last       Resume the most recent DSH session\n  dshx resume <session>    Resume a specific DSH session\n  dshx doctor              Check packaged TUI, local IPC and official DSH composition\n  dshx --version           Print version\n  dshx --help              Show this help\n\nEnvironment:\n  DSHX_TUI_BIN             Override the packaged DSHX TUI binary (development only)\n  DSHX_IPC_BRIDGE_BIN      Override the packaged local IPC bridge (development only)\n  DSHX_TUI_HOME            Override DSHX presentation-only Codex home (development only)\n  DSHX_DEBUG=1             Print DSHX adapter diagnostics\n\nProduct boundary:\n  DSHX owns only the launcher, Codex TUI thin fork and presentation adapter.\n  DeepSeek Harness remains the authoritative Agent/Session/Tool runtime.\n  DSHX never reads or writes the user's ordinary CODEX_HOME.\n`;
}

function packagedTuiBinary() {
  const name = process.platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui';
  const candidates = [
    process.env.DSHX_TUI_BIN,
    path.join(ROOT, 'dist', 'bin', name),
    path.join(ROOT, '.build', 'codex', 'release', process.platform === 'win32' ? 'codex-tui.exe' : 'codex-tui')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function packagedIpcBridgeBinary() {
  const name = process.platform === 'win32' ? 'dshx-ipc-bridge.exe' : 'dshx-ipc-bridge';
  const candidates = [
    process.env.DSHX_IPC_BRIDGE_BIN,
    path.join(ROOT, 'dist', 'bin', name),
    path.join(ROOT, '.build', 'codex', 'release', name)
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function dshxTuiHome() {
  return path.resolve(process.env.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui'));
}

function doctor() {
  const executable = packagedTuiBinary();
  const tuiCheck = executable && fs.existsSync(executable)
    ? spawnSync(executable, ['--version'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '' };
  const bridge = packagedIpcBridgeBinary();
  const bridgeCheck = bridge && fs.existsSync(bridge)
    ? spawnSync(bridge, ['--check'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '' };

  let runtimeDetail;
  let runtimeOk = false;
  try {
    const entries = dshxRuntimeEntries();
    const required = ['llm', 'session', 'agent', 'permission', 'approval', 'user-questions', 'tools'];
    const ids = new Set(entries.filter((entry) => !entry.disabled).map((entry) => entry.id));
    const missing = required.filter((id) => !ids.has(id));
    if (missing.length > 0) throw new Error(`missing official bundle entries: ${missing.join(', ')}`);
    runtimeDetail = `official DSH bundle composition (${entries.length} entries)`;
    runtimeOk = true;
  } catch (error) {
    runtimeDetail = error instanceof Error ? error.message : String(error);
  }

  const rows = [
    ['Node', process.version, Number(process.versions.node.split('.')[0]) >= 20],
    [
      'Pinned Codex TUI',
      tuiCheck.status === 0
        ? (tuiCheck.stdout || tuiCheck.stderr).trim()
        : executable
          ? `${executable} is not built/runnable${tuiCheck.stderr ? `: ${tuiCheck.stderr.trim()}` : ''}`
          : 'not found',
      tuiCheck.status === 0
    ],
    [
      'Local IPC bridge',
      bridgeCheck.status === 0
        ? `${bridge} (cross-platform Codex UDS)`
        : bridge
          ? `${bridge} is not built/runnable${bridgeCheck.stderr ? `: ${bridgeCheck.stderr.trim()}` : ''}`
          : 'not found',
      bridgeCheck.status === 0
    ],
    ['DeepSeek Harness', runtimeDetail, runtimeOk],
    ['Presentation home', dshxTuiHome(), true]
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
    doctor();
    return;
  }

  const executable = packagedTuiBinary();
  if (!executable || !fs.existsSync(executable)) {
    process.stderr.write(`dshx: packaged TUI binary not found (${executable ?? 'unknown path'})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    process.exitCode = 127;
    return;
  }
  const bridge = packagedIpcBridgeBinary();
  if (!bridge || !fs.existsSync(bridge)) {
    process.stderr.write(`dshx: packaged local IPC bridge not found (${bridge ?? 'unknown path'})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    process.exitCode = 127;
    return;
  }

  const tuiHome = dshxTuiHome();
  try {
    fs.mkdirSync(tuiHome, { recursive: true, mode: 0o700 });
  } catch (error) {
    process.stderr.write(`dshx: cannot create presentation home ${tuiHome}: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  const debug = process.env.DSHX_DEBUG === '1';
  const log = debug ? (message) => process.stderr.write(`[dshx] ${message}\n`) : () => {};
  let local;
  try {
    local = await startDshxLocalServer({
      cwd: process.cwd(),
      home: tuiHome,
      version: VERSION,
      bridgeCommand: bridge,
      log
    });
  } catch (error) {
    process.stderr.write(`dshx: failed to boot DeepSeek Harness/local IPC: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(executable, invocation.tuiArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Do not inherit CODEX_HOME: DSHX uses Codex code as a presentation
      // component only and must not read/write the user's ordinary Codex state.
      CODEX_HOME: tuiHome,
      ...invocation.resumeEnv,
      DSHX_APP_SERVER_ENDPOINT: local.url
    },
    stdio: 'inherit',
    windowsHide: false
  });

  let closing = false;
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    try {
      await local.close();
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

  // SIGTERM is a process-lifecycle signal. Do not intercept SIGINT: Ctrl+C is
  // an in-TUI interaction used by Codex to interrupt the active DSH turn.
  process.once('SIGTERM', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
}

await run();
