import { existsSync, readFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function requireText(path, needle) {
  if (!read(path).includes(needle)) throw new Error(`${path} is missing required invariant: ${needle}`);
}
function forbidText(path, needle, label = needle) {
  if (read(path).includes(needle)) throw new Error(`${path} violates TUI invariant: ${label}`);
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
  'DSHX_APP_SERVER_INPUT_FD',
  'DSHX_TERMINAL_INPUT_FD',
  'DSHX_APP_SERVER_OUTPUT_FD',
  'RemoteAppServerEndpoint::InheritedPipes',
  'dshx_prepare_stdio',
  'Some(dshx_endpoint)',
  'DSHX_RESUME_MODE',
]) requireText(main, needle);
for (const legacy of ['DSHX_APP_SERVER_CMD', 'DSHX_APP_SERVER_ENDPOINT', 'DSHX_APP_SERVER_TOKEN', 'DSHX_APP_SERVER_FD']) {
  forbidText(main, legacy, `legacy backend transport ${legacy}`);
}
if (process.platform !== 'win32') requireText(main, 'O_NONBLOCK');
requireText(main, 'SetStdHandle');

for (const needle of [
  'pub struct StdioAppServerClient',
  'input_fd: i32',
  'output_fd: i32',
  'inherited_protocol_file',
  'JSONRPCMessage',
  'stdin.shutdown()',
]) requireText(stdio, needle);
forbidText(stdio, 'Command::new(', 'TUI must not spawn a DSH backend');
requireText(client, 'Stdio(StdioAppServerClient)');
requireText(lib, 'Some(endpoint @ RemoteAppServerEndpoint::InheritedPipes');
requireText(lib, 'AppServerTarget::LocalDaemon { endpoint }');

const legacyBridge = '.upstream/codex/codex-rs/stdio-to-uds/src/dshx_ipc_bridge.rs';
if (existsSync(legacyBridge)) throw new Error('legacy dshx-ipc-bridge must not be materialized');
if (existsSync('src/dsh/local-server.mjs')) throw new Error('legacy Node socket host must not ship');

for (const path of [approval, permissions, lib]) {
  requireText(path, 'fn dshx_backend');
  requireText(path, 'DSHX_APP_SERVER_INPUT_FD');
  for (const legacy of ['DSHX_APP_SERVER_CMD', 'DSHX_APP_SERVER_ENDPOINT', 'DSHX_APP_SERVER_FD']) {
    forbidText(path, legacy, `legacy DSHX mode detection ${legacy}`);
  }
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

requireText('bin/dshx.mjs', "'--profile', profile");
for (const legacy of [
  'DSHX_APP_SERVER_CMD', 'DSHX_APP_SERVER_FD', 'DSHX_APP_SERVER_INPUT_FD',
  'DSHX_APP_SERVER_OUTPUT_FD', 'DSHX_TERMINAL_INPUT_FD', 'DSHX_APP_SERVER_ENDPOINT'
]) forbidText('bin/dshx.mjs', legacy, `only the profile-owned presentation row may publish transport fact ${legacy}`);

requireText('src/dsh/presentation-plugin.mjs', "stdio: ['pipe', 'inherit', 'inherit', 0, 'pipe']");
for (const needle of ['DSHX_APP_SERVER_INPUT_FD', 'DSHX_TERMINAL_INPUT_FD', 'DSHX_APP_SERVER_OUTPUT_FD']) {
  requireText('src/dsh/presentation-plugin.mjs', needle);
}

const pkg = JSON.parse(read('package.json'));
if (pkg.dependencies?.ws) throw new Error('ws must not be a production dependency');

// Every native build gate also verifies the complete pinned slash-command
// classification. This script requires the materialized Codex tree, so keeping
// it behind the thin-fork build makes the release-readiness requirement real on
// Linux, Windows, macOS and tagged release matrices without duplicating workflow steps.
await import('./verify-slash-contract.mjs');

console.log('DSHX pinned TUI profile-owned directional pipe invariants verified');
