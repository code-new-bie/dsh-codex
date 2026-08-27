import { existsSync, readFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function requireText(path, needle) {
  const text = read(path);
  if (!text.includes(needle)) throw new Error(`${path} is missing required invariant: ${needle}`);
}
function forbidText(path, needle, label = needle) {
  const text = read(path);
  if (text.includes(needle)) throw new Error(`${path} violates TUI invariant: ${label}`);
}

const main = '.upstream/codex/codex-rs/tui/src/main.rs';
const lib = '.upstream/codex/codex-rs/tui/src/lib.rs';
const client = '.upstream/codex/codex-rs/app-server-client/src/lib.rs';
const stdio = '.upstream/codex/codex-rs/app-server-client/src/stdio.rs';
const app = '.upstream/codex/codex-rs/tui/src/app.rs';
const session = '.upstream/codex/codex-rs/tui/src/app_server_session.rs';
const slash = '.upstream/codex/codex-rs/tui/src/slash_command.rs';
const startup = '.upstream/codex/codex-rs/tui/src/app/startup.rs';
const event = '.upstream/codex/codex-rs/tui/src/app/event_dispatch.rs';
const approval = '.upstream/codex/codex-rs/tui/src/bottom_pane/approval_overlay.rs';
const permissions = '.upstream/codex/codex-rs/tui/src/chatwidget/permission_popups.rs';

for (const needle of [
  'DSHX_APP_SERVER_CMD is required',
  'RemoteAppServerEndpoint::StdioChild',
  'Some(dshx_endpoint)',
  'DSHX_RESUME_MODE',
]) requireText(main, needle);
forbidText(main, 'DSHX_APP_SERVER_ENDPOINT', 'legacy socket endpoint transport');
forbidText(main, 'DSHX_APP_SERVER_TOKEN', 'legacy bearer-token transport');

for (const needle of [
  'pub struct StdioAppServerClient',
  'Command::new(executable)',
  'JSONRPCMessage',
  'stdin.shutdown()',
]) requireText(stdio, needle);
requireText(client, 'Stdio(StdioAppServerClient)');
requireText(lib, 'Some(endpoint @ RemoteAppServerEndpoint::StdioChild');
requireText(lib, 'AppServerTarget::LocalDaemon { endpoint }');

const legacyBridge = '.upstream/codex/codex-rs/stdio-to-uds/src/dshx_ipc_bridge.rs';
if (existsSync(legacyBridge)) throw new Error('legacy dshx-ipc-bridge must not be materialized');
if (existsSync('src/dsh/local-server.mjs')) throw new Error('legacy Node socket host must not ship');

for (const path of [approval, permissions, lib]) {
  requireText(path, 'fn dshx_backend');
  requireText(path, 'DSHX_APP_SERVER_CMD');
  forbidText(path, 'DSHX_APP_SERVER_ENDPOINT', 'legacy socket-mode DSHX detection');
}
requireText('.upstream/codex/codex-rs/tui/src/history_cell/session.rs', 'DeepSeek Harness');
requireText(lib, '!dshx_backend()');
requireText(startup, '!crate::dshx_backend()');
requireText(event, '!crate::dshx_backend()');
requireText(session, 'if crate::dshx_backend()');
forbidText(
  session,
  'dshx_backend() && matches!(thread_params_mode, ThreadParamsMode::Remote)',
  'DSHX thread ownership must not depend on remote-workspace classification'
);
requireText(app, 'dshx');
requireText(slash, 'if crate::dshx_backend()');
requireText(slash, 'DeepSeek Harness');

const slashText = read(slash);
const hiddenStart = slashText.indexOf('if crate::dshx_backend()');
const hiddenEnd = slashText.indexOf('return false;', hiddenStart);
if (hiddenStart < 0 || hiddenEnd < 0) throw new Error('DSHX slash hidden block not found');
if (slashText.slice(hiddenStart, hiddenEnd).includes('SlashCommand::Diff')) {
  throw new Error('/diff must remain visible in DSHX');
}

const pkg = JSON.parse(read('package.json'));
if (pkg.dependencies?.ws) throw new Error('ws must not be a production dependency');
console.log('DSHX pinned TUI stdio invariants verified');
