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

// Standard DSH bundle ownership: this layer inserts only its own surface rows.
requireText('cordis.patch.yml', 'id: dshx-startup');
requireText('cordis.patch.yml', 'id: dshx-presentation');
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/startup'");
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/presentation'");
requireText('cordis.patch.yml', 'inject: [dshxStartup]');
forbidText('cordis.patch.yml', 'headless-startup', 'depending on another surface startup row');
forbidText('cordis.patch.yml', 'headless-runner', 'depending on another surface runner');

const manifest = JSON.parse(read('package.json'));
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('package.json must declare dsh.bundle.patch -> ./cordis.patch.yml');
}
if (!manifest.exports?.['./presentation'] || !manifest.exports?.['./startup']) {
  throw new Error('package exports must expose the two Cordis surface rows');
}

// Every DSH package belongs to the user's official installation. DSHX may
// depend on non-DSH leaf helpers, but it must never install a second Harness
// package into the profile. Service definitions are optional advisory host
// peers and resolve through DSH's installation-owned profile fallback.
const runtimePeers = Object.keys(manifest.peerDependencies ?? {}).filter(
  (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
);
if (runtimePeers.length === 0) throw new Error('DSH runtime packages must be peerDependencies');
for (const name of Object.keys(manifest.dependencies ?? {})) {
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
    throw new Error(`${name} must not be a production dependency (single-runtime rule)`);
  }
}
for (const name of runtimePeers) {
  if (manifest.peerDependencies[name] !== '>=0.1.0-rc.8') {
    throw new Error(`${name} must use the host compatibility floor >=0.1.0-rc.8`);
  }
  if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
    throw new Error(`${name} must be an optional advisory peer so npm cannot auto-install a second Harness runtime`);
  }
}

// There is exactly one runtime owner: the user's official dsh launcher/profile.
for (const retired of ['src/dsh/runtime-boot.mjs', 'src/dsh/local-server.mjs']) {
  if (existsSync(retired)) throw new Error(`${retired} must stay deleted; DSHX cannot own a runtime/socket host`);
}
requireText('src/dsh/profile-bootstrap.mjs', "'plugin', '--profile'");
requireText('src/dsh/profile-bootstrap.mjs', 'resolveDshInvocation');
requireText('bin/dshx.mjs', "'--profile', profile, ...argv");
requireText('bin/dshx.mjs', "stdio: 'inherit'");
requireText('bin/dshx.mjs', 'shell: false');
forbidText('bin/dshx.mjs', /(?:from\s+|import\s+\(\s*|require\()\s*["']@deepseek-ai\//, 'importing Harness runtime builds');
for (const retired of ['DSHX_APP_SERVER_CMD', '--dshx-app-server', 'DSHX_APP_SERVER_ENDPOINT', 'DSHX_IPC_BRIDGE_BIN']) {
  forbidText('bin/dshx.mjs', retired, `retired nested-backend launch seam ${retired}`);
}

// Surface rows follow the official startup-provider -> presentation-runner pattern.
requireText('src/dsh/startup-plugin.mjs', "inject = ['cmdlineArgs']");
requireText('src/dsh/startup-plugin.mjs', "provide('dshxStartup'");
requireText('src/dsh/startup-plugin.mjs', 'tuiArgs:');
forbidText('src/dsh/startup-plugin.mjs', '--dshx-app-server', 'private backend sentinel');

requireText('src/dsh/presentation-plugin.mjs', "inject = ['dshxStartup']");
requireText('src/dsh/presentation-plugin.mjs', 'internals.spawnTui');
requireText('src/dsh/presentation-plugin.mjs', "stdio: ['inherit', 'inherit', 'inherit', 'pipe']");
requireText('src/dsh/presentation-plugin.mjs', 'DSHX_APP_SERVER_FD');
requireText('src/dsh/presentation-plugin.mjs', 'startDshxStdioTransport');
requireText('src/dsh/presentation-plugin.mjs', 'ctx.provide(SERVICE_KEY');
requireText('src/dsh/presentation-plugin.mjs', 'requestHostExit(ctx');
forbidText('src/dsh/presentation-plugin.mjs', 'runtime-boot');
forbidText('src/dsh/presentation-plugin.mjs', 'resolveDshInvocation', 'presentation runner starting another DSH');

requireText('src/dsh/stdio-transport.mjs', 'already-mounted DSH Context');
forbidText('src/dsh/stdio-transport.mjs', /WebSocket|unix:\/\//, 'network/socket framing');

// The final thin-fork layer consumes only the inherited profile pipe. Earlier
// migration patches may mention StdioChild/DSHX_APP_SERVER_CMD as removed text;
// 0012 must replace that intermediate topology in the materialized result.
const inheritedPatch = 'upstream/patches/codex/0012-dshx-inherited-profile-pipe.patch';
requireText(inheritedPatch, 'InheritedPipe');
requireText(inheritedPatch, 'DSHX_APP_SERVER_FD');
requireText(inheritedPatch, '-use tokio::process::Command;');
requireText(inheritedPatch, '-        let mut command = Command::new(executable);');
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
