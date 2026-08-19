#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DshxReleaseAdapter } from '../src/dsh/release-adapter.mjs';
import { bootDshxRuntime } from '../src/dsh/runtime-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const debug = process.env.DSHX_DEBUG === '1';
const diagnostics = debug
  ? (message) => process.stderr.write(`[dshx-app-server] ${message}\n`)
  : () => {};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseError(error) {
  return {
    id: null,
    error: {
      code: -32700,
      message: `Parse error: ${error instanceof Error ? error.message : String(error)}`
    }
  };
}

let ctx;
let adapter;
try {
  ctx = await bootDshxRuntime({ cwd: process.cwd() });
  adapter = new DshxReleaseAdapter({
    ctx,
    cwd: process.cwd(),
    version: VERSION,
    send,
    diagnostics
  });

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(parseError(error));
      continue;
    }

    try {
      const handled = await adapter.handle(message);
      if (!handled) continue;
      if (handled.response !== undefined) send(handled.response);
      await handled.afterResponse?.();
    } catch (error) {
      diagnostics(`request handling failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (message?.id !== undefined) {
        send({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }
} catch (error) {
  process.stderr.write(`dshx app-server: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try {
    await adapter?.close?.();
  } catch (error) {
    diagnostics(`adapter close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await ctx?.dispose?.();
  } catch (error) {
    diagnostics(`runtime dispose failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
