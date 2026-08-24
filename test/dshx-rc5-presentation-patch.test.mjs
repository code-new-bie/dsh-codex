import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const patch = fs.readFileSync('upstream/patches/codex/0012-dshx-rc5-presentation-fixes.patch', 'utf8');

test('RC presentation patch resolves opaque model ids through model catalog display names', () => {
  for (const needle of [
    'display_name_for',
    'self.model_display_name().to_string()',
    'self.session_header.set_model(&model_display_name)',
    'if !crate::dshx_backend() && requested_model != session.model.as_str()'
  ]) {
    assert.match(patch, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('RC presentation patch uses the tag-derived DSHX_VERSION in DSHX surfaces', () => {
  const occurrences = patch.match(/option_env!\("DSHX_VERSION"\)/g) ?? [];
  assert.ok(occurrences.length >= 2, 'welcome header and status/footer must both use DSHX_VERSION');
  assert.match(patch, /unwrap_or\(CODEX_CLI_VERSION\)/);
});