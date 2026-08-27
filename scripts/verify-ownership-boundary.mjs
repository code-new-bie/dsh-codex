import { existsSync, readFileSync, readdirSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function requireText(path, needle) {
  if (!read(path).includes(needle)) throw new Error(`${path} is missing required invariant: ${needle}`);
}
function forbidText(path, pattern, label = String(pattern)) {
  const text = read(path);
  const hit = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (hit) throw new Error(`${path} violates ownership invariant: ${label}`);
}

// Bundle/profile ownership: activation is declared, never mounted by DSHX.
requireText('cordis.patch.yml', 'id: headless-startup');
requireText('cordis.patch.yml', 'id: headless-runner');
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/startup'");
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/presentation'");
const manifest = JSON.parse(read('package.json'));
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('package.json must declare dsh.bundle.patch -> ./cordis.patch.yml');
}
if (!manifest.exports?.['./presentation'] || !manifest.exports?.['./startup']) {
  throw new Error('package exports must expose the two Cordis surface rows');
}

// Stateful DSH runtime packages are host peers; only leaf helper libraries may
// be real dependencies in the profile package.
const runtimePeers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/dsh'));
if (runtimePeers.length === 0) throw new Error('DSH runtime packages must be peerDependencies');
for (const name of runtimePeers) {
  if (manifest.dependencies?.[name] !== undefined) {
    throw new Error(`${name} must not be a production dependency (single-instance rule)`);
  }
}

// There is exactly one runtime owner: the official dsh launcher/profile.
for (const retired of ['src/dsh/runtime-boot.mjs', 'src/dsh/local-server.mjs']) {
  if (existsSync(retired)) throw new Error(`${retired} must stay deleted; DSHX cannot own a runtime/socket host`);
}
requireText('src/dsh/profile-bootstrap.mjs', "'plugin', '--profile'");
requireText('src/dsh/profile-bootstrap.mjs', 'resolveDshInvocation');
requireText('bin/dshx.mjs', 'DSHX_APP_SERVER_CMD');
requireText('bin/dshx.mjs', "'--dshx-app-server'");
forbidText('bin/dshx.mjs', /(?:from\s+|import\s+\(\s*|require\()\s*["']@deepseek-ai\//, 'importing Harness runtime builds');
forbidText('bin/dshx.mjs', 'DSHX_APP_SERVER_ENDPOINT', 'socket endpoint launch path');
forbidText('bin/dshx.mjs', 'DSHX_IPC_BRIDGE_BIN', 'bridge launch path');

// Cordis rows consume launcher facts and bind only NDJSON stdio to the live ctx.
requireText('src/dsh/startup-plugin.mjs', "inject = ['cmdlineArgs']");
requireText('src/dsh/startup-plugin.mjs', '--dshx-app-server');
requireText('src/dsh/startup-plugin.mjs', "provide('dshxStartup'");
requireText('src/dsh/presentation-plugin.mjs', 'startDshxStdioTransport');
requireText('src/dsh/presentation-plugin.mjs', 'ctx.provide(SERVICE_KEY');
requireText('src/dsh/presentation-plugin.mjs', "inject = ['dshxStartup']");
forbidText('src/dsh/presentation-plugin.mjs', 'spawn(');
forbidText('src/dsh/presentation-plugin.mjs', 'runtime-boot');
requireText('src/dsh/stdio-transport.mjs', 'already-mounted DSH Context');
forbidText('src/dsh/stdio-transport.mjs', /WebSocket|unix:\/\//, 'network/socket framing');

// The thin fork must spawn a local stdio backend and must not materialize the
// historical Rust UDS bridge.
requireText('upstream/patches/codex/0001-dshx-force-ui-backend.patch', 'DSHX_APP_SERVER_CMD');
requireText('upstream/patches/codex/0010-dshx-stdio-backend.patch', 'StdioAppServerClient');
for (const file of readdirSync('upstream/patches/codex')) {
  if (!file.endsWith('.patch')) continue;
  forbidText(`upstream/patches/codex/${file}`, 'dshx-ipc-bridge', 'legacy Rust bridge');
}
forbidText('scripts/build-codex-tui.sh', 'dshx-ipc-bridge');
forbidText('scripts/build-codex-tui.ps1', 'dshx-ipc-bridge');

// Domain capabilities delegate to DSH public services rather than local OS or
// shadow runtime state.
for (const path of ['src/dsh/user-shell.mjs', 'src/dsh/workspace-command.mjs']) {
  forbidText(path, /execFile|execSync|spawn\(/, 'local process execution');
  requireText(path, 'tools.execute');
}
requireText('src/dsh/user-shell.mjs', 'agent: controller.agent');
requireText('src/dsh/workspace-command.mjs', 'agent');
requireText('src/dsh/host-api.mjs', '@deepseek-ai/dsh-host-apiproxy');
requireText('src/dsh/host-api.mjs', 'api.sessions.fork');
requireText('src/tui-protocol/adapter.mjs', "case 'command/exec'");
requireText('src/tui-protocol/adapter.mjs', 'executeDshCommand');
requireText('src/dsh/commands.mjs', 'commands.execute');
forbidText('src/tui-protocol/adapter.mjs', 'compactNow');
forbidText('src/dsh/agent-driver.mjs', /seedLength|parentSession|dshForkSeed/, 'shadow fork/session seed state');
forbidText('src/tui-protocol/adapter.mjs', /seedLength|dshForkSeed/, 'shadow fork/session seed state');
requireText('src/tui-protocol/adapter.mjs', 'subagents.interrupt');
forbidText('src/dsh/agent-driver.mjs', 'fork(sourceAgent');

// Codex is only a presentation dialect.
for (const required of ['src/tui-protocol/shapes.mjs', 'src/tui-protocol/adapter.mjs']) {
  if (!existsSync(required)) throw new Error(`missing protocol projection module: ${required}`);
}
for (const entry of readdirSync('src/dsh')) {
  if (/codex/i.test(entry)) throw new Error(`src/dsh must not carry codex-named modules; found ${entry}`);
}

console.log('DSHX ownership boundary verified');
