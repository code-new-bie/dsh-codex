import { readFileSync, readdirSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function requireText(path, needle) {
  const text = read(path);
  if (!text.includes(needle)) {
    throw new Error(`${path} is missing required invariant: ${needle}`);
  }
}

function forbidText(path, pattern, label = String(pattern)) {
  const text = read(path);
  const hit = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (hit) {
    throw new Error(`${path} violates ownership invariant: ${label}`);
  }
}

requireText('docs/ARCHITECTURE.md', 'must not grow into an agent framework');
requireText('docs/TEAM.md', 'DeepSeek Harness remains an upstream dependency');

// Runtime composition must stay on the official DSH app-boot/profile plane.
// Do not key this guard to historical bundle row ids such as `dsh-base`:
// those are upstream implementation details, not the ownership boundary.
requireText('src/dsh/runtime-boot.mjs', "from '@deepseek-ai/dsh-app-boot'");
requireText('src/dsh/runtime-boot.mjs', "const DEFAULT_PROFILE = 'tui'");
requireText('src/dsh/runtime-boot.mjs', 'loadProfile(');
requireText('src/dsh/runtime-boot.mjs', 'composeEntries(');
requireText('src/dsh/runtime-boot.mjs', 'ctx = await boot(');
requireText('src/dsh/runtime-boot.mjs', 'profile.layers.flatMap((layer) => layer.patches)');
requireText('src/dsh/runtime-boot.mjs', 'profile.patches');
requireText('src/dsh/runtime-boot.mjs', 'homePatches');
// The surface is a real bundle: the manifest declares dsh.bundle.patch and the
// shipped patch carries the surface rows plus the competing-runner locks.
requireText('cordis.patch.yml', 'id: headless-startup');
requireText('cordis.patch.yml', 'id: headless-runner');
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/startup'");
requireText('cordis.patch.yml', "name: '@code-new-bie/dshx-tui/presentation'");
{
  const manifest = JSON.parse(read('package.json'));
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('package.json must declare dsh.bundle.patch -> ./cordis.patch.yml for loader activation');
  }
  if (!manifest.exports['./presentation'] || !manifest.exports['./startup']) {
    throw new Error('package.json exports must expose the surface row modules');
  }
  // Single-instance rule: shadowing healed installation symlinks with profile
  // copies of dsh runtime packages would split every service registry in two.
  const runtimePeers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/dsh'));
  if (runtimePeers.length === 0) throw new Error('dsh runtime packages must stay declared as peerDependencies');
  for (const name of runtimePeers) {
    if (manifest.dependencies?.[name] !== undefined) {
      throw new Error(`${name} must not be a real dependency; it would shadow the healed fallback symlinks`);
    }
  }
}
// The presentation lifetime mounts as a Cordis-contract plugin row.
requireText('src/dsh/presentation-plugin.mjs', 'export const name');
requireText('src/dsh/presentation-plugin.mjs', 'ctx.provide(SERVICE_KEY');
requireText('src/dsh/presentation-plugin.mjs', "inject = ['dshxStartup']");
requireText('src/dsh/startup-plugin.mjs', "provide('dshxStartup'");
// The launcher only bootstraps via the official plugin command, never mounts
// rows itself; the shared bootstrap module owns the command assembly and
// resolves the dsh CLI without requiring a global installation.
requireText('src/dsh/profile-bootstrap.mjs', "'plugin', '--profile'");
requireText('src/dsh/profile-bootstrap.mjs', 'resolveDshInvocation');
forbidText('src/dsh/runtime-boot.mjs', 'bootDshxPresentationRuntime');
// Presentation lifetime may adapt the Context shape, but teardown must remain
// delegated to Cordis/DSH root-fiber ownership rather than a DSHX runtime.
requireText('src/dsh/runtime-boot.mjs', 'ctx.fiber.dispose()');
requireText('src/dsh/runtime-boot.mjs', 'attachPresentationLifetime(ctx)');
// The declared supported DSH line is ecosystem-honest metadata: warn once at
// boot, never block the host (official bundles carry peer ranges, no gates).
requireText('src/dsh/runtime-boot.mjs', 'reportDshLineCompatibility');
requireText('src/dsh/runtime-boot.mjs', 'proceeding');

for (const path of ['src/dsh/user-shell.mjs', 'src/dsh/workspace-command.mjs']) {
  forbidText(path, /execFile|execSync|spawn\(/, 'local process execution');
  requireText(path, 'tools.execute');
}
requireText('src/dsh/user-shell.mjs', 'agent: controller.agent');
requireText('src/dsh/workspace-command.mjs', 'agent');
requireText('src/tui-protocol/adapter.mjs', "case 'command/exec'");

requireText('src/dsh/host-api.mjs', '@deepseek-ai/dsh-host-apiproxy');
requireText('src/dsh/host-api.mjs', 'api.sessions.fork');
requireText('src/tui-protocol/adapter.mjs', 'executeDshCommand');
requireText('src/dsh/commands.mjs', 'commands.execute');
forbidText('src/tui-protocol/adapter.mjs', 'compactNow');
forbidText('src/dsh/agent-driver.mjs', /seedLength|parentSession|dshForkSeed/, 'shadow fork/session seed state');
// The unified adapter may read DSH's durable `parentSession` header field to
// delegate subagent interruption back to ctx.subagents, but it must never
// keep shadow fork/session seed state of its own.
forbidText('src/tui-protocol/adapter.mjs', /seedLength|dshForkSeed/, 'shadow fork/session seed state');
requireText('src/tui-protocol/adapter.mjs', 'subagents.interrupt');
forbidText('src/dsh/agent-driver.mjs', 'fork(sourceAgent');

forbidText('src/dsh/local-server.mjs', 'WebSocketServer', 'production TCP WebSocket server');
requireText('src/dsh/local-server.mjs', 'unix://');
requireText('scripts/build-codex-tui.sh', 'dshx-ipc-bridge');

// The Codex dialect lives only in the protocol namespace; domain modules in
// src/dsh stay DSH-vocabulary (gradual cleanup tracked for residual field
// mappings, enforced structurally by these two placement checks).
try { readFileSync('src/tui-protocol/shapes.mjs'); readFileSync('src/tui-protocol/adapter.mjs'); } catch {
  throw new Error('Codex protocol dictionary must live under src/tui-protocol/');
}
for (const entry of readdirSync('src/dsh')) {
  if (/codex/i.test(entry)) throw new Error(`src/dsh must not carry codex-named modules; found ${entry}`);
}

console.log('DSHX ownership boundary verified');
