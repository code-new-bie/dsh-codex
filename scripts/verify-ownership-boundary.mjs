import { readFileSync } from 'node:fs';

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
requireText('src/dsh/runtime-boot.mjs', "const DEFAULT_PROFILE = 'headless'");
requireText('src/dsh/runtime-boot.mjs', 'loadProfile(');
requireText('src/dsh/runtime-boot.mjs', 'composeEntries(');
requireText('src/dsh/runtime-boot.mjs', 'ctx = await boot(');
requireText('src/dsh/runtime-boot.mjs', 'profile.layers.flatMap((layer) => layer.patches)');
requireText('src/dsh/runtime-boot.mjs', 'profile.patches');
requireText('src/dsh/runtime-boot.mjs', 'homePatches');
// The surface lock lives in a declarative bundle patch loaded through DSH's
// own optional-patch loader; a missing lock set must fail closed.
requireText('cordis.patch.yml', 'id: headless-startup');
requireText('cordis.patch.yml', 'id: headless-runner');
requireText('src/dsh/runtime-boot.mjs', 'loadOptionalPatches(');
requireText('src/dsh/runtime-boot.mjs', 'refusing to boot with competing presentation surfaces');
// The presentation lifetime mounts as a Cordis-contract plugin row.
requireText('src/dsh/presentation-plugin.mjs', 'export const name');
requireText('src/dsh/presentation-plugin.mjs', 'ctx.provide(SERVICE_KEY');
requireText('src/dsh/runtime-boot.mjs', 'bootDshxPresentationRuntime');
// Presentation lifetime may adapt the Context shape, but teardown must remain
// delegated to Cordis/DSH root-fiber ownership rather than a DSHX runtime.
requireText('src/dsh/runtime-boot.mjs', 'ctx.fiber.dispose()');
requireText('src/dsh/runtime-boot.mjs', 'attachPresentationLifetime(ctx)');

for (const path of ['src/dsh/user-shell.mjs', 'src/dsh/workspace-command.mjs']) {
  forbidText(path, /execFile|execSync|spawn\(/, 'local process execution');
  requireText(path, 'tools.execute');
}
requireText('src/dsh/user-shell.mjs', 'agent: controller.agent');
requireText('src/dsh/workspace-command.mjs', 'agent');
requireText('src/dsh/presentation-adapter.mjs', "case 'command/exec'");

requireText('src/dsh/host-api.mjs', '@deepseek-ai/dsh-host-apiproxy');
requireText('src/dsh/host-api.mjs', 'api.sessions.fork');
requireText('src/dsh/presentation-adapter.mjs', 'executeDshCommand');
requireText('src/dsh/commands.mjs', 'commands.execute');
forbidText('src/dsh/presentation-adapter.mjs', 'compactNow');
forbidText('src/dsh/agent-driver.mjs', /seedLength|parentSession|dshForkSeed/, 'shadow fork/session seed state');
// The unified adapter may read DSH's durable `parentSession` header field to
// delegate subagent interruption back to ctx.subagents, but it must never
// keep shadow fork/session seed state of its own.
forbidText('src/dsh/presentation-adapter.mjs', /seedLength|dshForkSeed/, 'shadow fork/session seed state');
requireText('src/dsh/presentation-adapter.mjs', 'subagents.interrupt');
forbidText('src/dsh/agent-driver.mjs', 'fork(sourceAgent');

forbidText('src/dsh/local-server.mjs', 'WebSocketServer', 'production TCP WebSocket server');
requireText('src/dsh/local-server.mjs', 'unix://');
requireText('scripts/build-codex-tui.sh', 'dshx-ipc-bridge');

console.log('DSHX ownership boundary verified');
