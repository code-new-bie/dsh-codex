import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliInvocation, parseLaunchArgs } from '../src/cli/arguments.mjs';

test('top-level help and version are recognized only as the sole argument', () => {
  assert.deepEqual(parseCliInvocation(['--help']), { kind: 'help' });
  assert.deepEqual(parseCliInvocation(['-h']), { kind: 'help' });
  assert.deepEqual(parseCliInvocation(['--version']), { kind: 'version' });
  assert.deepEqual(parseCliInvocation(['-V']), { kind: 'version' });

  assert.deepEqual(parseCliInvocation(['explain', '--version', 'behavior']), {
    kind: 'launch',
    tuiArgs: ['explain', '--version', 'behavior'],
    resumeEnv: {}
  });
  assert.deepEqual(parseCliInvocation(['explain', '--help', 'output']), {
    kind: 'launch',
    tuiArgs: ['explain', '--help', 'output'],
    resumeEnv: {}
  });
});

test('doctor is an exact top-level command and rejects trailing arguments', () => {
  assert.deepEqual(parseCliInvocation(['doctor']), { kind: 'doctor' });
  assert.throws(() => parseCliInvocation(['doctor', 'extra']), /Usage: dshx doctor/);
});

test('zero-argument launch and ordinary prompts pass through unchanged', () => {
  assert.deepEqual(parseCliInvocation([]), { kind: 'launch', tuiArgs: [], resumeEnv: {} });
  assert.deepEqual(parseCliInvocation(['hello', 'world']), {
    kind: 'launch',
    tuiArgs: ['hello', 'world'],
    resumeEnv: {}
  });
});

test('resume modes remain explicit and reject ambiguous option combinations', () => {
  assert.deepEqual(parseLaunchArgs(['resume']), {
    tuiArgs: [],
    resumeEnv: { DSHX_RESUME_MODE: 'picker' }
  });
  assert.deepEqual(parseLaunchArgs(['resume', '--last']), {
    tuiArgs: [],
    resumeEnv: { DSHX_RESUME_MODE: 'last' }
  });
  assert.deepEqual(parseLaunchArgs(['resume', 'session-123']), {
    tuiArgs: [],
    resumeEnv: { DSHX_RESUME_MODE: 'id', DSHX_RESUME_SESSION_ID: 'session-123' }
  });
  assert.throws(() => parseLaunchArgs(['resume', '--unknown']), /Usage: dshx resume/);
  assert.throws(() => parseLaunchArgs(['resume', 'a', 'b']), /Usage: dshx resume/);
});
