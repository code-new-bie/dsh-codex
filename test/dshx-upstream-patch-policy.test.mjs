import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const slashPatch = fs.readFileSync('upstream/patches/codex/0009-dshx-slash-capabilities.patch', 'utf8');

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
