import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const slashPatch = fs.readFileSync('upstream/patches/codex/0009-dshx-slash-capabilities.patch', 'utf8');
const stdioModePatch = fs.readFileSync('upstream/patches/codex/0011-dshx-stdio-mode-detection.patch', 'utf8');

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
    assert.equal(
      hidden.includes(`SlashCommand::${command}`),
      false,
      `/${command.toLowerCase()} is DSH-backed and must not be hidden`
    );
  }
});

test('Codex-only runtime owners stay hidden from DSHX', () => {
  const hidden = hiddenCapabilityBlock();
  for (const command of ['AutoReview', 'Mcp', 'Plugins', 'Logout', 'MultiAgents']) {
    assert.equal(
      hidden.includes(`SlashCommand::${command}`),
      true,
      `/${command.toLowerCase()} must stay hidden until an equivalent DSH public seam is faithfully projected`
    );
  }
});

test('DSHX mode detection follows the stdio child command, never the removed socket endpoint', () => {
  const oldNeedle = '-    std::env::var_os("DSHX_APP_SERVER_ENDPOINT").is_some()';
  const newNeedle = '+    std::env::var_os("DSHX_APP_SERVER_CMD").is_some()';
  assert.equal(stdioModePatch.split(oldNeedle).length - 1, 3, 'all three legacy mode detectors must be replaced');
  assert.equal(stdioModePatch.split(newNeedle).length - 1, 3, 'all three DSHX mode detectors must follow the stdio command env');
});

test('DSH thread ownership is independent from Codex remote-workspace classification', () => {
  assert.equal(
    stdioModePatch.split('-    if crate::dshx_backend() && matches!(thread_params_mode, ThreadParamsMode::Remote) {').length - 1,
    3,
    'start/resume/fork must all remove the legacy Remote-mode gate'
  );
  assert.equal(
    stdioModePatch.split('+    if crate::dshx_backend() {').length - 1,
    3,
    'start/resume/fork must all remain DSH-owned while StdioChild is a LocalDaemon'
  );
});
