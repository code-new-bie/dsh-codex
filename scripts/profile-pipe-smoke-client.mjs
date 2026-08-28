#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const inputFd = Number(process.env.DSHX_APP_SERVER_INPUT_FD ?? '0');
const outputFd = Number(process.env.DSHX_APP_SERVER_OUTPUT_FD ?? '4');
if (!Number.isInteger(inputFd) || inputFd < 0 || !Number.isInteger(outputFd) || outputFd < 0) {
  throw new Error('DSHX profile-pipe smoke requires valid protocol input/output fds');
}

const input = fs.createReadStream(null, { fd: inputFd, autoClose: false });
const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
let settled = false;
const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  process.stderr.write('[fd-smoke] initialize timed out\n');
  process.exitCode = 1;
  lines.close();
}, Number(process.env.DSHX_FD_SMOKE_TIMEOUT_MS ?? 30_000));

function send(message) {
  fs.writeSync(outputFd, `${JSON.stringify(message)}\n`);
}

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id !== 'profile-pipe-smoke' || settled) return;
  settled = true;
  clearTimeout(timeout);
  if (message.error) {
    process.stderr.write(`[fd-smoke] initialize rejected: ${message.error.message ?? JSON.stringify(message.error)}\n`);
    process.exitCode = 1;
    lines.close();
    return;
  }
  send({ method: 'initialized', params: {} });
  process.stdout.write(`DSHX_PROFILE_PIPE_SMOKE ${JSON.stringify({ userAgent: message.result?.userAgent ?? null })}\n`);
  // `initialize` proves the Loader tree is already settled. Give rc.8's
  // launcher-owned post-boot watcher setup one bounded turn before child exit,
  // matching the steady-state lifecycle exercised by the real native TUI.
  setTimeout(() => {
    lines.close();
    process.exitCode = 0;
  }, Number(process.env.DSHX_FD_SETTLE_MS ?? 300));
});

send({
  id: 'profile-pipe-smoke',
  method: 'initialize',
  params: { clientInfo: { name: 'dshx-profile-pipe-smoke', version: '1' } }
});
