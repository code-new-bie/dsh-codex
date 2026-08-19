#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDshxLocalServer } from '../src/dsh/local-server.mjs';

const VERSION = '0.1.0-dev';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                     Start DSHX in the current project\n  dshx <prompt>            Start with an initial prompt\n  dshx resume              Open the Codex-style DSH session picker\n  dshx resume --last       Resume the most recent DSH session\n  dshx resume <session>    Resume a specific DSH session\n  dshx doctor              Check runtime/TUI prerequisites\n  dshx --version           Print version\n  dshx --help              Show this help\n\nEnvironment:\n  DSHX_TUI_BIN             Override the packaged DSHX TUI binary (development only)\n  DSHX_DEBUG=1             Print DSHX adapter diagnostics\n\nProduct boundary:\n  DSHX owns only the launcher, Codex TUI thin fork and presentation adapter.\n  DeepSeek Harness remains the authoritative Agent/Session/Tool runtime.\n`;
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

function parseLaunchArgs(args) {
  if (args[0] !== 'resume') return { tuiArgs: args, resumeEnv: {} };
  const rest = args.slice(1);
  if (rest.length === 0) return { tuiArgs: [], resumeEnv: { DSHX_RESUME_MODE: 'picker' } };
  if (rest.length === 1 && rest[0] === '--last') {
    return { tuiArgs: [], resumeEnv: { DSHX_RESUME_MODE: 'last' } };
  }
  if (rest.length === 1 && !rest[0].startsWith('-')) {
    return {
      tuiArgs: [],
      resumeEnv: { DSHX_RESUME_MODE: 'id', DSHX_RESUME_SESSION_ID: rest[0] }
    };
  }
  throw new Error('Usage: dshx resume [--last|<session>]');
}

function doctor() {
  const executable = packagedTuiBinary();
  const tuiCheck = executable && fs.existsSync(executable)
    ? spawnSync(executable, ['--version'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '' };
  const rows = [
    ['Node', process.version, Number(process.versions.node.split('.')[0]) >= 20],
    [
      'Pinned Codex TUI',
      tuiCheck.status === 0
        ? (tuiCheck.stdout || tuiCheck.stderr).trim()
        : executable
          ? `${executable} is not built/runnable`
          : 'not found',
      tuiCheck.status === 0
    ]
  ];
  for (const [name, detail, ok] of rows) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}: ${detail}\n`);
  }
  if (rows.some((row) => !row[2])) {
    process.stderr.write(
      process.platform === 'win32'
        ? 'Build the pinned TUI with `.\\scripts\\build-codex-tui.ps1`.\n'
        : 'Build the pinned TUI with `./scripts/build-codex-tui.sh`.\n'
    );
    process.exitCode = 1;
  }
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === 'doctor') {
    doctor();
    return;
  }

  let launch;
  try {
    launch = parseLaunchArgs(args);
  } catch (error) {
    process.stderr.write(`dshx: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const executable = packagedTuiBinary();
  if (!executable || !fs.existsSync(executable)) {
    process.stderr.write(`dshx: packaged TUI binary not found (${executable ?? 'unknown path'})\n`);
    process.stderr.write('Run `dshx doctor` for build/install guidance.\n');
    process.exitCode = 127;
    return;
  }

  const debug = process.env.DSHX_DEBUG === '1';
  const log = debug ? (message) => process.stderr.write(`[dshx] ${message}\n`) : () => {};
  let local;
  try {
    local = await startDshxLocalServer({ cwd: process.cwd(), version: VERSION, log });
  } catch (error) {
    process.stderr.write(`dshx: failed to boot DeepSeek Harness: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(executable, launch.tuiArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...launch.resumeEnv,
      DSHX_APP_SERVER_ENDPOINT: local.url,
      DSHX_APP_SERVER_TOKEN: local.token
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
      if (debug) process.stderr.write(`[dshx] shutdown: ${error instanceof Error ? error.message : error}\n`);
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
