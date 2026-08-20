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
requireText('src/dsh/runtime-boot.mjs', "{ id: 'headless-startup', disabled: true }");
requireText('src/dsh/runtime-boot.mjs', "{ id: 'headless-runner', disabled: true }");
requireText('src/dsh/runtime-boot.mjs', 'const ctx = await boot(');
requireText('src/dsh/runtime-boot.mjs', 'profile.layers.flatMap((layer) => layer.patches)');
requireText('src/dsh/runtime-boot.mjs', 'profile.patches');
requireText('src/dsh/runtime-boot.mjs', 'homePatches');

for (const path of ['src/dsh/user-shell.mjs', 'src/dsh/workspace-command.mjs']) {
  forbidText(path, /execFile|execSync|spawn\(/, 'local process execution');
  requireText(path, 'tools.execute');
}
requireText('src/dsh/user-shell.mjs', 'agent: controller.agent');
requireText('src/dsh/workspace-command.mjs', 'agent');
requireText('src/dsh/release-adapter.mjs', "case 'command/exec'");

requireText('src/dsh/host-api.mjs', '@deepseek-ai/dsh-host-apiproxy');
requireText('src/dsh/host-api.mjs', 'api.sessions.fork');
requireText('src/dsh/product-adapter.mjs', 'executeDshCommand');
requireText('src/dsh/commands.mjs', 'commands.execute');
forbidText('src/dsh/product-adapter.mjs', 'compactNow');
for (const path of ['src/dsh/agent-driver.mjs', 'src/dsh/product-adapter.mjs']) {
  forbidText(path, /seedLength|parentSession|dshForkSeed/, 'shadow fork/session seed state');
}
forbidText('src/dsh/agent-driver.mjs', 'fork(sourceAgent');

forbidText('src/dsh/local-server.mjs', 'WebSocketServer', 'production TCP WebSocket server');
requireText('src/dsh/local-server.mjs', 'unix://');
requireText('scripts/build-codex-tui.sh', 'dshx-ipc-bridge');

console.log('DSHX ownership boundary verified');
