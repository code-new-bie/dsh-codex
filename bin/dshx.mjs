#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { startProtocolStubServer } from '../src/server.mjs';

const VERSION = '0.0.0-m0';

function usage() {
  return `DSHX ${VERSION}\n\nUsage:\n  dshx                 Start the Codex TUI against the M0 compatibility stub\n  dshx doctor          Check development prerequisites\n  dshx --version       Print version\n  dshx --help          Show this help\n\nEnvironment:\n  DSHX_CODEX_BIN       Codex executable to launch (default: codex)\n  DSHX_DEBUG=1         Print protocol-stub request logs\n\nM0 note:\n  This branch intentionally uses Codex --remote only as a protocol proof.\n  Production DSHX will ship its pinned thin-fork TUI and will not depend on\n  the experimental WebSocket transport.\n`;
}

function codexBinary() {
  return process.env.DSHX_CODEX_BIN || 'codex';
}

function doctor() {
  const executable = codexBinary();
  const check = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  const rows = [
    ['Node', process.version, true],
    [
      'Codex',
      check.status === 0 ? (check.stdout || check.stderr).trim() : `${executable} not runnable`,
      check.status === 0
    ]
  ];
  for (const [name, detail, ok] of rows) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}: ${detail}\n`);
  }
  if (rows.some((row) => !row[2])) process.exitCode = 1;
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
  if (args.length > 0) {
    process.stderr.write(`dshx: unsupported M0 argument: ${args.join(' ')}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  const debug = process.env.DSHX_DEBUG === '1';
  const stub = await startProtocolStubServer({
    cwd: process.cwd(),
    log: debug ? (message) => process.stderr.write(`[dshx] ${message}\n`) : () => {}
  });

  const executable = codexBinary();
  const child = spawn(executable, ['--remote', stub.url], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });

  let closing = false;
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    try {
      await stub.close();
    } catch {
      // Best effort: process exit will release the local listener.
    }
    process.exitCode = exitCode;
  };

  child.on('error', async (error) => {
    process.stderr.write(`dshx: failed to launch ${executable}: ${error.message}\n`);
    process.stderr.write('Run `dshx doctor` and install the pinned Codex development prerequisite.\n');
    await close(127);
  });
  child.on('exit', async (code, signal) => {
    if (signal && debug) process.stderr.write(`[dshx] Codex exited via ${signal}\n`);
    await close(code ?? 1);
  });
}

await run();
