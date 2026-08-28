#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const inputFd = Number(process.env.DSHX_APP_SERVER_INPUT_FD ?? '0');
const outputFd = Number(process.env.DSHX_APP_SERVER_OUTPUT_FD ?? '4');
if (!Number.isInteger(inputFd) || inputFd < 0 || !Number.isInteger(outputFd) || outputFd < 0) {
  throw new Error('DSHX profile-pipe smoke requires valid protocol input/output fds');
}

// `child_process.spawn(..., { stdio: ['pipe', ...] })` gives fd 0 to the
// child as a libuv-managed nonblocking pipe on Unix. `fs.createReadStream()`
// performs ordinary fs reads and can surface EAGAIN immediately; process.stdin
// is the supported stream wrapper for this descriptor and waits correctly.
const input = inputFd === 0
  ? process.stdin
  : fs.createReadStream(null, { fd: inputFd, autoClose: false });
input.setEncoding('utf8');
const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
let settled = false;
const timeout = setTimeout(() => finish(1, 'initialize timed out'), Number(process.env.DSHX_FD_SMOKE_TIMEOUT_MS ?? 30_000));

function finish(code, detail) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (detail) process.stderr.write(`[fd-smoke] ${detail}\n`);
  try { lines.close(); } catch {}
  process.exitCode = code;
}

function send(message) {
  fs.writeSync(outputFd, `${JSON.stringify(message)}\n`, null, 'utf8');
}

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id !== 'profile-pipe-smoke' || settled) return;
  if (message.error) {
    finish(1, `initialize rejected: ${message.error.message ?? JSON.stringify(message.error)}`);
    return;
  }
  send({ method: 'initialized', params: {} });
  process.stdout.write(`DSHX_PROFILE_PIPE_SMOKE ${JSON.stringify({ userAgent: message.result?.userAgent ?? null })}\n`);
  // `initialize` proves the Loader tree is already settled. Give rc.8's
  // launcher-owned post-boot watcher setup one bounded turn before child exit,
  // matching the steady-state lifecycle exercised by the real native TUI.
  settled = true;
  clearTimeout(timeout);
  setTimeout(() => {
    try { lines.close(); } catch {}
    process.exitCode = 0;
  }, Number(process.env.DSHX_FD_SETTLE_MS ?? 300));
});

lines.on('error', (error) => finish(1, `protocol readline failed: ${error.message}`));
input.on?.('error', (error) => finish(1, `protocol input failed: ${error.message}`));

send({
  id: 'profile-pipe-smoke',
  method: 'initialize',
  params: { clientInfo: { name: 'dshx-profile-pipe-smoke', version: '1' } }
});
