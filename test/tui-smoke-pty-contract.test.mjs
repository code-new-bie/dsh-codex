import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./tui_smoke.py', import.meta.url), 'utf8');

test('PTY smoke validates rendered prompt tokens instead of contiguous raw terminal bytes', () => {
  assert.match(source, /PROMPT_TOKENS\s*=\s*\(/);
  assert.match(source, /def expect_rendered_tokens\(/);
  assert.equal(source.includes('child.expect(PROMPT_TAIL)'), false);
  assert.equal(source.includes('child.expect(PROMPT)'), false);
  assert.equal(source.includes('child.expect_exact(PROMPT)'), false);
  assert.ok(
    source.split('expect_rendered_tokens(child, PROMPT_TOKENS)').length - 1 >= 2,
    'input and echoed-response prompt must both use cursor-addressing-safe token assertions'
  );
});
