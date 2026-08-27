#!/usr/bin/env node
// DSHX launcher: presentation-only bootstrap over the user's own official DSH
// installation. The pinned Codex TUI owns the terminal; it spawns DSH as a
// local stdio app-server child through DSHX_APP_SERVER_CMD.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseCliInvocation } from '../src/cli/arguments.mjs';
import { isSupportedNodeVersion } from '../src/cli/runtime.mjs';
import { ensureProfileInstalled, resolveDshInvocation } from '../src/dsh/profile-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const DEFAULT_PROFILE = 'tui';

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                     Start DSHX in the current project\n  dshx <prompt>            Start with an initial prompt\n  dshx resume              Open the DSH session picker\n  dshx resume --last       Resume the most recent DSH session\n  dshx resume <session>    Resume a specific DSH session\n  dshx doctor              Check the TUI and official DSH stdio composition\n  dshx --version           Print version\n  dshx --help              Show this help\n\nEnvironment:\n  DSHX_TUI_BIN             Override the packaged DSHX TUI binary (development only)\n  DSHX_TUI_HOME            Override DSHX presentation-only Codex home\n  DSHX_DSH_BIN             Override the official dsh JavaScript entrypoint\n  DSHX_PROFILE             Override the DSH profile (default: ${DEFAULT_PROFILE})\n  DSHX_DEBUG=1             Print DSHX adapter diagnostics\n\nPlugin usage:\n  The surface is a standard DSH profile bundle managed by the official CLI:\n    dsh plugin --profile ${DEFAULT_PROFILE} add ${PACKAGE.name}\n\nProduct boundary:\n  DSHX owns the launcher, a thin Codex TUI fork and a presentation adapter.\n  DeepSeek Harness remains authoritative for Agent/Session/Tool/Approval state.\n  No Harness runtime is bundled or booted by DSHX itself.\n`;
}

function commandDetail(command, result) {
  if (result.status === 0) return (result.stdout || result.stderr).trim();
  if (result.error) return `${command} failed: ${result.error.message}`;
  return `${command} is not runnable${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
}

function tuiBinary() {
  if (process.env.DSHX_TUI_BIN) return process.env.DSHX_TUI_BIN;
  const name = process.platform === 'win32' ? 'dshx-tui.exe' : 'dshx-tui';
  return path.join(ROOT, 'dist', 'bin', name);
}

function tuiHome() {
  return path.resolve(process.env.DSHX_TUI_HOME || path.join(os.homedir(), '.dshx', 'codex-tui'));
}

function selectedProfile() {
  const value = process.env.DSHX_PROFILE || DEFAULT_PROFILE;
  if (!value.trim()) throw new Error('DSH profile name must be non-empty');
  return value.trim();
}

export function bootstrapSurfaceProfile() {
  return ensureProfileInstalled({
    packageRoot: ROOT,
    name: PACKAGE.name,
    version: VERSION,
    profile: selectedProfile()
  });
}

function presentationHomeCheck() {
  const home = tuiHome();
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!fs.statSync(home).isDirectory()) throw new Error('path exists but is not a directory');
    fs.accessSync(home, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true, detail: home };
  } catch (error) {
    return { ok: false, detail: `${home}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Probe the real installed profile through the same stdio protocol used by the TUI. */
function backendActivationProbe(dsh, profile, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(dsh.command, [...dsh.args, '--profile', profile, '--dshx-app-server'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    let stderr = '';
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `no stdio activation within ${timeoutMs}ms`), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192); });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === 'dshx-doctor' && message?.result) {
        finish(true, `stdio surface active (${message.result.userAgent ?? 'DSH'})`);
      } else if (message?.id === 'dshx-doctor' && message?.error) {
        finish(false, message.error.message || 'initialize rejected');
      }
    });
    child.on('error', (error) => finish(false, error.message));
    child.on('exit', (code) => {
      if (!settled) finish(false, `official CLI exited before initialize (code ${code ?? '?'})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    });
    child.stdin.write(`${JSON.stringify({
      id: 'dshx-doctor',
      method: 'initialize',
      params: { clientInfo: { name: 'dshx-doctor', version: VERSION } }
    })}\n`);
  });
}

async function doctor() {
  const executable = tuiBinary();
  const tuiCheck = fs.existsSync(executable)
    ? spawnSync(executable, ['--version'], { encoding: 'utf8' })
    : { status: 127, stdout: '', stderr: '', error: null };
  const homeCheck = presentationHomeCheck();

  let profileDetail = '';
  let profileOk = true;
  let dsh;
  let profile;
  try {
    const ensured = bootstrapSurfaceProfile();
    profile = ensured.profile;
    profileDetail = `profile '${profile}' (${ensured.action})`;
    dsh = resolveDshInvocation(ROOT);
  } catch (error) {
    profileOk = false;
    profileDetail = error instanceof Error ? error.message : String(error);
  }

  let harness = { ok: false, detail: 'skipped: surface profile unavailable' };
  if (profileOk) harness = await backendActivationProbe(dsh, profile);

  const rows = [
    ['Node', `${process.version} (required: ${PACKAGE.engines.node})`, isSupportedNodeVersion(process.versions.node)],
    ['Pinned Codex TUI', tuiCheck.status === 0 ? commandDetail(executable, tuiCheck) : commandDetail(executable, tuiCheck), tuiCheck.status === 0],
    ['Surface profile', profileDetail, profileOk],
    ['DeepSeek Harness stdio surface', harness.detail, harness.ok],
    ['Presentation home', homeCheck.detail, homeCheck.ok]
  ];
  for (const [name, detail, ok] of rows) process.stdout.write(`${ok ? '✓' : '✗'} ${name}: ${detail}\n`);
  if (rows.some((row) => !row[2])) {
    process.stderr.write(
      process.platform === 'win32'
        ? 'For a source checkout, build the pinned TUI with `.\\scripts\\build-codex-tui.ps1`.\n'
        : 'For a source checkout, build the pinned TUI with `./scripts/build-codex-tui.sh`.\n'
    );
    process.exitCode = 1;
  }
}

async function run() {
  let invocation;
  try {
    invocation = parseCliInvocation(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dshx: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (invocation.kind === 'help') return void process.stdout.write(usage());
  if (invocation.kind === 'version') return void process.stdout.write(`${VERSION}\n`);
  if (invocation.kind === 'doctor') return void await doctor();

  if (!isSupportedNodeVersion(process.versions.node)) {
    process.stderr.write(`dshx: unsupported Node ${process.version}; required ${PACKAGE.engines.node}\n`);
    process.exitCode = 1;
    return;
  }

  const executable = tuiBinary();
  if (!fs.existsSync(executable)) {
    process.stderr.write(`dshx: packaged TUI binary not found (${executable}); run \`dshx doctor\`\n`);
    process.exitCode = 127;
    return;
  }

  let profile;
  try {
    profile = bootstrapSurfaceProfile().profile;
  } catch (error) {
    process.stderr.write(`dshx: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }

  const dsh = resolveDshInvocation(ROOT);
  const backendCommand = [dsh.command, ...dsh.args, '--profile', profile, '--dshx-app-server'];
  const child = spawn(executable, invocation.tuiArgs ?? [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: tuiHome(),
      DSHX_APP_SERVER_CMD: JSON.stringify(backendCommand),
      ...(invocation.resumeEnv ?? {})
    },
    stdio: 'inherit',
    windowsHide: false
  });
  child.on('error', (error) => {
    process.stderr.write(`dshx: failed to start pinned TUI: ${error.message}\n`);
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    if (signal && process.env.DSHX_DEBUG === '1') process.stderr.write(`[dshx] TUI exited via ${signal}\n`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

await run();
