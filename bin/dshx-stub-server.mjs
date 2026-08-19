#!/usr/bin/env node
import { startProtocolStubServer } from '../src/server.mjs';

const server = await startProtocolStubServer({
  log: (message) => process.stderr.write(`[dshx-stub] ${message}\n`)
});

process.stdout.write(`${server.url}\n`);

async function shutdown() {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
