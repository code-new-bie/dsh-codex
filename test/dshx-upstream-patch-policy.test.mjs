import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const slashPatch = fs.readFileSync('upstream/patches/codex/0009-dshx-slash-capabilities.patch', 'utf8');
const stdioModePatch = fs.readFileSync('upstream/patches/codex/0011-dshx-stdio-mode-detection.patch', 'utf8');
const inheritedPipePatch = fs.readFileSync('upstream/patches/codex/0012-dshx-inherited-profile-pipe.patch', 'utf8');

function hiddenCapabilityBlock() {
  const start = slashPatch.indexOf('+        if crate::dshx_backend()');
  const end = slashPatch.indexOf('+            return false;', start);
  assert.notEqual(start, -1, 'DSHX slash hidden-capability block must exist');
  assert.notEqual(end, -1, 'DSHX slash hidden-capability block must terminate');
  return slashPatch.slice(start, end);
}

test('DSH-backed daily commands remain visible in the Codex thin fork', () => {
  const hidden = hiddenCapabilityBlock();
  for (const command of ['Diff', 'Fork', 'Compact', 'Agents']) {
    assert.equal(hidden.includes(`SlashCommand::${command}`), false);
  }
});

test('Codex-only runtime owners stay hidden from DSHX', () => {
  const hidden = hiddenCapabilityBlock();
  for (const command of ['AutoReview', 'Mcp', 'Plugins', 'Logout', 'MultiAgents']) {
    assert.equal(hidden.includes(`SlashCommand::${command}`), true);
  }
});

test('final DSHX mode detection follows the inherited profile fd, never a backend command or socket endpoint', () => {
  assert.equal(inheritedPipePatch.split('-    std::env::var_os("DSHX_APP_SERVER_CMD").is_some()').length - 1, 3);
  assert.equal(inheritedPipePatch.split('+    std::env::var_os("DSHX_APP_SERVER_FD").is_some()').length - 1, 3);
  assert.match(inheritedPipePatch, /DSHX_APP_SERVER_FD is required/);
  assert.doesNotMatch(inheritedPipePatch, /\+.*DSHX_APP_SERVER_ENDPOINT/);
});

test('DSH thread ownership is independent from Codex remote-workspace classification', () => {
  assert.equal(
    stdioModePatch.split('-    if crate::dshx_backend() && matches!(thread_params_mode, ThreadParamsMode::Remote) {').length - 1,
    3
  );
  assert.equal(stdioModePatch.split('+    if crate::dshx_backend() {').length - 1, 3);
});

test('the final transport patch removes TUI-owned backend spawning', () => {
  assert.match(inheritedPipePatch, /RemoteAppServerEndpoint::InheritedPipe/);
  assert.match(inheritedPipePatch, /inherited_protocol_file/);
  assert.match(inheritedPipePatch, /-        let mut command = Command::new\(executable\);/);
  assert.doesNotMatch(inheritedPipePatch, /\+.*Command::new\(executable\)/);
});
