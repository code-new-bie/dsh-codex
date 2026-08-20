import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowRoot = path.join(root, '.github', 'workflows');
const immutableAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s#]+)?@[0-9a-f]{40}$/;

test('every external GitHub Action is pinned to an immutable full commit SHA', () => {
  const failures = [];
  for (const entry of fs.readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = path.join(workflowRoot, entry.name);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
      if (!match) continue;
      const ref = match[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      if (!immutableAction.test(ref)) {
        failures.push(`${entry.name}:${index + 1}: ${ref}`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `External Actions must use owner/repo[/path]@<40-hex-sha>; mutable refs found:\n${failures.join('\n')}`
  );
});
