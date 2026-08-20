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

function forbidText(path, needle, label = needle) {
  const text = read(path);
  if (text.includes(needle)) {
    throw new Error(`${path} violates TUI invariant: ${label}`);
  }
}

const main = '.upstream/codex/codex-rs/tui/src/main.rs';
const lib = '.upstream/codex/codex-rs/tui/src/lib.rs';
const app = '.upstream/codex/codex-rs/tui/src/app.rs';
const session = '.upstream/codex/codex-rs/tui/src/app_server_session.rs';
const slash = '.upstream/codex/codex-rs/tui/src/slash_command.rs';
const startup = '.upstream/codex/codex-rs/tui/src/app/startup.rs';
const event = '.upstream/codex/codex-rs/tui/src/app/event_dispatch.rs';
const bridge = '.upstream/codex/codex-rs/stdio-to-uds/src/dshx_ipc_bridge.rs';

for (const needle of [
  'DSHX_APP_SERVER_ENDPOINT is required',
  'DSHX production launcher forbids TCP WebSocket transport',
  'RemoteAppServerEndpoint::UnixSocket',
  'Some(dshx_endpoint)',
  'DSHX_RESUME_MODE',
]) requireText(main, needle);
forbidText(main, 'DSHX_APP_SERVER_TOKEN', 'legacy TCP bearer-token transport');

for (const needle of ['UnixListener', 'UnixStream', 'dshxBridge']) requireText(bridge, needle);
requireText('.upstream/codex/codex-rs/tui/src/history_cell/session.rs', 'DeepSeek Harness');
requireText('.upstream/codex/codex-rs/tui/src/bottom_pane/approval_overlay.rs', 'fn dshx_backend');
requireText('.upstream/codex/codex-rs/tui/src/chatwidget/permission_popups.rs', 'fn dshx_backend');
requireText(lib, 'fn dshx_backend');
requireText(lib, '!dshx_backend()');
requireText(startup, '!crate::dshx_backend()');
requireText(event, '!crate::dshx_backend()');
requireText(session, 'ThreadParamsMode::Remote');
requireText(app, 'dshx');
requireText(slash, 'if crate::dshx_backend()');
requireText(slash, 'DeepSeek Harness');

forbidText('src/dsh/local-server.mjs', 'WebSocketServer', 'production TCP WebSocket server');
requireText('src/dsh/local-server.mjs', 'unix://');
requireText('scripts/package-platform.mjs', 'local-uds-via-stdio-bridge');

const pkg = JSON.parse(read('package.json'));
if (pkg.dependencies?.ws) throw new Error('ws must not be a production dependency');
if (!pkg.devDependencies?.ws) throw new Error('development protocol stub still requires ws');

const slashText = read(slash);
const hiddenStart = slashText.indexOf('if crate::dshx_backend()');
const hiddenEnd = slashText.indexOf('return false;', hiddenStart);
if (hiddenStart < 0 || hiddenEnd < 0) throw new Error('DSHX slash hidden block not found');
const hidden = slashText.slice(hiddenStart, hiddenEnd);
if (hidden.includes('SlashCommand::Diff')) {
  throw new Error('/diff must remain visible in DSHX now that command/exec is DSH-backed');
}

console.log('DSHX pinned TUI invariants verified');
