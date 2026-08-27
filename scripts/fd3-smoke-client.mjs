#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const FD = Number(process.env.DSHX_APP_SERVER_FD ?? '3');
const TIMEOUT_MS = Number(process.env.DSHX_FD3_TIMEOUT_MS ?? 30_000);
const SETTLE_MS = Number(process.env.DSHX_FD3_SETTLE_MS ?? 300);

if (!Number.isInteger(FD) || FD < 3) {
  process.stderr.write(`[fd3-smoke] invalid DSHX_APP_SERVER_FD=${JSON.stringify(process.env.DSHX_APP_SERVER_FD)}\n`);
  process.exit(2);
}

const input = fs.createReadStream(null, { fd: FD, autoClose: false, encoding: 'utf8' });
const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
let settled = false;
const timer = setTimeout(() => finish(3, 'timed out waiting for initialize'), TIMEOUT_MS);

function write(message) {
  fs.writeSync(FD, `${JSON.stringify(message)}\n`, null, 'utf8');
}

function finish(code, detail) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { lines.close(); } catch {}
  if (detail) process.stderr.write(`[fd3-smoke] ${detail}\n`);
  setTimeout(() => process.exit(code), code === 0 ? SETTLE_MS : 0);
}

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id !== 'fd3-smoke') return;
  if (message.error) {
    finish(4, `initialize rejected: ${message.error.message || JSON.stringify(message.error)}`);
    return;
  }
  write({ method: 'initialized', params: {} });
  process.stdout.write(`DSHX_FD3_SMOKE ${JSON.stringify({ userAgent: message.result?.userAgent ?? null })}\n`);
  finish(0);
});

input.on('error', (error) => finish(5, `protocol read failed: ${error.message}`));

write({
  id: 'fd3-smoke',
  method: 'initialize',
  params: { clientInfo: { name: 'dshx-fd3-smoke', version: '1' } }
});
